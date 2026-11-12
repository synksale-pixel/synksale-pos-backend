/**
 * Purpose: Goods Receipt Service.
 * Posting goods receipts (against a purchase order or without one), and reading them.
 *
 * A receipt is posted in one transaction (the caller's, see idempotency.service), all or nothing:
 * the receipt and its number, a `purchase` movement per stocked line (stockLedger), the PO's
 * received quantities and status, the variants' last purchase cost, and, without a PO, the
 * vendor's document count.
 *
 * Concurrency: no PO version is sent. The PO is read inside the transaction and written back on
 * `{ _id, version }`; two receipts of the same PO both write it, so MongoDB aborts one with a
 * transient write conflict and the transaction runs again with fresh reads (as the ledger does for
 * stock levels). A PO edited since the screen loaded has new line ids: PURCHASE_ORDER_CHANGED.
 *
 * Money is in minor units and quantities in thousandths, as in the stock ledger.
 */

import mongoose from "mongoose";
import { GoodsReceipt, GoodsReceiptDocument, IGoodsReceiptLine } from "../models/goodsReceipt.model";
import { PurchaseOrder, PurchaseOrderDocument, IPurchaseOrderLine, IPurchaseOrderVendorSnapshot } from "../models/purchaseOrder.model";
import { DocumentCounter } from "../models/documentCounter.model";
import { Vendor, VendorDocument } from "../models/vendor.model";
import { Product, ProductDocument } from "../models/product.model";
import { ProductVariant, ProductVariantDocument, variantDisplayName } from "../models/productVariant.model";
import { Organization } from "../models/organization.model";
import { IUser } from "../models/user.model";
import { ApiError, ApiErrorDetail } from "../utils/ApiError";
import { applyRate, formatMoney, multiplyMoney, parseMoney, sumMoney } from "../utils/money";
import { fromMilli, toMilli } from "../utils/quantity";
import { resolvePaging, buildPaginationMeta } from "../utils/pagination";
import { logger } from "../config/logger.config";
import { getCurrency } from "../config/currencies.config";
import { unitAllowsDecimal } from "../config/units.config";
import { storesWithPermission } from "./permission.service";
import { catalogRefs, storeRefs, userRefs, CatalogRefs, StoreRef, UserRef } from "./stock.service";
import { applyMovement, readLevel } from "./stockLedger.service";
import { lineTax, storeToday, taxRatesFor, toPurchaseOrderDetail } from "./purchaseOrder.service";
import { isCalendarDate, PurchaseOrderStatus } from "../validators/purchaseOrder.validator";
import { CreateGoodsReceiptInput } from "../validators/goodsReceipt.validator";

type ObjectId = mongoose.Types.ObjectId;
const oid = (id: string | ObjectId) => new mongoose.Types.ObjectId(String(id));

const RECEIVABLE_STATUSES: PurchaseOrderStatus[] = ["issued", "partially_received"];

const anyState = { $in: [true, false] };

// ==========================================
// Settings
// ==========================================

interface ReceiptSettings {
  decimals: number;
  /** No TRN: input VAT cannot be reclaimed, so it goes into the stock cost. */
  vatInCost: boolean;
}

async function receiptSettings(organizationId: string): Promise<ReceiptSettings> {
  const organization = await Organization.findById(organizationId).select("settings.currency taxRegistrationNumber");
  if (!organization) {
    throw ApiError.coded(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
  }
  return {
    decimals: getCurrency(organization.settings.currency).decimals,
    vatInCost: !organization.taxRegistrationNumber,
  };
}

// ==========================================
// Errors
// ==========================================

function validationError(field: string, message: string): ApiError {
  return ApiError.coded(400, "VALIDATION_FAILED", `Request Validation Failed: ${field}: ${message}`, [
    { field, code: "VALIDATION_FAILED", message },
  ]);
}

/** Many errors at once (one per line), coded and worded after the first. */
function collected(status: number, errors: ApiErrorDetail[]): ApiError {
  return ApiError.coded(status, errors[0].code!, errors[0].message!, errors);
}

function orderPermissionDenied(field: string): ApiError {
  return new ApiError(403, "Access Denied: You do not possess the required permission (purchase:order) to execute this action.", [
    { field, code: "FORBIDDEN", message: "Receiving without a purchase order, or at a different cost, needs purchase:order." },
  ]);
}

function vendorError(code: "VENDOR_NOT_FOUND" | "VENDOR_INACTIVE"): ApiError {
  const message =
    code === "VENDOR_NOT_FOUND" ? "Vendor not found." : "This vendor is deactivated. Activate it or choose another vendor.";
  return ApiError.coded(400, code, message, [{ field: "vendorId", code }]);
}

/** A unitCost that does not fit the currency, as a line error. */
function parseLineCost(text: string, decimals: number, index: number, errors: ApiErrorDetail[]): number | undefined {
  const field = `lines[${index}].unitCost`;
  try {
    return parseMoney(text, decimals, field);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const detail = (error.errors[0] ?? {}) as ApiErrorDetail;
    errors.push({ ...detail, field, code: error.code, message: error.message });
    return undefined;
  }
}

function wholeUnitError(index: number, unit: string): ApiErrorDetail {
  const message = `Unit '${unit}' only allows whole quantities.`;
  return {
    field: `lines[${index}].quantity`,
    code: "VALIDATION_FAILED",
    message: `Request Validation Failed: lines[${index}].quantity: ${message}`,
  };
}

// ==========================================
// Lines
// ==========================================

/** One line, resolved and priced, before anything is written. */
interface PlannedLine {
  purchaseOrderLine: IPurchaseOrderLine | null;
  variant: ProductVariantDocument;
  product: ProductDocument;
  quantityMilli: number;
  unitCostMinor: number;
  /** Percent of input VAT added to the stock cost (organizations with no TRN), or null. */
  costVatRate: number | null;
  note: string | null;
}

async function loadCatalog(organizationId: string, variantIds: ObjectId[]) {
  // Inactive products and variants can still be received; deleted ones are not found.
  const variants = await ProductVariant.find({ organizationId, _id: { $in: variantIds } });
  const products = await Product.find({ organizationId, _id: { $in: variants.map((variant) => variant.productId) } });
  const productById = new Map(products.map((product) => [product._id.toString(), product]));
  const byVariant = new Map<string, { variant: ProductVariantDocument; product: ProductDocument }>();
  for (const variant of variants) {
    const product = productById.get(variant.productId.toString());
    if (product) byVariant.set(variant._id.toString(), { variant, product });
  }
  return { byVariant, products };
}

/**
 * Lines against a PO. Checked in this order, each step refusing every bad line at once:
 * a line no longer on the PO (409), unit costs and whole units (400), a cost change without
 * purchase:order (403), then quantities above what is left to receive (409).
 */
async function planPurchaseOrderLines(
  organizationId: string,
  po: PurchaseOrderDocument,
  input: CreateGoodsReceiptInput,
  settings: ReceiptSettings,
  canOrder: boolean
): Promise<PlannedLine[]> {
  const poLineById = new Map(po.lines.map((line) => [line._id.toString(), line]));

  const changed: ApiErrorDetail[] = [];
  const poLines = input.lines.map((line, index) => {
    const poLine = poLineById.get(line.purchaseOrderLineId!.toLowerCase());
    if (!poLine) {
      changed.push({
        field: `lines[${index}].purchaseOrderLineId`,
        code: "PURCHASE_ORDER_CHANGED",
        message: "This purchase order was changed since it was loaded. Reload it and enter the receipt again.",
      });
    }
    return poLine!;
  });
  if (changed.length > 0) throw collected(409, changed);

  const { byVariant } = await loadCatalog(
    organizationId,
    poLines.map((line) => line.variantId)
  );

  const errors: ApiErrorDetail[] = [];
  const costs = input.lines.map((line, index) => {
    const poLine = poLines[index];
    const entry = byVariant.get(poLine.variantId.toString());
    if (!entry) {
      errors.push({ field: `lines[${index}].purchaseOrderLineId`, code: "VARIANT_NOT_FOUND", message: "This line's variant no longer exists." });
      return undefined;
    }
    // The unit may have changed to a whole-number one since the PO was issued.
    if (!unitAllowsDecimal(entry.product.unit) && toMilli(line.quantity) % 1000 !== 0) {
      errors.push(wholeUnitError(index, entry.product.unit));
    }
    return line.unitCost === undefined ? poLine.unitCostMinor : parseLineCost(line.unitCost, settings.decimals, index, errors);
  });
  if (errors.length > 0) throw collected(400, errors);

  if (!canOrder) {
    const index = costs.findIndex((cost, i) => cost !== poLines[i].unitCostMinor);
    if (index >= 0) throw orderPermissionDenied(`lines[${index}].unitCost`);
  }

  const exceeded: ApiErrorDetail[] = [];
  input.lines.forEach((line, index) => {
    const poLine = poLines[index];
    const remainingMilli = poLine.quantityMilli - poLine.receivedQuantityMilli;
    if (toMilli(line.quantity) > remainingMilli) {
      const name = variantDisplayName(byVariant.get(poLine.variantId.toString())!.product, byVariant.get(poLine.variantId.toString())!.variant.attributeValues);
      exceeded.push({
        field: `lines[${index}].quantity`,
        code: "RECEIVED_QUANTITY_EXCEEDS_ORDERED",
        message: `More than was ordered would be received for '${name}': ${fromMilli(remainingMilli)} left to receive.`,
        meta: {
          ordered: fromMilli(poLine.quantityMilli),
          received: fromMilli(poLine.receivedQuantityMilli),
          remaining: fromMilli(remainingMilli),
        },
      });
    }
  });
  if (exceeded.length > 0) throw collected(409, exceeded);

  return input.lines.map((line, index) => {
    const poLine = poLines[index];
    const { variant, product } = byVariant.get(poLine.variantId.toString())!;
    return {
      purchaseOrderLine: poLine,
      variant,
      product,
      quantityMilli: toMilli(line.quantity),
      unitCostMinor: costs[index]!,
      // The rate the PO estimated with (null when no VAT applies to this line).
      costVatRate: settings.vatInCost && poLine.taxRate ? poLine.taxRate.rate : null,
      note: line.note ?? null,
    };
  });
}

/** Lines without a PO: goods only, a unit cost on every line. */
async function planDirectLines(
  organizationId: string,
  input: CreateGoodsReceiptInput,
  vendor: VendorDocument,
  settings: ReceiptSettings
): Promise<PlannedLine[]> {
  const { byVariant, products } = await loadCatalog(
    organizationId,
    input.lines.map((line) => oid(line.variantId!))
  );
  const rates = settings.vatInCost ? await taxRatesFor(organizationId, products) : null;

  const errors: ApiErrorDetail[] = [];
  const planned: PlannedLine[] = [];
  input.lines.forEach((line, index) => {
    const entry = byVariant.get(line.variantId!.toLowerCase());
    const field = `lines[${index}].variantId`;
    if (!entry) {
      errors.push({ field, code: "VARIANT_NOT_FOUND", message: `Variant '${line.variantId}' not found.` });
      return;
    }
    const { variant, product } = entry;
    if (product.type !== "goods") {
      errors.push({
        field,
        code: "VARIANT_NOT_PURCHASABLE",
        message: `'${variantDisplayName(product, variant.attributeValues)}' is a service. Services go on vendor bills, not goods receipts.`,
      });
      return;
    }
    if (!unitAllowsDecimal(product.unit) && toMilli(line.quantity) % 1000 !== 0) {
      errors.push(wholeUnitError(index, product.unit));
      return;
    }
    const unitCostMinor = parseLineCost(line.unitCost!, settings.decimals, index, errors);
    if (unitCostMinor === undefined) return;
    const tax = rates ? lineTax(product, vendor.vatTreatment, rates) : null;
    planned.push({
      purchaseOrderLine: null,
      variant,
      product,
      quantityMilli: toMilli(line.quantity),
      unitCostMinor,
      costVatRate: tax?.taxRate ? tax.taxRate.rate : null,
      note: line.note ?? null,
    });
  });
  if (errors.length > 0) throw collected(400, errors);
  return planned;
}

// ==========================================
// Views
// ==========================================

interface ViewContext {
  decimals: number;
  stores: Map<string, StoreRef>;
  users: Map<string, UserRef>;
  vendors: Map<string, VendorDocument>;
  catalog: CatalogRefs | null;
}

async function viewContext(organizationId: string, receipts: GoodsReceiptDocument[], withLines: boolean, decimals?: number): Promise<ViewContext> {
  const lines = withLines ? receipts.flatMap((receipt) => receipt.lines) : [];
  const [resolvedDecimals, stores, users, vendors, catalog] = await Promise.all([
    decimals ?? receiptSettings(organizationId).then((settings) => settings.decimals),
    storeRefs(organizationId, receipts.map((receipt) => receipt.storeId)),
    userRefs(organizationId, receipts.map((receipt) => receipt.createdBy)),
    receipts.length
      ? Vendor.find({ organizationId, _id: { $in: receipts.map((receipt) => receipt.vendorId) }, isDelete: anyState })
      : Promise.resolve([] as VendorDocument[]),
    withLines
      ? catalogRefs(
          organizationId,
          lines.map((line) => line.variantId),
          lines.map((line) => line.productId)
        )
      : Promise.resolve(null),
  ]);
  return {
    decimals: resolvedDecimals,
    stores,
    users,
    vendors: new Map(vendors.map((vendor) => [vendor._id.toString(), vendor])),
    catalog,
  };
}

function coreView(ctx: ViewContext, receipt: GoodsReceiptDocument) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  const vendor = ctx.vendors.get(receipt.vendorId.toString());
  const snapshot = receipt.vendorSnapshot;
  return {
    id: receipt._id,
    number: receipt.number,
    store: ctx.stores.get(receipt.storeId.toString()) ?? { id: receipt.storeId, name: "(unknown)", code: "" },
    vendor: {
      id: receipt.vendorId,
      name: snapshot.name,
      legalName: snapshot.legalName ?? null,
      taxRegistrationNumber: snapshot.taxRegistrationNumber ?? null,
      vatTreatment: snapshot.vatTreatment,
      isActive: Boolean(vendor && vendor.isActive && !vendor.isDelete),
    },
    purchaseOrder: receipt.purchaseOrderId ? { id: receipt.purchaseOrderId, number: receipt.purchaseOrderNumber ?? "" } : null,
    receivedDate: receipt.receivedDate,
    vendorReference: receipt.vendorReference ?? null,
    subtotal: money(receipt.subtotalMinor),
    stockValue: money(receipt.stockValueMinor),
    createdBy: ctx.users.get(receipt.createdBy.toString()) ?? { id: receipt.createdBy, name: "(unknown)" },
    createdAt: receipt.createdAt,
  };
}

function summaryView(ctx: ViewContext, receipt: GoodsReceiptDocument) {
  return { ...coreView(ctx, receipt), lineCount: receipt.lines.length };
}

function detailView(ctx: ViewContext, receipt: GoodsReceiptDocument) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  const catalog = ctx.catalog!;
  return {
    ...coreView(ctx, receipt),
    notes: receipt.notes ?? null,
    lines: receipt.lines.map((line) => ({
      id: line._id,
      purchaseOrderLineId: line.purchaseOrderLineId ?? null,
      variant: catalog.variant(line.variantId),
      product: catalog.product(line.productId),
      quantity: fromMilli(line.quantityMilli),
      unitCost: money(line.unitCostMinor),
      subtotal: money(line.subtotalMinor),
      stockUnitCost: money(line.stockUnitCostMinor),
      stockValue: money(line.stockValueMinor),
      stocked: line.stocked,
      quantityAfter: line.quantityAfterMilli === null || line.quantityAfterMilli === undefined ? null : fromMilli(line.quantityAfterMilli),
      note: line.note ?? null,
    })),
  };
}

// ==========================================
// Reads
// ==========================================

export interface ListGoodsReceiptsQuery {
  search?: string;
  storeId?: string;
  vendorId?: string;
  purchaseOrderId?: string;
  withoutPurchaseOrder?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Lists receipts, newest number first. `storeId` (from the URL) limits it to one store; without
 * it, `user` narrows it to the stores where they hold purchase:read (all for an organization role).
 * Filters are lenient: a value that cannot match returns nothing, an invalid date is ignored.
 */
export async function listGoodsReceipts(
  organizationId: string,
  scope: { storeId: string } | { user: IUser },
  query: ListGoodsReceiptsQuery
) {
  const { page, limit, skip } = resolvePaging(query);
  const empty = () => ({ goodsReceipts: [], pagination: buildPaginationMeta(page, limit, 0) });
  const conditions: Record<string, unknown>[] = [{ organizationId }];

  if ("storeId" in scope) {
    conditions.push({ storeId: oid(scope.storeId) });
  } else {
    const stores = await storesWithPermission(scope.user, "purchase:read");
    if (stores !== "all") conditions.push({ storeId: { $in: [...stores].map(oid) } });
    if (query.storeId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(query.storeId)) return empty();
      conditions.push({ storeId: oid(query.storeId) });
    }
  }

  for (const field of ["vendorId", "purchaseOrderId"] as const) {
    const value = query[field];
    if (value === undefined) continue;
    if (!mongoose.Types.ObjectId.isValid(value)) return empty();
    conditions.push({ [field]: oid(value) });
  }
  if (query.withoutPurchaseOrder === "true") conditions.push({ purchaseOrderId: null });

  const from = query.from?.trim();
  const to = query.to?.trim();
  if (from && isCalendarDate(from)) conditions.push({ receivedDate: { $gte: from } });
  if (to && isCalendarDate(to)) conditions.push({ receivedDate: { $lte: to } });

  // A NUL byte makes MongoDB reject the regex (500); no receipt text can contain one.
  const term = query.search?.replace(/\0/g, "").trim();
  if (term) {
    const upper = term.toUpperCase();
    // "G", "GRN" and "GRN-" are the start of every number: typing the prefix must not hide them.
    const numberPrefix = "GRN-".startsWith(upper) ? "GRN-" : upper.startsWith("GRN-") ? upper : `GRN-${upper}`;
    conditions.push({
      $or: [
        { number: { $regex: `^${escapeRegex(numberPrefix)}` } },
        { vendorReference: { $regex: `^${escapeRegex(term)}`, $options: "i" } },
      ],
    });
  }

  const filter = { $and: conditions };
  const [total, receipts] = await Promise.all([
    GoodsReceipt.countDocuments(filter),
    GoodsReceipt.find(filter).sort({ sequence: -1 }).skip(skip).limit(limit),
  ]);
  const ctx = await viewContext(organizationId, receipts, false);
  return {
    goodsReceipts: receipts.map((receipt) => summaryView(ctx, receipt)),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

export async function getGoodsReceipt(organizationId: string, storeId: string, goodsReceiptId: string) {
  const receipt = await GoodsReceipt.findOne({ _id: goodsReceiptId, organizationId, storeId });
  if (!receipt) throw ApiError.coded(404, "GOODS_RECEIPT_NOT_FOUND", "Goods receipt not found.");
  const ctx = await viewContext(organizationId, [receipt], true);
  return { goodsReceipt: detailView(ctx, receipt), purchaseOrder: null };
}

// ==========================================
// Posting
// ==========================================

async function loadReceivablePurchaseOrder(organizationId: string, storeId: string, purchaseOrderId: string, session: mongoose.ClientSession) {
  const po = await PurchaseOrder.findOne({ _id: oid(purchaseOrderId), organizationId, storeId }).session(session);
  if (!po) {
    throw ApiError.coded(404, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found.", [
      { field: "purchaseOrderId", code: "PURCHASE_ORDER_NOT_FOUND" },
    ]);
  }
  if (!RECEIVABLE_STATUSES.includes(po.status)) {
    throw ApiError.coded(
      409,
      "PURCHASE_ORDER_STATUS_CONFLICT",
      `This purchase order is ${po.status.replace("_", " ")}, so it cannot be received.`,
      [{ field: "purchaseOrderId", code: "PURCHASE_ORDER_STATUS_CONFLICT", meta: { status: po.status, allowed: RECEIVABLE_STATUSES } }]
    );
  }
  return po;
}

/**
 * An active vendor for a receipt without a PO. Incrementing its document count makes it
 * undeletable, and conflicts with a delete running at the same moment (see vendor.service).
 */
async function claimVendor(organizationId: string, vendorId: string, session: mongoose.ClientSession): Promise<VendorDocument> {
  const vendor = await Vendor.findOneAndUpdate(
    { _id: oid(vendorId), organizationId, isActive: true },
    { $inc: { purchaseDocumentCount: 1 } },
    { new: true, session }
  );
  if (vendor) return vendor;
  const existing = await Vendor.findOne({ _id: oid(vendorId), organizationId }).select("_id").session(session);
  throw vendorError(existing ? "VENDOR_INACTIVE" : "VENDOR_NOT_FOUND");
}

/** Adds the received quantities to the PO and moves its status on, if it is still as read. */
async function recordOnPurchaseOrder(
  po: PurchaseOrderDocument,
  planned: PlannedLine[],
  session: mongoose.ClientSession
): Promise<PurchaseOrderDocument> {
  const receivedByLine = new Map(planned.map((line) => [line.purchaseOrderLine!._id.toString(), line.quantityMilli]));
  const complete = po.lines.every(
    (line) => line.receivedQuantityMilli + (receivedByLine.get(line._id.toString()) ?? 0) >= line.quantityMilli
  );
  const inc: Record<string, number> = { version: 1 };
  const arrayFilters = planned.map((line, index) => {
    inc[`lines.$[l${index}].receivedQuantityMilli`] = line.quantityMilli;
    return { [`l${index}._id`]: line.purchaseOrderLine!._id };
  });

  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: po._id, organizationId: po.organizationId, storeId: po.storeId, version: po.version, status: po.status },
    { $set: { status: complete ? "received" : "partially_received" }, $inc: inc },
    { new: true, session, arrayFilters }
  );
  if (!updated) {
    // The read and this write share the transaction's snapshot, so a concurrent change normally
    // aborts with a retried write conflict before reaching here.
    throw ApiError.coded(409, "PURCHASE_ORDER_CHANGED", "This purchase order was changed while receiving. Reload it and try again.", [
      { field: "purchaseOrderId", code: "PURCHASE_ORDER_CHANGED" },
    ]);
  }
  return updated;
}

/**
 * Posts a goods receipt in the store. Runs inside the caller's transaction (see
 * idempotency.service). `canOrder` is whether the caller holds purchase:order for this store:
 * needed to receive without a PO or at a cost other than the PO line's.
 */
export async function createGoodsReceipt(
  organizationId: string,
  storeId: string,
  input: CreateGoodsReceiptInput,
  actorUserId: string,
  session: mongoose.ClientSession,
  canOrder: boolean
) {
  const againstPo = input.purchaseOrderId !== undefined;
  if (!againstPo && !canOrder) throw orderPermissionDenied("vendorId");

  const settings = await receiptSettings(organizationId);
  const today = await storeToday(organizationId, storeId);
  const receivedDate = input.receivedDate ?? today;
  if (receivedDate > today) throw validationError("receivedDate", "receivedDate cannot be in the future.");

  let po: PurchaseOrderDocument | null = null;
  let vendorId: ObjectId;
  let vendorSnapshot: IPurchaseOrderVendorSnapshot;
  let planned: PlannedLine[];

  if (againstPo) {
    po = await loadReceivablePurchaseOrder(organizationId, storeId, input.purchaseOrderId!, session);
    if (receivedDate < po.orderDate) {
      throw validationError("receivedDate", `receivedDate cannot be before the purchase order's orderDate (${po.orderDate}).`);
    }
    planned = await planPurchaseOrderLines(organizationId, po, input, settings, canOrder);
    vendorId = po.vendorId;
    // Issued POs always carry the copy taken at issue.
    vendorSnapshot = po.vendorSnapshot!;
  } else {
    const vendor = await claimVendor(organizationId, input.vendorId!, session);
    planned = await planDirectLines(organizationId, input, vendor, settings);
    vendorId = vendor._id;
    vendorSnapshot = {
      name: vendor.name,
      legalName: vendor.legalName ?? null,
      taxRegistrationNumber: vendor.taxRegistrationNumber ?? null,
      vatTreatment: vendor.vatTreatment,
    };
  }

  const orgId = oid(organizationId);
  const store = oid(storeId);
  const actor = oid(actorUserId);
  const counter = await DocumentCounter.findOneAndUpdate(
    { organizationId: orgId, type: "goods_receipt" },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );
  const sequence = counter!.seq;
  const number = `GRN-${String(sequence).padStart(5, "0")}`;
  const receiptId = new mongoose.Types.ObjectId();
  const at = new Date();

  const lines: IGoodsReceiptLine[] = [];
  for (const line of planned) {
    const subtotalMinor = multiplyMoney(line.unitCostMinor, fromMilli(line.quantityMilli));
    const stockUnitCostMinor =
      line.costVatRate === null ? line.unitCostMinor : line.unitCostMinor + applyRate(line.unitCostMinor, line.costVatRate);
    const stockValueMinor = multiplyMoney(stockUnitCostMinor, fromMilli(line.quantityMilli));
    const stocked = line.product.type === "goods" && line.product.inventory.trackInventory;

    let quantityAfterMilli: number | null = null;
    if (stocked) {
      // Receiving always adds stock, whatever allowNegativeStock says.
      const applied = await applyMovement(session, {
        organizationId: orgId,
        storeId: store,
        variantId: line.variant._id,
        productId: line.product._id,
        type: "purchase",
        before: await readLevel(session, orgId, store, line.variant._id),
        quantityMilli: line.quantityMilli,
        unitCostMinor: stockUnitCostMinor,
        totalValueMinor: stockValueMinor,
        source: { type: "goods_receipt", id: receiptId, number },
        note: line.note,
        createdBy: actor,
        at,
      });
      quantityAfterMilli = applied.after.quantityMilli;
    }

    lines.push({
      _id: new mongoose.Types.ObjectId(),
      purchaseOrderLineId: line.purchaseOrderLine?._id ?? null,
      variantId: line.variant._id,
      productId: line.product._id,
      quantityMilli: line.quantityMilli,
      unitCostMinor: line.unitCostMinor,
      subtotalMinor,
      stockUnitCostMinor,
      stockValueMinor,
      stocked,
      quantityAfterMilli,
      note: line.note,
    });
  }

  const updatedPo = po ? await recordOnPurchaseOrder(po, planned, session) : null;

  const [receipt] = await GoodsReceipt.create(
    [
      {
        _id: receiptId,
        organizationId: orgId,
        storeId: store,
        number,
        sequence,
        purchaseOrderId: po?._id ?? null,
        purchaseOrderNumber: po?.number ?? null,
        vendorId,
        vendorSnapshot,
        receivedDate,
        vendorReference: input.vendorReference ?? null,
        notes: input.notes ?? null,
        lines,
        subtotalMinor: sumMoney(lines.map((line) => line.subtotalMinor)),
        stockValueMinor: sumMoney(lines.map((line) => line.stockValueMinor)),
        createdBy: actor,
        createdAt: at,
      },
    ],
    { session }
  );

  // The last purchase cost: this receipt is the newest posted for each of its variants.
  for (const line of lines) {
    await ProductVariant.updateOne(
      { _id: line.variantId, organizationId: orgId, isDelete: anyState },
      {
        $set: {
          lastPurchase: {
            unitCostMinor: line.unitCostMinor,
            receivedDate,
            vendorId,
            vendorName: vendorSnapshot.name,
            goodsReceiptId: receiptId,
            goodsReceiptNumber: number,
            postedAt: at,
          },
        },
      },
      { session }
    );
  }

  logger.info(
    `Goods received: ${number} (${receiptId}) store=${storeId} org=${organizationId}${po ? ` po=${po.number}` : ""} by user=${actorUserId}`
  );

  const ctx = await viewContext(organizationId, [receipt], true, settings.decimals);
  return {
    goodsReceipt: detailView(ctx, receipt),
    purchaseOrder: updatedPo ? await toPurchaseOrderDetail(organizationId, updatedPo, settings.decimals) : null,
  };
}
