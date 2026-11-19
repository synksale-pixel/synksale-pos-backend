/**
 * Purpose: Vendor Return Service (Phase 3e).
 * Sending received goods back to the vendor from one store, and reading returns.
 *
 * A return is posted in one transaction (the caller's, see idempotency.service), all or nothing:
 * - the return and its RTN- number, and the vendor's document count;
 * - each receipt line's `returnedQuantityMilli` and `returnedUnbilledMilli`;
 * - a `vendor_return` movement per stocked line, at the store's average cost (unchanged);
 * - for goods that had been billed, one debit note per bill (see debitNote.service), which
 *   credits the bill lines and applies the credit to the bill.
 *
 * Each line takes the receipt line's unbilled quantity first; only the rest is credited, on the
 * bill line the client names. Returns need the stock on hand, whatever allowNegativeStock says.
 *
 * Concurrency: the receipt line is written only while its counters are as read, and stock levels
 * and bills are written as the ledger and payments do, so a concurrent return, bill or sale on
 * the same records aborts one transaction, which then runs again with fresh reads.
 *
 * Money is in minor units and quantities in thousandths.
 */

import mongoose from "mongoose";
import { VendorReturn, VendorReturnDocument, IVendorReturnLine, IVendorReturnDebitNoteRef } from "../models/vendorReturn.model";
import { GoodsReceipt, GoodsReceiptDocument, IGoodsReceiptLine, billableMilli } from "../models/goodsReceipt.model";
import { Bill, BillDocument, IBillLine } from "../models/bill.model";
import { nextDocumentNumber } from "./documentNumber.service";
import { Vendor, VendorDocument } from "../models/vendor.model";
import { Product, ProductDocument } from "../models/product.model";
import { ProductVariant, ProductVariantDocument, variantDisplayName } from "../models/productVariant.model";
import { IUser } from "../models/user.model";
import { ApiError, ApiErrorDetail } from "../utils/ApiError";
import { formatMoney, multiplyMoney, sumMoney } from "../utils/money";
import { fromMilli, toMilli } from "../utils/quantity";
import { resolvePaging, buildPaginationMeta } from "../utils/pagination";
import { logger } from "../config/logger.config";
import { unitAllowsDecimal } from "../config/units.config";
import { storesWithPermission } from "./permission.service";
import { catalogRefs, storeRefs, userRefs, CatalogRefs, StoreRef, UserRef } from "./stock.service";
import { applyMovement, readLevel } from "./stockLedger.service";
import { storeToday } from "./purchaseOrder.service";
import { billSettings, collected, csvFilter, escapeRegex, numberPrefix, validationError } from "./bill.service";
import { creditRoom, postDebitNote, PlannedCredit } from "./debitNote.service";
import { isCalendarDate } from "../validators/purchaseOrder.validator";
import { RETURN_REASONS, CreateVendorReturnInput } from "../validators/vendorReturn.validator";

type ObjectId = mongoose.Types.ObjectId;
const oid = (id: string | ObjectId) => new mongoose.Types.ObjectId(String(id));

const anyState = { $in: [true, false] };

/** A stored counter as read, matched exactly (lines posted before 3d/3e have no counters: 0). */
const asRead = (value: number | undefined) => (value ? value : { $in: [0, null] });

function vendorReturnNotFound(): ApiError {
  return ApiError.coded(404, "VENDOR_RETURN_NOT_FOUND", "Vendor return not found.");
}

// ==========================================
// Planning
// ==========================================

interface PlannedLine {
  index: number;
  receipt: GoodsReceiptDocument;
  receiptLine: IGoodsReceiptLine;
  variant: ProductVariantDocument;
  product: ProductDocument;
  stocked: boolean;
  quantityMilli: number;
  unbilledMilli: number;
  creditedMilli: number;
  bill: BillDocument | null;
  billLine: IBillLine | null;
  note: string | null;
}

async function loadReceipts(organizationId: string, storeId: string, input: CreateVendorReturnInput, session: mongoose.ClientSession) {
  const ids = [...new Set(input.lines.map((line) => line.goodsReceiptId.toLowerCase()))];
  // Another store's receipt is not found: goods go back from the store that holds them.
  const receipts = await GoodsReceipt.find({ organizationId, storeId: oid(storeId), _id: { $in: ids.map(oid) } }).session(session);
  const byId = new Map(receipts.map((receipt) => [receipt._id.toString(), receipt]));

  const missing: ApiErrorDetail[] = [];
  const resolved = input.lines.map((line, index) => {
    const receipt = byId.get(line.goodsReceiptId.toLowerCase());
    if (!receipt) {
      missing.push({ field: `lines[${index}].goodsReceiptId`, code: "GOODS_RECEIPT_NOT_FOUND", message: "Goods receipt not found." });
      return null;
    }
    const receiptLine = receipt.lines.find((l) => l._id.toString() === line.goodsReceiptLineId.toLowerCase());
    if (!receiptLine) {
      missing.push({
        field: `lines[${index}].goodsReceiptLineId`,
        code: "GOODS_RECEIPT_NOT_FOUND",
        message: `Goods receipt ${receipt.number} has no line '${line.goodsReceiptLineId}'.`,
      });
      return null;
    }
    return { receipt, receiptLine };
  });
  if (missing.length > 0) throw collected(404, missing);
  return resolved as { receipt: GoodsReceiptDocument; receiptLine: IGoodsReceiptLine }[];
}

async function loadBills(organizationId: string, storeId: string, input: CreateVendorReturnInput, session: mongoose.ClientSession) {
  const ids = [...new Set(input.lines.flatMap((line) => (line.billId ? [line.billId.toLowerCase()] : [])))];
  // Only bills with a line for this store's goods are visible: another store's bill is not found.
  const bills = ids.length
    ? await Bill.find({ organizationId, _id: { $in: ids.map(oid) }, "lines.storeId": oid(storeId) }).session(session)
    : [];
  const byId = new Map(bills.map((bill) => [bill._id.toString(), bill]));

  const missing: ApiErrorDetail[] = [];
  const resolved = input.lines.map((line, index) => {
    if (!line.billId || !line.billLineId) return null;
    const bill = byId.get(line.billId.toLowerCase());
    if (!bill) {
      missing.push({ field: `lines[${index}].billId`, code: "BILL_NOT_FOUND", message: "Bill not found." });
      return null;
    }
    const billLine = bill.lines.find((l) => l._id.toString() === line.billLineId!.toLowerCase());
    if (!billLine) {
      missing.push({ field: `lines[${index}].billLineId`, code: "BILL_NOT_FOUND", message: `Bill ${bill.number} has no line '${line.billLineId}'.` });
      return null;
    }
    return { bill, billLine };
  });
  if (missing.length > 0) throw collected(404, missing);
  return resolved;
}

async function loadCatalog(organizationId: string, variantIds: ObjectId[]) {
  // Deleted variants are loaded too: received goods can always go back (deletes refuse purchase history anyway).
  const variants = await ProductVariant.find({ organizationId, _id: { $in: variantIds }, isDelete: anyState });
  const products = await Product.find({ organizationId, _id: { $in: variants.map((v) => v.productId) }, isDelete: anyState });
  const productById = new Map(products.map((product) => [product._id.toString(), product]));
  const byVariant = new Map<string, { variant: ProductVariantDocument; product: ProductDocument }>();
  for (const variant of variants) {
    const product = productById.get(variant.productId.toString());
    if (product) byVariant.set(variant._id.toString(), { variant, product });
  }
  return byVariant;
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
  /** Whether the caller sees stock costs for a store (inventory:read). */
  showCost: (storeId: ObjectId) => boolean;
}

async function viewContext(
  organizationId: string,
  returns: VendorReturnDocument[],
  withLines: boolean,
  showCost: (storeId: ObjectId) => boolean,
  decimals?: number
): Promise<ViewContext> {
  const lines = withLines ? returns.flatMap((r) => r.lines) : [];
  const [resolvedDecimals, stores, users, vendors, catalog] = await Promise.all([
    decimals ?? billSettings(organizationId).then((settings) => settings.decimals),
    storeRefs(organizationId, returns.map((r) => r.storeId)),
    userRefs(organizationId, returns.map((r) => r.createdBy)),
    returns.length
      ? Vendor.find({ organizationId, _id: { $in: returns.map((r) => r.vendorId) }, isDelete: anyState })
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
    showCost,
  };
}

function coreView(ctx: ViewContext, vendorReturn: VendorReturnDocument) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  const vendor = ctx.vendors.get(vendorReturn.vendorId.toString());
  const snapshot = vendorReturn.vendorSnapshot;
  return {
    id: vendorReturn._id,
    number: vendorReturn.number,
    store: ctx.stores.get(vendorReturn.storeId.toString()) ?? { id: vendorReturn.storeId, name: "(unknown)", code: "" },
    vendor: {
      id: vendorReturn.vendorId,
      name: snapshot.name,
      legalName: snapshot.legalName ?? null,
      taxRegistrationNumber: snapshot.taxRegistrationNumber ?? null,
      vatTreatment: snapshot.vatTreatment,
      isActive: Boolean(vendor && vendor.isActive && !vendor.isDelete),
    },
    returnDate: vendorReturn.returnDate,
    reason: vendorReturn.reason,
    vendorReference: vendorReturn.vendorReference ?? null,
    stockValue: ctx.showCost(vendorReturn.storeId) ? money(vendorReturn.stockValueMinor) : null,
    credit: money(vendorReturn.creditMinor),
    createdBy: ctx.users.get(vendorReturn.createdBy.toString()) ?? { id: vendorReturn.createdBy, name: "(unknown)" },
    createdAt: vendorReturn.createdAt,
  };
}

function summaryView(ctx: ViewContext, vendorReturn: VendorReturnDocument) {
  return { ...coreView(ctx, vendorReturn), lineCount: vendorReturn.lines.length };
}

function lineView(ctx: ViewContext, showCost: boolean, line: IVendorReturnLine) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  const catalog = ctx.catalog!;
  return {
    id: line._id,
    goodsReceipt: { id: line.goodsReceiptId, number: line.goodsReceiptNumber, receivedDate: line.goodsReceiptDate },
    goodsReceiptLineId: line.goodsReceiptLineId,
    variant: catalog.variant(line.variantId),
    product: catalog.product(line.productId),
    quantity: fromMilli(line.quantityMilli),
    unbilledQuantity: fromMilli(line.unbilledQuantityMilli),
    creditedQuantity: fromMilli(line.quantityMilli - line.unbilledQuantityMilli),
    billLine:
      line.billId && line.billLineId
        ? {
            bill: { id: line.billId, number: line.billNumber ?? "" },
            lineId: line.billLineId,
            unitCost: money(line.billUnitCostMinor ?? 0),
          }
        : null,
    stocked: line.stocked,
    unitCost: line.stocked && showCost ? money(line.unitCostMinor) : null,
    stockValue: showCost ? money(line.stockValueMinor) : null,
    quantityAfter: line.quantityAfterMilli === null || line.quantityAfterMilli === undefined ? null : fromMilli(line.quantityAfterMilli),
    note: line.note ?? null,
  };
}

function detailView(ctx: ViewContext, vendorReturn: VendorReturnDocument) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  const showCost = ctx.showCost(vendorReturn.storeId);
  return {
    ...coreView(ctx, vendorReturn),
    notes: vendorReturn.notes ?? null,
    lines: vendorReturn.lines.map((line) => lineView(ctx, showCost, line)),
    debitNotes: vendorReturn.debitNotes.map((ref) => ({
      id: ref.debitNoteId,
      number: ref.number,
      bill: { id: ref.billId, number: ref.billNumber },
      total: money(ref.totalMinor),
    })),
  };
}

// ==========================================
// Reads
// ==========================================

export interface ListVendorReturnsQuery {
  search?: string;
  storeId?: string;
  vendorId?: string;
  goodsReceiptId?: string;
  reason?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

/**
 * Lists returns, newest number first. `storeId` (from the URL, with the caller's cost access)
 * limits it to one store; without it, `user` narrows it to the stores where they hold
 * purchase:read, and costs show only where they hold inventory:read.
 */
export async function listVendorReturns(
  organizationId: string,
  scope: { storeId: string; showCost: boolean } | { user: IUser },
  query: ListVendorReturnsQuery
) {
  const { page, limit, skip } = resolvePaging(query);
  const empty = () => ({ vendorReturns: [], pagination: buildPaginationMeta(page, limit, 0) });
  const conditions: Record<string, unknown>[] = [{ organizationId }];
  let showCost: (storeId: ObjectId) => boolean;

  if ("storeId" in scope) {
    conditions.push({ storeId: oid(scope.storeId) });
    showCost = () => scope.showCost;
  } else {
    const [stores, costStores] = await Promise.all([
      storesWithPermission(scope.user, "purchase:read"),
      storesWithPermission(scope.user, "inventory:read"),
    ]);
    if (stores !== "all") conditions.push({ storeId: { $in: [...stores].map(oid) } });
    if (query.storeId !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(query.storeId)) return empty();
      conditions.push({ storeId: oid(query.storeId) });
    }
    showCost = (storeId) => costStores === "all" || costStores.has(storeId.toString());
  }

  for (const field of ["vendorId", "goodsReceiptId"] as const) {
    const value = query[field];
    if (value === undefined) continue;
    if (!mongoose.Types.ObjectId.isValid(value)) return empty();
    conditions.push(field === "vendorId" ? { vendorId: oid(value) } : { goodsReceiptIds: oid(value) });
  }
  const reasons = csvFilter(query.reason, RETURN_REASONS);
  if (reasons) conditions.push({ reason: { $in: reasons } });

  const from = query.from?.trim();
  const to = query.to?.trim();
  if (from && isCalendarDate(from)) conditions.push({ returnDate: { $gte: from } });
  if (to && isCalendarDate(to)) conditions.push({ returnDate: { $lte: to } });

  // A NUL byte makes MongoDB reject the regex (500); no return text can contain one.
  const term = query.search?.replace(/\0/g, "").trim();
  if (term) {
    conditions.push({
      $or: [
        { number: { $regex: `^${escapeRegex(numberPrefix(term, "RTN-"))}` } },
        { vendorReference: { $regex: `^${escapeRegex(term)}`, $options: "i" } },
      ],
    });
  }

  const filter = { $and: conditions };
  const [total, returns] = await Promise.all([
    VendorReturn.countDocuments(filter),
    VendorReturn.find(filter).sort({ sequence: -1 }).skip(skip).limit(limit),
  ]);
  const ctx = await viewContext(organizationId, returns, false, showCost);
  return {
    vendorReturns: returns.map((r) => summaryView(ctx, r)),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

export async function getVendorReturn(organizationId: string, storeId: string, vendorReturnId: string, showCost: boolean) {
  const vendorReturn = await VendorReturn.findOne({ _id: vendorReturnId, organizationId, storeId });
  if (!vendorReturn) throw vendorReturnNotFound();
  const ctx = await viewContext(organizationId, [vendorReturn], true, () => showCost);
  return { vendorReturn: detailView(ctx, vendorReturn) };
}

// ==========================================
// Posting
// ==========================================

/**
 * Posts a vendor return from the store. Runs inside the caller's transaction (see
 * idempotency.service). Checked in this order: the vendor (400), receipts and bills named (404),
 * line problems (400, together), the date (400), then quantity, bill and stock problems (409,
 * together). `showCost` is whether the caller holds inventory:read for this store.
 */
export async function createVendorReturn(
  organizationId: string,
  storeId: string,
  input: CreateVendorReturnInput,
  actorUserId: string,
  session: mongoose.ClientSession,
  showCost: boolean
) {
  const settings = await billSettings(organizationId);
  const orgId = oid(organizationId);
  const store = oid(storeId);

  // Deactivated vendors can still take their goods back.
  const vendor = await Vendor.findOne({ _id: oid(input.vendorId), organizationId }).session(session);
  if (!vendor) {
    throw ApiError.coded(400, "VENDOR_NOT_FOUND", "Vendor not found.", [{ field: "vendorId", code: "VENDOR_NOT_FOUND" }]);
  }

  const receipts = await loadReceipts(organizationId, storeId, input, session);
  const bills = await loadBills(organizationId, storeId, input, session);
  const catalog = await loadCatalog(
    organizationId,
    receipts.map((r) => r.receiptLine.variantId)
  );

  // ---------- Line problems (400) ----------
  const errors: ApiErrorDetail[] = [];
  const planned: PlannedLine[] = [];
  input.lines.forEach((line, index) => {
    const { receipt, receiptLine } = receipts[index];
    const named = bills[index];
    const entry = catalog.get(receiptLine.variantId.toString());
    let ok = true;
    if (!receipt.vendorId.equals(vendor._id)) {
      errors.push({
        field: `lines[${index}].goodsReceiptId`,
        code: "VENDOR_MISMATCH",
        message: `Goods receipt ${receipt.number} is from a different vendor.`,
        meta: { goodsReceiptNumber: receipt.number },
      });
      ok = false;
    }
    if (named && !(named.billLine.goodsReceiptLineId && named.billLine.goodsReceiptLineId.equals(receiptLine._id))) {
      errors.push({
        field: `lines[${index}].billLineId`,
        code: "BILL_LINE_MISMATCH",
        message: `Line '${line.billLineId}' of ${named.bill.number} does not bill this receipt line.`,
        meta: { billNumber: named.bill.number },
      });
      ok = false;
    }
    if (!entry) {
      // Receipts keep their variants (catalog deletes refuse purchase history); defensive only.
      errors.push({ field: `lines[${index}].goodsReceiptLineId`, code: "VARIANT_NOT_FOUND", message: "This line's variant no longer exists." });
      return;
    }
    const quantityMilli = toMilli(line.quantity);
    if (!unitAllowsDecimal(entry.product.unit) && quantityMilli % 1000 !== 0) {
      const message = `Unit '${entry.product.unit}' only allows whole quantities.`;
      errors.push({
        field: `lines[${index}].quantity`,
        code: "VALIDATION_FAILED",
        message: `Request Validation Failed: lines[${index}].quantity: ${message}`,
      });
      ok = false;
    }
    if (!ok) return;

    // Unbilled goods go back first; only the rest was billed and is credited.
    const unbilledMilli = Math.min(quantityMilli, Math.max(0, billableMilli(receiptLine)));
    const creditedMilli = quantityMilli - unbilledMilli;
    planned.push({
      index,
      receipt,
      receiptLine,
      variant: entry.variant,
      product: entry.product,
      // As received: goods that added no stock take none away.
      stocked: receiptLine.stocked,
      quantityMilli,
      unbilledMilli,
      creditedMilli,
      bill: creditedMilli > 0 && named ? named.bill : null,
      billLine: creditedMilli > 0 && named ? named.billLine : null,
      note: line.note ?? null,
    });
  });
  if (errors.length > 0) throw collected(400, errors);

  // ---------- Date (400) ----------
  const today = await storeToday(organizationId, storeId);
  const returnDate = input.returnDate ?? today;
  if (returnDate > today) throw validationError("returnDate", "returnDate cannot be in the future.");
  const latestReceipt = planned.reduce((max, line) => (line.receipt.receivedDate > max ? line.receipt.receivedDate : max), "");
  if (returnDate < latestReceipt) {
    throw validationError("returnDate", `returnDate cannot be before the latest receivedDate of the receipts returned (${latestReceipt}).`);
  }
  const latestBill = planned.reduce((max, line) => (line.bill && line.bill.billDate > max ? line.bill.billDate : max), "");
  if (returnDate < latestBill) {
    throw validationError("returnDate", `returnDate cannot be before the billDate of a bill credited (${latestBill}).`);
  }

  // ---------- Quantities, bills and stock (409) ----------
  const conflicts: ApiErrorDetail[] = [];
  const requestedByVariant = new Map<string, number>();
  for (const line of planned) {
    const name = variantDisplayName(line.product, line.variant.attributeValues);
    const received = line.receiptLine.quantityMilli;
    const returned = line.receiptLine.returnedQuantityMilli ?? 0;
    if (returned + line.quantityMilli > received) {
      conflicts.push({
        field: `lines[${line.index}].quantity`,
        code: "RETURNED_QUANTITY_EXCEEDS_RECEIVED",
        message: `More than was received would go back for '${name}' on ${line.receipt.number}: ${fromMilli(received - returned)} left to return.`,
        meta: { received: fromMilli(received), returned: fromMilli(returned), remaining: fromMilli(Math.max(0, received - returned)) },
      });
      continue;
    }
    if (line.creditedMilli > 0) {
      if (!line.billLine) {
        conflicts.push({
          field: `lines[${line.index}].quantity`,
          code: "BILL_LINE_REQUIRED",
          message: `Part of this quantity of '${name}' was billed: name the bill line to credit (billId and billLineId).`,
          meta: { billable: fromMilli(line.unbilledMilli) },
        });
        continue;
      }
      if (line.bill!.status === "void") {
        conflicts.push({
          field: `lines[${line.index}].billId`,
          code: "BILL_STATUS_CONFLICT",
          message: `Bill ${line.bill!.number} is void, so it cannot be credited.`,
          meta: { status: line.bill!.status },
        });
        continue;
      }
      const room = creditRoom(line.billLine).quantityMilli;
      if (line.creditedMilli > room) {
        conflicts.push({
          field: `lines[${line.index}].quantity`,
          code: "CREDITED_QUANTITY_EXCEEDS_BILLED",
          message: `Line of ${line.bill!.number} has ${fromMilli(Math.max(0, room))} of '${name}' left to credit. Return the rest against its other bill line.`,
          meta: {
            billed: fromMilli(line.billLine.quantityMilli),
            credited: fromMilli(line.billLine.returnedQuantityMilli ?? 0),
            remaining: fromMilli(Math.max(0, room)),
          },
        });
        continue;
      }
    }
    if (line.stocked) {
      const key = line.variant._id.toString();
      const requested = (requestedByVariant.get(key) ?? 0) + line.quantityMilli;
      requestedByVariant.set(key, requested);
      const level = await readLevel(session, orgId, store, line.variant._id);
      // Returns need the goods on hand, even when the organization allows negative stock.
      if (level.quantityMilli < requested) {
        const available = fromMilli(Math.max(0, level.quantityMilli - (requested - line.quantityMilli)));
        conflicts.push({
          field: `lines[${line.index}]`,
          code: "INSUFFICIENT_STOCK",
          message: `Not enough stock for '${name}': ${available} available, ${fromMilli(line.quantityMilli)} requested.`,
          meta: { variantId: key, available, requested: fromMilli(line.quantityMilli) },
        });
      }
    }
  }
  if (conflicts.length > 0) throw collected(409, conflicts);

  // ---------- Writes ----------
  const actor = oid(actorUserId);
  const at = new Date();
  const returnId = new mongoose.Types.ObjectId();
  const sequence = await nextDocumentNumber({ organizationId: orgId, type: "vendor_return" }, session);
  const number = `RTN-${String(sequence).padStart(5, "0")}`;

  const lines: IVendorReturnLine[] = [];
  for (const line of planned) {
    const moved = await GoodsReceipt.updateOne(
      {
        _id: line.receipt._id,
        organizationId: orgId,
        storeId: store,
        lines: {
          $elemMatch: {
            _id: line.receiptLine._id,
            billedQuantityMilli: asRead(line.receiptLine.billedQuantityMilli),
            returnedQuantityMilli: asRead(line.receiptLine.returnedQuantityMilli),
            returnedUnbilledMilli: asRead(line.receiptLine.returnedUnbilledMilli),
          },
        },
      },
      { $inc: { "lines.$.returnedQuantityMilli": line.quantityMilli, "lines.$.returnedUnbilledMilli": line.unbilledMilli } },
      { session }
    );
    // The read and this write share the transaction's snapshot: a concurrent bill or return
    // normally aborts with a retried write conflict before reaching here.
    if (moved.matchedCount !== 1) {
      throw ApiError.coded(409, "RETURNED_QUANTITY_EXCEEDS_RECEIVED", `Goods receipt ${line.receipt.number} changed while returning. Reload it and try again.`, [
        { field: `lines[${line.index}].quantity`, code: "RETURNED_QUANTITY_EXCEEDS_RECEIVED" },
      ]);
    }

    let unitCostMinor = 0;
    let stockValueMinor = 0;
    let quantityAfterMilli: number | null = null;
    if (line.stocked) {
      const applied = await applyMovement(session, {
        organizationId: orgId,
        storeId: store,
        variantId: line.variant._id,
        productId: line.product._id,
        type: "vendor_return",
        before: await readLevel(session, orgId, store, line.variant._id),
        quantityMilli: -line.quantityMilli,
        source: { type: "vendor_return", id: returnId, number },
        reason: input.reason,
        note: line.note,
        createdBy: actor,
        at,
      });
      unitCostMinor = applied.unitCostMinor;
      stockValueMinor = -applied.valueChangeMinor;
      quantityAfterMilli = applied.after.quantityMilli;
    }

    lines.push({
      _id: new mongoose.Types.ObjectId(),
      goodsReceiptId: line.receipt._id,
      goodsReceiptNumber: line.receipt.number,
      goodsReceiptDate: line.receipt.receivedDate,
      goodsReceiptLineId: line.receiptLine._id,
      variantId: line.variant._id,
      productId: line.product._id,
      quantityMilli: line.quantityMilli,
      unbilledQuantityMilli: line.unbilledMilli,
      billId: line.bill?._id ?? null,
      billNumber: line.bill?.number ?? null,
      billLineId: line.billLine?._id ?? null,
      billUnitCostMinor: line.billLine?.unitCostMinor ?? null,
      stocked: line.stocked,
      unitCostMinor,
      stockValueMinor,
      quantityAfterMilli,
      note: line.note,
    });
  }

  // One debit note per bill credited, in the order the bills first appear.
  const creditsByBill = new Map<string, { bill: BillDocument; credits: PlannedCredit[] }>();
  for (const line of planned) {
    if (!line.bill || !line.billLine || line.creditedMilli === 0) continue;
    const key = line.bill._id.toString();
    const group = creditsByBill.get(key) ?? { bill: line.bill, credits: [] };
    // Credited at the bill line's price, never above what the line has left (after price adjustments).
    // A credit that takes the line's last quantity takes all of its remaining subtotal: the pieces
    // round separately and can sum to less than the line's own rounded subtotal.
    const room = creditRoom(line.billLine);
    const subtotalMinor =
      line.creditedMilli === room.quantityMilli
        ? Math.max(0, room.subtotalMinor)
        : Math.min(multiplyMoney(line.billLine.unitCostMinor, fromMilli(line.creditedMilli)), Math.max(0, room.subtotalMinor));
    group.credits.push({ billLine: line.billLine, quantityMilli: line.creditedMilli, subtotalMinor, note: line.note });
    creditsByBill.set(key, group);
  }
  const debitNotes: IVendorReturnDebitNoteRef[] = [];
  for (const { bill, credits } of creditsByBill.values()) {
    const { note } = await postDebitNote(
      {
        organizationId: orgId,
        bill,
        type: "return",
        credits,
        debitNoteDate: returnDate,
        reason: `Goods returned on ${number} (${input.reason})`,
        vendorReference: null,
        notes: input.notes ?? null,
        vendorReturn: { id: returnId, number, storeId: store },
        actor,
        at,
      },
      session
    );
    debitNotes.push({ debitNoteId: note._id, number: note.number, billId: bill._id, billNumber: bill.number, totalMinor: note.totalMinor });
  }

  // Counts toward the vendor's purchase documents, so it cannot be deleted (VENDOR_IN_USE).
  await Vendor.updateOne({ _id: vendor._id, organizationId: orgId }, { $inc: { purchaseDocumentCount: 1 } }, { session });

  const [vendorReturn] = await VendorReturn.create(
    [
      {
        _id: returnId,
        organizationId: orgId,
        storeId: store,
        number,
        sequence,
        vendorId: vendor._id,
        vendorSnapshot: {
          name: vendor.name,
          legalName: vendor.legalName ?? null,
          taxRegistrationNumber: vendor.taxRegistrationNumber ?? null,
          vatTreatment: vendor.vatTreatment,
        },
        returnDate,
        reason: input.reason,
        vendorReference: input.vendorReference ?? null,
        notes: input.notes ?? null,
        lines,
        goodsReceiptIds: [...new Map(planned.map((line) => [line.receipt._id.toString(), line.receipt._id])).values()],
        stockValueMinor: sumMoney(lines.map((line) => line.stockValueMinor)),
        creditMinor: sumMoney(debitNotes.map((ref) => ref.totalMinor)),
        debitNotes,
        createdBy: actor,
        createdAt: at,
      },
    ],
    { session }
  );

  logger.info(`Vendor return posted: ${number} (${returnId}) store=${storeId} vendor=${vendor._id} org=${organizationId} by user=${actorUserId}`);

  const ctx = await viewContext(organizationId, [vendorReturn], true, () => showCost, settings.decimals);
  return { vendorReturn: detailView(ctx, vendorReturn) };
}
