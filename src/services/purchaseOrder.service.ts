/**
 * Purpose: Purchase Order Service.
 * Drafts, edits, issue, cancel, close and delete of purchase orders, the lists, and the open-PO
 * check the catalog needs before deleting a product or variant.
 *
 * Concurrency: every change to an existing PO is one conditional write on
 * `{ _id, version, status }`, so a stale screen can never overwrite a newer PO. When the write
 * matches nothing the PO is read again to say why, version first: a stale screen always gets
 * PURCHASE_ORDER_VERSION_CONFLICT, never a decision based on old data.
 *
 * Vendors: creating a PO increments the vendor's `purchaseDocumentCount` and deleting a draft
 * decrements it, inside the same transaction as the PO write. Vendor delete requires 0, so a
 * PO can never attach to a vendor being deleted (see vendor.service deleteVendor).
 *
 * Money is stored in minor units and quantities in thousandths, as in the stock ledger.
 */

import mongoose from "mongoose";
import { PurchaseOrder, PurchaseOrderDocument, IPurchaseOrderLine, IPurchaseOrderLineTax } from "../models/purchaseOrder.model";
import { DocumentCounter } from "../models/documentCounter.model";
import { Vendor, VendorDocument, VatTreatment } from "../models/vendor.model";
import { Product, ProductDocument } from "../models/product.model";
import { ProductVariant, ProductVariantDocument, variantDisplayName } from "../models/productVariant.model";
import { Store } from "../models/store.model";
import { Organization } from "../models/organization.model";
import { TaxRate, TaxRateDocument } from "../models/taxRate.model";
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
import { runStockTransaction } from "./stockLedger.service";
import {
  OPEN_PURCHASE_ORDER_STATUSES,
  PURCHASE_ORDER_STATUSES,
  PurchaseOrderStatus,
  isCalendarDate,
  CreatePurchaseOrderInput,
  UpdatePurchaseOrderInput,
  CancelPurchaseOrderInput,
  ClosePurchaseOrderInput,
} from "../validators/purchaseOrder.validator";

type ObjectId = mongoose.Types.ObjectId;
const oid = (id: string | ObjectId) => new mongoose.Types.ObjectId(String(id));

/** Drafts, and issued POs with nothing received (receiving moves a PO to partially_received). */
const EDITABLE_STATUSES: PurchaseOrderStatus[] = ["draft", "issued"];

const anyState = { $in: [true, false] };

// ==========================================
// Settings
// ==========================================

async function currencyDecimals(organizationId: string): Promise<number> {
  const organization = await Organization.findById(organizationId).select("settings.currency");
  if (!organization) {
    throw ApiError.coded(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
  }
  return getCurrency(organization.settings.currency).decimals;
}

/** Today's calendar date (YYYY-MM-DD) in a timezone; UTC if the zone is unknown. */
export function todayIn(timeZone: string, now = new Date()): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

async function storeToday(organizationId: string, storeId: string): Promise<string> {
  const store = await Store.findOne({ _id: storeId, organizationId }).select("timezone");
  return todayIn(store?.timezone || "UTC");
}

// ==========================================
// Errors
// ==========================================

function validationError(field: string, message: string): ApiError {
  return ApiError.coded(400, "VALIDATION_FAILED", `Request Validation Failed: ${field}: ${message}`, [
    { field, code: "VALIDATION_FAILED", message },
  ]);
}

function notFound(): ApiError {
  return ApiError.coded(404, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found.");
}

function versionConflict(currentVersion: number): ApiError {
  return ApiError.coded(
    409,
    "PURCHASE_ORDER_VERSION_CONFLICT",
    "This purchase order was changed by someone else. Reload it and try again.",
    [{ field: "version", code: "PURCHASE_ORDER_VERSION_CONFLICT", meta: { currentVersion } }]
  );
}

function statusConflict(status: PurchaseOrderStatus, allowed: PurchaseOrderStatus[], action: string): ApiError {
  return ApiError.coded(
    409,
    "PURCHASE_ORDER_STATUS_CONFLICT",
    `This purchase order is ${status.replace("_", " ")}, so it cannot be ${action}.`,
    [{ code: "PURCHASE_ORDER_STATUS_CONFLICT", meta: { status, allowed } }]
  );
}

function vendorError(code: "VENDOR_NOT_FOUND" | "VENDOR_INACTIVE"): ApiError {
  const message =
    code === "VENDOR_NOT_FOUND" ? "Vendor not found." : "This vendor is deactivated. Activate it or choose another vendor.";
  return ApiError.coded(400, code, message, [{ field: "vendorId", code }]);
}

/** One 400 for every line problem found, coded after the first. */
function lineErrors(errors: ApiErrorDetail[]): ApiError {
  return ApiError.coded(400, errors[0].code!, errors[0].message!, errors);
}

// ==========================================
// Loading and conditional writes
// ==========================================

async function findPurchaseOrderOrThrow(organizationId: string, storeId: string, purchaseOrderId: string, session?: mongoose.ClientSession) {
  const po = await PurchaseOrder.findOne({ _id: purchaseOrderId, organizationId, storeId }).session(session ?? null);
  if (!po) throw notFound();
  return po;
}

/** Checks the caller's version, then the status, against a PO read before the write. */
function assertCanChange(po: PurchaseOrderDocument, version: number, allowed: PurchaseOrderStatus[], action: string) {
  if (po.version !== version) throw versionConflict(po.version);
  if (!allowed.includes(po.status)) throw statusConflict(po.status, allowed, action);
}

/**
 * Applies `update` only if the PO still has the version the caller loaded and an allowed status.
 * When nothing matches (someone changed it meanwhile), reads it again and throws the reason.
 */
async function conditionalUpdate(
  organizationId: string,
  storeId: string,
  purchaseOrderId: string,
  version: number,
  allowed: PurchaseOrderStatus[],
  action: string,
  update: { $set: Record<string, unknown>; extraFilter?: Record<string, unknown> },
  session: mongoose.ClientSession | null
): Promise<PurchaseOrderDocument> {
  const updated = await PurchaseOrder.findOneAndUpdate(
    { _id: purchaseOrderId, organizationId, storeId, version, status: { $in: allowed }, ...update.extraFilter },
    { $set: update.$set, $inc: { version: 1 } },
    { new: true, session }
  );
  if (updated) return updated;
  const current = await findPurchaseOrderOrThrow(organizationId, storeId, purchaseOrderId, session ?? undefined);
  assertCanChange(current, version, allowed, action);
  // Same version and status but the extra filter failed (e.g. goods were received).
  throw statusConflict(current.status, allowed, action);
}

// ==========================================
// Vendors
// ==========================================

/**
 * Attaches a new PO to an active vendor: increments its document count, which also makes this
 * transaction conflict with a concurrent delete of the vendor.
 */
async function claimVendor(organizationId: string, vendorId: string, session: mongoose.ClientSession): Promise<VendorDocument> {
  const vendor = await Vendor.findOneAndUpdate(
    { _id: vendorId, organizationId, isActive: true },
    { $inc: { purchaseDocumentCount: 1 } },
    { new: true, session }
  );
  if (vendor) return vendor;
  const existing = await Vendor.findOne({ _id: vendorId, organizationId }).select("_id").session(session);
  throw vendorError(existing ? "VENDOR_INACTIVE" : "VENDOR_NOT_FOUND");
}

async function releaseVendor(organizationId: string, vendorId: ObjectId, session: mongoose.ClientSession) {
  await Vendor.updateOne(
    { _id: vendorId, organizationId, isDelete: anyState, purchaseDocumentCount: { $gt: 0 } },
    { $inc: { purchaseDocumentCount: -1 } },
    { session }
  );
}

/** The VAT treatment estimates use: the copy from issue, or the vendor's current one for a draft. */
async function effectiveVatTreatment(organizationId: string, po: PurchaseOrderDocument): Promise<VatTreatment> {
  if (po.vendorSnapshot) return po.vendorSnapshot.vatTreatment;
  const vendor = await Vendor.findOne({ _id: po.vendorId, organizationId, isDelete: anyState }).select("vatTreatment");
  return vendor?.vatTreatment ?? "not_registered";
}

// ==========================================
// Lines
// ==========================================

interface LineSource {
  variantId: string;
  quantityMilli: number;
  /** As sent (a decimal string); parsed against the currency. */
  unitCostText?: string;
  /** Already in minor units (a stored line being re-estimated). */
  unitCostMinor?: number;
  note: string | null;
}

type BuiltLine = Omit<IPurchaseOrderLine, "_id">;

interface BuiltLines {
  lines: BuiltLine[];
  subtotalMinor: number;
  estimatedTaxMinor: number;
  estimatedTotalMinor: number;
}

const fromInput = (lines: CreatePurchaseOrderInput["lines"]): LineSource[] =>
  lines.map((line) => ({
    variantId: line.variantId,
    quantityMilli: toMilli(line.quantity),
    unitCostText: line.unitCost,
    note: line.note ?? null,
  }));

const fromStored = (lines: IPurchaseOrderLine[]): LineSource[] =>
  lines.map((line) => ({
    variantId: line.variantId.toString(),
    quantityMilli: line.quantityMilli,
    unitCostMinor: line.unitCostMinor,
    note: line.note,
  }));

/** The tax rates products point to (any state: a product keeps its rate), plus the org default. */
async function taxRatesFor(organizationId: string, products: ProductDocument[]) {
  const ids = products.map((product) => product.taxRateId).filter((id): id is ObjectId => Boolean(id));
  const [rates, fallback] = await Promise.all([
    ids.length ? TaxRate.find({ organizationId, _id: { $in: ids }, isDelete: anyState }) : [],
    TaxRate.findOne({ organizationId, isDefault: true }),
  ]);
  return { byId: new Map(rates.map((rate) => [rate._id.toString(), rate])), fallback };
}

/**
 * Estimated VAT applies only to a standard-rated product bought from a VAT-registered vendor;
 * everything else (zero-rated, exempt, out of scope, or a vendor that charges no VAT, including
 * overseas vendors under reverse charge) estimates 0.
 */
function lineTax(
  product: ProductDocument,
  vatTreatment: VatTreatment,
  rates: { byId: Map<string, TaxRateDocument>; fallback: TaxRateDocument | null }
): IPurchaseOrderLineTax {
  if (vatTreatment !== "vat_registered" || product.taxPreference !== "standard") {
    return { taxPreference: product.taxPreference, taxRate: null };
  }
  const rate = (product.taxRateId && rates.byId.get(product.taxRateId.toString())) || rates.fallback;
  return {
    taxPreference: product.taxPreference,
    taxRate: rate ? { id: rate._id, name: rate.name, rate: rate.rate } : null,
  };
}

/**
 * Resolves and prices every line. Problems are collected across lines and refused together:
 * unknown or deleted variants, services, fractional quantities of whole-number units, a missing
 * cost with no cost price to fall back on, and costs that do not fit the currency.
 */
async function buildLines(
  organizationId: string,
  sources: LineSource[],
  vatTreatment: VatTreatment,
  decimals: number
): Promise<BuiltLines> {
  const variants = await ProductVariant.find({ organizationId, _id: { $in: sources.map((line) => oid(line.variantId)) } });
  const products = await Product.find({ organizationId, _id: { $in: variants.map((variant) => variant.productId) } });
  const variantById = new Map(variants.map((variant) => [variant._id.toString(), variant]));
  const productById = new Map(products.map((product) => [product._id.toString(), product]));
  const rates = await taxRatesFor(organizationId, products);

  const errors: ApiErrorDetail[] = [];
  const resolved: { variant: ProductVariantDocument; product: ProductDocument; unitCostMinor: number }[] = [];
  sources.forEach((line, index) => {
    const variant = variantById.get(line.variantId.toLowerCase());
    const product = variant ? productById.get(variant.productId.toString()) : undefined;
    const field = `lines[${index}].variantId`;
    if (!variant || !product) {
      errors.push({ field, code: "VARIANT_NOT_FOUND", message: `Variant '${line.variantId}' not found.` });
      return;
    }
    const name = variantDisplayName(product, variant.attributeValues);
    if (product.type !== "goods") {
      errors.push({
        field,
        code: "VARIANT_NOT_PURCHASABLE",
        message: `'${name}' is a service. Services go on vendor bills, not purchase orders.`,
      });
      return;
    }
    if (!unitAllowsDecimal(product.unit) && line.quantityMilli % 1000 !== 0) {
      const message = `Unit '${product.unit}' only allows whole quantities.`;
      errors.push({ field: `lines[${index}].quantity`, code: "VALIDATION_FAILED", message: `Request Validation Failed: lines[${index}].quantity: ${message}` });
      return;
    }

    let unitCostMinor = line.unitCostMinor;
    if (unitCostMinor === undefined && line.unitCostText !== undefined) {
      try {
        unitCostMinor = parseMoney(line.unitCostText, decimals, `lines[${index}].unitCost`);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const detail = (error.errors[0] ?? {}) as ApiErrorDetail;
        errors.push({ ...detail, field: `lines[${index}].unitCost`, code: error.code, message: error.message });
        return;
      }
    }
    if (unitCostMinor === undefined) {
      if (variant.costPriceMinor === null || variant.costPriceMinor === undefined) {
        errors.push({
          field: `lines[${index}].unitCost`,
          code: "UNIT_COST_REQUIRED",
          message: `'${name}' has no cost price: send a unitCost.`,
        });
        return;
      }
      unitCostMinor = variant.costPriceMinor;
    }
    resolved.push({ variant, product, unitCostMinor });
  });
  if (errors.length > 0) throw lineErrors(errors);

  const lines = resolved.map(({ variant, product, unitCostMinor }, index): BuiltLine => {
    const source = sources[index];
    const subtotalMinor = multiplyMoney(unitCostMinor, fromMilli(source.quantityMilli));
    const tax = lineTax(product, vatTreatment, rates);
    const estimatedTaxMinor = tax.taxRate ? applyRate(subtotalMinor, tax.taxRate.rate) : 0;
    return {
      variantId: variant._id,
      productId: product._id,
      quantityMilli: source.quantityMilli,
      receivedQuantityMilli: 0,
      unitCostMinor,
      subtotalMinor,
      ...tax,
      estimatedTaxMinor,
      totalMinor: subtotalMinor + estimatedTaxMinor,
      note: source.note,
    };
  });
  const subtotalMinor = sumMoney(lines.map((line) => line.subtotalMinor));
  const estimatedTaxMinor = sumMoney(lines.map((line) => line.estimatedTaxMinor));
  return { lines, subtotalMinor, estimatedTaxMinor, estimatedTotalMinor: subtotalMinor + estimatedTaxMinor };
}

const linesUpdate = (built: BuiltLines) => ({
  lines: built.lines,
  subtotalMinor: built.subtotalMinor,
  estimatedTaxMinor: built.estimatedTaxMinor,
  estimatedTotalMinor: built.estimatedTotalMinor,
});

function assertDateOrder(orderDate: string, expectedDate: string | null | undefined) {
  if (expectedDate && expectedDate < orderDate) {
    throw validationError("expectedDate", "expectedDate cannot be before orderDate.");
  }
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

async function viewContext(organizationId: string, pos: PurchaseOrderDocument[], withLines: boolean, decimals?: number): Promise<ViewContext> {
  const userIds = pos.flatMap((po) => [po.createdBy, po.issued?.by ?? null, po.cancelled?.by ?? null, po.closed?.by ?? null]);
  const lines = withLines ? pos.flatMap((po) => po.lines) : [];
  const [resolvedDecimals, stores, users, vendors, catalog] = await Promise.all([
    decimals ?? currencyDecimals(organizationId),
    storeRefs(organizationId, pos.map((po) => po.storeId)),
    userRefs(organizationId, userIds),
    pos.length
      ? Vendor.find({ organizationId, _id: { $in: pos.map((po) => po.vendorId) }, isDelete: anyState })
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

function userRef(ctx: ViewContext, id: ObjectId) {
  return ctx.users.get(id.toString()) ?? { id, name: "(unknown)" };
}

const eventView = (ctx: ViewContext, event: { at: Date; by: ObjectId } | null) =>
  event ? { at: event.at, by: userRef(ctx, event.by) } : null;

function vendorView(ctx: ViewContext, po: PurchaseOrderDocument) {
  const vendor = ctx.vendors.get(po.vendorId.toString());
  const details = po.vendorSnapshot ?? {
    name: vendor?.name ?? "(unknown)",
    legalName: vendor?.legalName ?? null,
    taxRegistrationNumber: vendor?.taxRegistrationNumber ?? null,
    vatTreatment: vendor?.vatTreatment ?? "not_registered",
  };
  return {
    id: po.vendorId,
    name: details.name,
    legalName: details.legalName ?? null,
    taxRegistrationNumber: details.taxRegistrationNumber ?? null,
    vatTreatment: details.vatTreatment,
    isActive: Boolean(vendor && vendor.isActive && !vendor.isDelete),
  };
}

function coreView(ctx: ViewContext, po: PurchaseOrderDocument) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  return {
    id: po._id,
    number: po.number,
    status: po.status,
    store: ctx.stores.get(po.storeId.toString()) ?? { id: po.storeId, name: "(unknown)", code: "" },
    vendor: vendorView(ctx, po),
    orderDate: po.orderDate,
    expectedDate: po.expectedDate ?? null,
    vendorReference: po.vendorReference ?? null,
    subtotal: money(po.subtotalMinor),
    estimatedTax: money(po.estimatedTaxMinor),
    estimatedTotal: money(po.estimatedTotalMinor),
    version: po.version,
    createdBy: userRef(ctx, po.createdBy),
    createdAt: po.createdAt,
    updatedAt: po.updatedAt,
  };
}

function summaryView(ctx: ViewContext, po: PurchaseOrderDocument) {
  return { ...coreView(ctx, po), lineCount: po.lines.length };
}

function detailView(ctx: ViewContext, po: PurchaseOrderDocument) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  const catalog = ctx.catalog!;
  return {
    ...coreView(ctx, po),
    notes: po.notes ?? null,
    lines: po.lines.map((line) => ({
      id: line._id,
      variant: catalog.variant(line.variantId),
      product: catalog.product(line.productId),
      quantity: fromMilli(line.quantityMilli),
      receivedQuantity: fromMilli(line.receivedQuantityMilli),
      unitCost: money(line.unitCostMinor),
      subtotal: money(line.subtotalMinor),
      tax: {
        taxPreference: line.taxPreference,
        taxRate: line.taxRate ? { id: line.taxRate.id, name: line.taxRate.name, rate: line.taxRate.rate } : null,
        estimatedTax: money(line.estimatedTaxMinor),
      },
      total: money(line.totalMinor),
      note: line.note ?? null,
    })),
    issued: eventView(ctx, po.issued),
    cancelled: eventView(ctx, po.cancelled),
    closed: eventView(ctx, po.closed),
    statusReason: po.statusReason ?? null,
    editable: EDITABLE_STATUSES.includes(po.status),
  };
}

async function toDetail(organizationId: string, po: PurchaseOrderDocument, decimals?: number) {
  return detailView(await viewContext(organizationId, [po], true, decimals), po);
}

// ==========================================
// Reads
// ==========================================

export interface ListPurchaseOrdersQuery {
  search?: string;
  storeId?: string;
  vendorId?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Lists POs, newest number first. `storeId` (from the URL) limits it to one store; without it,
 * `user` narrows it to the stores where they hold purchase:read (all for an organization role).
 * Filters are lenient like the other lists: a value that cannot match returns nothing.
 */
export async function listPurchaseOrders(
  organizationId: string,
  scope: { storeId: string } | { user: IUser },
  query: ListPurchaseOrdersQuery
) {
  const { page, limit, skip } = resolvePaging(query);
  const empty = () => ({ purchaseOrders: [], pagination: buildPaginationMeta(page, limit, 0) });
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

  if (query.vendorId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(query.vendorId)) return empty();
    conditions.push({ vendorId: oid(query.vendorId) });
  }

  if (query.status) {
    const statuses = query.status
      .split(",")
      .map((status) => status.trim())
      .filter((status): status is PurchaseOrderStatus => (PURCHASE_ORDER_STATUSES as readonly string[]).includes(status));
    if (statuses.length > 0) conditions.push({ status: { $in: statuses } });
  }

  const from = query.from?.trim();
  const to = query.to?.trim();
  if (from && isCalendarDate(from)) conditions.push({ orderDate: { $gte: from } });
  if (to && isCalendarDate(to)) conditions.push({ orderDate: { $lte: to } });

  // A NUL byte makes MongoDB reject the regex (500); no PO text can contain one.
  const term = query.search?.replace(/\0/g, "").trim();
  if (term) {
    const upper = term.toUpperCase();
    const numberPrefix = upper.startsWith("PO-") ? upper : `PO-${upper}`;
    conditions.push({
      $or: [
        { number: { $regex: `^${escapeRegex(numberPrefix)}` } },
        { vendorReference: { $regex: `^${escapeRegex(term)}`, $options: "i" } },
      ],
    });
  }

  const filter = { $and: conditions };
  const [total, pos] = await Promise.all([
    PurchaseOrder.countDocuments(filter),
    PurchaseOrder.find(filter).sort({ sequence: -1 }).skip(skip).limit(limit),
  ]);
  const ctx = await viewContext(organizationId, pos, false);
  return {
    purchaseOrders: pos.map((po) => summaryView(ctx, po)),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

export async function getPurchaseOrder(organizationId: string, storeId: string, purchaseOrderId: string) {
  return toDetail(organizationId, await findPurchaseOrderOrThrow(organizationId, storeId, purchaseOrderId));
}

/**
 * The numbers of open POs (draft, issued, partially received) with any of these variants, for
 * the catalog's delete checks. At most `limit`, oldest first.
 */
export async function openPurchaseOrderNumbers(organizationId: string, variantIds: ObjectId[], limit = 5): Promise<string[]> {
  if (variantIds.length === 0) return [];
  const pos = await PurchaseOrder.find({
    organizationId,
    "lines.variantId": { $in: variantIds },
    status: { $in: OPEN_PURCHASE_ORDER_STATUSES },
  })
    .select("number")
    .sort({ sequence: 1 })
    .limit(limit);
  return pos.map((po) => po.number);
}

// ==========================================
// Writes
// ==========================================

/**
 * Creates a draft in the store and gives it the organization's next PO number. Runs inside the
 * caller's transaction (see idempotency.service), together with the vendor claim and the counter.
 */
export async function createPurchaseOrder(
  organizationId: string,
  storeId: string,
  input: CreatePurchaseOrderInput,
  actorUserId: string,
  session: mongoose.ClientSession
) {
  const decimals = await currencyDecimals(organizationId);
  const orderDate = input.orderDate ?? (await storeToday(organizationId, storeId));
  assertDateOrder(orderDate, input.expectedDate);

  const vendor = await claimVendor(organizationId, input.vendorId, session);
  const built = await buildLines(organizationId, fromInput(input.lines), vendor.vatTreatment, decimals);

  const orgId = oid(organizationId);
  const counter = await DocumentCounter.findOneAndUpdate(
    { organizationId: orgId, type: "purchase_order" },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );
  const sequence = counter!.seq;

  const [po] = await PurchaseOrder.create(
    [
      {
        organizationId: orgId,
        storeId: oid(storeId),
        number: `PO-${String(sequence).padStart(5, "0")}`,
        sequence,
        status: "draft",
        vendorId: vendor._id,
        vendorSnapshot: null,
        orderDate,
        expectedDate: input.expectedDate ?? null,
        vendorReference: input.vendorReference ?? null,
        notes: input.notes ?? null,
        ...linesUpdate(built),
        version: 1,
        createdBy: oid(actorUserId),
      },
    ],
    { session }
  );

  logger.info(`Purchase order created: ${po.number} (${po._id}) store=${storeId} org=${organizationId} by user=${actorUserId}`);
  return toDetail(organizationId, po, decimals);
}

/**
 * Edits a draft, or an issued PO with nothing received. `lines` replaces every line. The VAT
 * estimate is worked out again when the lines or the vendor change: against the vendor's current
 * VAT treatment for a draft, and against the copy taken at issue for an issued PO.
 */
export async function updatePurchaseOrder(
  organizationId: string,
  storeId: string,
  purchaseOrderId: string,
  input: UpdatePurchaseOrderInput,
  actorUserId: string
) {
  const po = await findPurchaseOrderOrThrow(organizationId, storeId, purchaseOrderId);
  assertCanChange(po, input.version, EDITABLE_STATUSES, "edited");
  if (input.vendorId !== undefined && po.status !== "draft") {
    throw validationError("vendorId", "An issued purchase order keeps its vendor. Cancel it and create a new one instead.");
  }
  const orderDate = input.orderDate ?? po.orderDate;
  const expectedDate = input.expectedDate !== undefined ? input.expectedDate : po.expectedDate;
  assertDateOrder(orderDate, expectedDate);

  const decimals = await currencyDecimals(organizationId);
  const vendorChanges = input.vendorId !== undefined && input.vendorId.toLowerCase() !== po.vendorId.toString();

  const updated = await runStockTransaction(async (session) => {
    const set: Record<string, unknown> = {};
    let vatTreatment: VatTreatment;
    if (input.vendorId !== undefined && vendorChanges) {
      const vendor = await claimVendor(organizationId, input.vendorId, session);
      await releaseVendor(organizationId, po.vendorId, session);
      set.vendorId = vendor._id;
      vatTreatment = vendor.vatTreatment;
    } else {
      // No vendor sent, or the PO's own vendor sent again (a form resent whole): no change, so a
      // vendor deactivated since the draft was made never blocks an edit.
      vatTreatment = await effectiveVatTreatment(organizationId, po);
    }

    if (input.lines !== undefined || vendorChanges) {
      const sources = input.lines !== undefined ? fromInput(input.lines) : fromStored(po.lines);
      Object.assign(set, linesUpdate(await buildLines(organizationId, sources, vatTreatment, decimals)));
    }
    if (input.orderDate !== undefined) set.orderDate = input.orderDate;
    if (input.expectedDate !== undefined) set.expectedDate = input.expectedDate;
    if (input.vendorReference !== undefined) set.vendorReference = input.vendorReference;
    if (input.notes !== undefined) set.notes = input.notes;

    return conditionalUpdate(organizationId, storeId, purchaseOrderId, input.version, EDITABLE_STATUSES, "edited", { $set: set }, session);
  });

  logger.info(`Purchase order updated: ${updated.number} store=${storeId} org=${organizationId} by user=${actorUserId}`);
  return toDetail(organizationId, updated, decimals);
}

/** Soft-deletes a draft; its number is not reused. The vendor's document count goes back down. */
export async function deletePurchaseOrder(
  organizationId: string,
  storeId: string,
  purchaseOrderId: string,
  version: number,
  actorUserId: string
) {
  const po = await findPurchaseOrderOrThrow(organizationId, storeId, purchaseOrderId);
  assertCanChange(po, version, ["draft"], "deleted");

  await runStockTransaction(async (session) => {
    const deleted = await conditionalUpdate(
      organizationId,
      storeId,
      purchaseOrderId,
      version,
      ["draft"],
      "deleted",
      { $set: { isDelete: true } },
      session
    );
    await releaseVendor(organizationId, deleted.vendorId, session);
  });

  logger.info(`Purchase order deleted: ${po.number} store=${storeId} org=${organizationId} by user=${actorUserId}`);
}

/**
 * Moves a draft to issued. The vendor must still be active. The vendor's details are copied onto
 * the PO and the VAT estimate is worked out again against that copy (and the products' current
 * tax settings), so an issued PO's VAT always matches the vendor details it shows.
 */
export async function issuePurchaseOrder(
  organizationId: string,
  storeId: string,
  purchaseOrderId: string,
  version: number,
  actorUserId: string
) {
  const po = await findPurchaseOrderOrThrow(organizationId, storeId, purchaseOrderId);
  assertCanChange(po, version, ["draft"], "issued");

  const vendor = await Vendor.findOne({ _id: po.vendorId, organizationId });
  if (!vendor) throw vendorError("VENDOR_NOT_FOUND");
  if (!vendor.isActive) throw vendorError("VENDOR_INACTIVE");

  const decimals = await currencyDecimals(organizationId);
  const built = await buildLines(organizationId, fromStored(po.lines), vendor.vatTreatment, decimals);

  const issued = await conditionalUpdate(
    organizationId,
    storeId,
    purchaseOrderId,
    version,
    ["draft"],
    "issued",
    {
      $set: {
        status: "issued",
        vendorSnapshot: {
          name: vendor.name,
          legalName: vendor.legalName ?? null,
          taxRegistrationNumber: vendor.taxRegistrationNumber ?? null,
          vatTreatment: vendor.vatTreatment,
        },
        issued: { at: new Date(), by: oid(actorUserId) },
        ...linesUpdate(built),
      },
    },
    null
  );

  logger.info(`Purchase order issued: ${issued.number} store=${storeId} org=${organizationId} by user=${actorUserId}`);
  return toDetail(organizationId, issued, decimals);
}

/** Stops an issued PO before anything arrived. Final. */
export async function cancelPurchaseOrder(
  organizationId: string,
  storeId: string,
  purchaseOrderId: string,
  input: CancelPurchaseOrderInput,
  actorUserId: string
) {
  const po = await findPurchaseOrderOrThrow(organizationId, storeId, purchaseOrderId);
  assertCanChange(po, input.version, ["issued"], "cancelled");

  const cancelled = await conditionalUpdate(
    organizationId,
    storeId,
    purchaseOrderId,
    input.version,
    ["issued"],
    "cancelled",
    {
      $set: { status: "cancelled", cancelled: { at: new Date(), by: oid(actorUserId) }, statusReason: input.reason ?? null },
      extraFilter: { "lines.receivedQuantityMilli": { $not: { $gt: 0 } } },
    },
    null
  );

  logger.info(`Purchase order cancelled: ${cancelled.number} store=${storeId} org=${organizationId} by user=${actorUserId}`);
  return toDetail(organizationId, cancelled);
}

/** Ends a partly received PO whose remaining goods will not come. Final. */
export async function closePurchaseOrder(
  organizationId: string,
  storeId: string,
  purchaseOrderId: string,
  input: ClosePurchaseOrderInput,
  actorUserId: string
) {
  const po = await findPurchaseOrderOrThrow(organizationId, storeId, purchaseOrderId);
  assertCanChange(po, input.version, ["partially_received"], "closed");

  const closed = await conditionalUpdate(
    organizationId,
    storeId,
    purchaseOrderId,
    input.version,
    ["partially_received"],
    "closed",
    { $set: { status: "closed", closed: { at: new Date(), by: oid(actorUserId) }, statusReason: input.reason ?? null } },
    null
  );

  logger.info(`Purchase order closed: ${closed.number} store=${storeId} org=${organizationId} by user=${actorUserId}`);
  return toDetail(organizationId, closed);
}
