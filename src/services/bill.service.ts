/**
 * Purpose: Vendor Bill Service (Phase 3d).
 * Recording vendor bills (posted on create), voiding them, and reading them.
 *
 * A bill is posted in one transaction (the caller's, see idempotency.service), all or nothing:
 * the bill and its number, each goods line's quantity added to the receipt line's
 * `billedQuantityMilli`, and the vendor's document count. Bills never change stock, its cost or
 * the variants' last purchase cost: a different price is kept as `costVarianceMinor`.
 *
 * Concurrency: a receipt line is raised with a conditional `$inc` that only matches while the
 * line still has room (`billedQuantityMilli <= quantityMilli - billed`); two bills of the same
 * receipt write the same document, so MongoDB aborts one with a transient write conflict and the
 * transaction runs again with fresh reads, where the over-billing check refuses it. Voids and
 * payments write the bill on `{ _id, version }` in the same way.
 *
 * Money is in minor units and quantities in thousandths, as in the stock ledger.
 */

import mongoose from "mongoose";
import { Bill, BillDocument, IBillLine, billDueMinor } from "../models/bill.model";
import { VendorPayment } from "../models/vendorPayment.model";
import { DebitNote } from "../models/debitNote.model";
import { GoodsReceipt, GoodsReceiptDocument, IGoodsReceiptLine, billableMilli } from "../models/goodsReceipt.model";
import { PurchaseOrder, IPurchaseOrderLineTax } from "../models/purchaseOrder.model";
import { nextDocumentNumber } from "./documentNumber.service";
import { Vendor, VendorDocument } from "../models/vendor.model";
import { Product, ProductDocument } from "../models/product.model";
import { ProductVariant, ProductVariantDocument, variantDisplayName } from "../models/productVariant.model";
import { Organization } from "../models/organization.model";
import { TaxRate, TaxRateDocument } from "../models/taxRate.model";
import { ApiError, ApiErrorDetail } from "../utils/ApiError";
import { claimVariants } from "./catalogClaims.service";
import { applyRate, formatMoney, multiplyMoney, parseMoney, sumMoney } from "../utils/money";
import { fromMilli, toMilli } from "../utils/quantity";
import { resolvePaging, buildPaginationMeta } from "../utils/pagination";
import { logger } from "../config/logger.config";
import { getCurrency } from "../config/currencies.config";
import { unitAllowsDecimal } from "../config/units.config";
import { catalogRefs, storeRefs, userRefs, CatalogRefs, StoreRef, UserRef } from "./stock.service";
import { lineTax, taxRatesFor, todayIn } from "./purchaseOrder.service";
import { isCalendarDate } from "../validators/purchaseOrder.validator";
import {
  BILL_STATUSES,
  BillStatus,
  MAX_VAT_ADJUSTMENT_MINOR,
  PAYABLE_BILL_STATUSES,
  CreateBillInput,
  VoidBillInput,
} from "../validators/bill.validator";

type ObjectId = mongoose.Types.ObjectId;
const oid = (id: string | ObjectId) => new mongoose.Types.ObjectId(String(id));

const anyState = { $in: [true, false] };

// ==========================================
// Settings and small helpers
// ==========================================

export interface BillSettings {
  decimals: number;
  /** No TRN: input VAT cannot be reclaimed, so it is part of the cost (costVariance compares totals). */
  vatInCost: boolean;
  /** Today in the organization's timezone (YYYY-MM-DD). */
  today: string;
}

export async function billSettings(organizationId: string): Promise<BillSettings> {
  const organization = await Organization.findById(organizationId).select("settings.currency settings.timezone taxRegistrationNumber");
  if (!organization) {
    throw ApiError.coded(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
  }
  return {
    decimals: getCurrency(organization.settings.currency).decimals,
    vatInCost: !organization.taxRegistrationNumber,
    today: todayIn(organization.settings.timezone || "UTC"),
  };
}

/** A calendar date plus whole days. @example addDays("2026-11-30", 30) === "2026-12-30" */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * The status a bill has once `settledMinor` of its `totalMinor` is settled: payments plus debit
 * note credit (Phase 3e), which count alike.
 */
export function statusForPaid(totalMinor: number, settledMinor: number): BillStatus {
  if (settledMinor >= totalMinor) return "paid";
  return settledMinor > 0 ? "partially_paid" : "unpaid";
}

export function validationError(field: string, message: string): ApiError {
  return ApiError.coded(400, "VALIDATION_FAILED", `Request Validation Failed: ${field}: ${message}`, [
    { field, code: "VALIDATION_FAILED", message },
  ]);
}

/** Many errors at once (one per line), coded and worded after the first. */
export function collected(status: number, errors: ApiErrorDetail[]): ApiError {
  return ApiError.coded(status, errors[0].code!, errors[0].message!, errors);
}

/** An amount that does not fit the currency, as an item error. */
export function parseAmount(text: string, decimals: number, field: string, errors: ApiErrorDetail[]): number | undefined {
  try {
    return parseMoney(text, decimals, field);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const detail = (error.errors[0] ?? {}) as ApiErrorDetail;
    errors.push({ ...detail, field, code: error.code, message: error.message });
    return undefined;
  }
}

export function billNotFound(): ApiError {
  return ApiError.coded(404, "BILL_NOT_FOUND", "Bill not found.");
}

function vatAdjustmentTooLarge(decimals: number): ApiError {
  const limit = formatMoney(MAX_VAT_ADJUSTMENT_MINOR, decimals);
  const message = `vatAdjustment must be between -${limit} and ${limit}, with at most ${decimals} decimal places, and cannot make the bill's VAT negative.`;
  return ApiError.coded(400, "VAT_ADJUSTMENT_TOO_LARGE", message, [
    { field: "vatAdjustment", code: "VAT_ADJUSTMENT_TOO_LARGE", message, meta: { max: limit } },
  ]);
}

function vatAdjustmentWithoutVat(): ApiError {
  const message = "vatAdjustment cannot add VAT to a bill whose lines charge no VAT.";
  return ApiError.coded(400, "VAT_ADJUSTMENT_WITHOUT_VAT", message, [
    { field: "vatAdjustment", code: "VAT_ADJUSTMENT_WITHOUT_VAT", message },
  ]);
}

function parseVatAdjustment(text: string | undefined, decimals: number): number {
  if (text === undefined) return 0;
  let minor: number;
  try {
    minor = parseMoney(text, decimals, "vatAdjustment");
  } catch (error) {
    if (error instanceof ApiError) throw vatAdjustmentTooLarge(decimals);
    throw error;
  }
  if (Math.abs(minor) > MAX_VAT_ADJUSTMENT_MINOR) throw vatAdjustmentTooLarge(decimals);
  return minor;
}

const wholeUnitError = (index: number, unit: string): ApiErrorDetail => {
  const message = `Unit '${unit}' only allows whole quantities.`;
  return {
    field: `lines[${index}].quantity`,
    code: "VALIDATION_FAILED",
    message: `Request Validation Failed: lines[${index}].quantity: ${message}`,
  };
};

// ==========================================
// Views
// ==========================================

export interface BillViewContext {
  decimals: number;
  today: string;
  stores: Map<string, StoreRef>;
  users: Map<string, UserRef>;
  vendors: Map<string, VendorDocument>;
  catalog: CatalogRefs | null;
}

export async function billViewContext(
  organizationId: string,
  bills: BillDocument[],
  withLines: boolean,
  settings?: BillSettings
): Promise<BillViewContext> {
  const lines = withLines ? bills.flatMap((bill) => bill.lines) : [];
  const userIds = bills.flatMap((bill) => [bill.createdBy, bill.voided?.by ?? null]);
  const [resolved, stores, users, vendors, catalog] = await Promise.all([
    settings ?? billSettings(organizationId),
    storeRefs(
      organizationId,
      lines.flatMap((line) => line.storeId ?? [])
    ),
    userRefs(organizationId, userIds),
    bills.length
      ? Vendor.find({ organizationId, _id: { $in: bills.map((bill) => bill.vendorId) }, isDelete: anyState })
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
    decimals: resolved.decimals,
    today: resolved.today,
    stores,
    users,
    vendors: new Map(vendors.map((vendor) => [vendor._id.toString(), vendor])),
    catalog,
  };
}

const userRef = (ctx: BillViewContext, id: ObjectId) => ctx.users.get(id.toString()) ?? { id, name: "(unknown)" };

function billCoreView(ctx: BillViewContext, bill: BillDocument) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  const vendor = ctx.vendors.get(bill.vendorId.toString());
  const snapshot = bill.vendorSnapshot;
  const owed = PAYABLE_BILL_STATUSES.includes(bill.status);
  return {
    id: bill._id,
    number: bill.number,
    status: bill.status,
    vendor: {
      id: bill.vendorId,
      name: snapshot.name,
      legalName: snapshot.legalName ?? null,
      taxRegistrationNumber: snapshot.taxRegistrationNumber ?? null,
      vatTreatment: snapshot.vatTreatment,
      isActive: Boolean(vendor && vendor.isActive && !vendor.isDelete),
    },
    vendorInvoiceNumber: bill.vendorInvoiceNumber,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    overdue: owed && bill.dueDate < ctx.today,
    subtotal: money(bill.subtotalMinor),
    tax: money(bill.taxMinor),
    vatAdjustment: money(bill.vatAdjustmentMinor),
    total: money(bill.totalMinor),
    paid: money(bill.paidMinor),
    balanceDue: money(bill.status === "void" ? 0 : Math.max(0, billDueMinor(bill))),
    credited: money(bill.creditedMinor ?? 0),
    costVariance: money(bill.costVarianceMinor),
    version: bill.version,
    createdBy: userRef(ctx, bill.createdBy),
    createdAt: bill.createdAt,
    updatedAt: bill.updatedAt,
  };
}

export function billSummaryView(ctx: BillViewContext, bill: BillDocument) {
  return { ...billCoreView(ctx, bill), lineCount: bill.lines.length };
}

function billLineView(ctx: BillViewContext, line: IBillLine) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  const catalog = ctx.catalog!;
  return {
    id: line._id,
    kind: line.kind,
    goodsReceipt: line.goodsReceiptId
      ? { id: line.goodsReceiptId, number: line.goodsReceiptNumber ?? "", receivedDate: line.goodsReceiptDate ?? "" }
      : null,
    goodsReceiptLineId: line.goodsReceiptLineId ?? null,
    store: line.storeId ? (ctx.stores.get(line.storeId.toString()) ?? { id: line.storeId, name: "(unknown)", code: "" }) : null,
    variant: catalog.variant(line.variantId),
    product: catalog.product(line.productId),
    quantity: fromMilli(line.quantityMilli),
    unitCost: money(line.unitCostMinor),
    receivedUnitCost: line.receivedUnitCostMinor === null || line.receivedUnitCostMinor === undefined ? null : money(line.receivedUnitCostMinor),
    subtotal: money(line.subtotalMinor),
    tax: {
      taxPreference: line.taxPreference,
      taxRate: line.taxRate ? { id: line.taxRate.id, name: line.taxRate.name, rate: line.taxRate.rate } : null,
      tax: money(line.taxMinor),
    },
    total: money(line.totalMinor),
    costVariance: money(line.costVarianceMinor),
    returnedQuantity: fromMilli(line.returnedQuantityMilli ?? 0),
    credited: money(line.creditedMinor ?? 0),
    note: line.note ?? null,
  };
}

async function billDetailView(organizationId: string, ctx: BillViewContext, bill: BillDocument) {
  const [payments, debitNotes] = await Promise.all([
    VendorPayment.find({ organizationId, "allocations.billId": bill._id }).sort({ sequence: 1 }),
    DebitNote.find({ organizationId, $or: [{ billId: bill._id }, { "applications.billId": bill._id }] }).sort({ sequence: 1 }),
  ]);
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  return {
    ...billCoreView(ctx, bill),
    notes: bill.notes ?? null,
    lines: bill.lines.map((line) => billLineView(ctx, line)),
    payments: payments.map((payment) => ({
      id: payment._id,
      number: payment.number,
      paymentDate: payment.paymentDate,
      method: payment.method,
      amount: money(
        payment.allocations.find((allocation) => allocation.billId.equals(bill._id))?.amountMinor ?? 0
      ),
      status: payment.status,
    })),
    debitNotes: debitNotes.map((note) => ({
      id: note._id,
      number: note.number,
      type: note.type,
      amount: money(
        note.applications.filter((application) => application.billId.equals(bill._id)).reduce((sum, a) => sum + a.amountMinor, 0)
      ),
      status: note.status,
    })),
    voided: bill.voided ? { at: bill.voided.at, by: userRef(ctx, bill.voided.by) } : null,
    voidReason: bill.voidReason ?? null,
  };
}

/** Bill summaries in the given order (payments return the bills they touched). */
export async function toBillSummaries(organizationId: string, bills: BillDocument[], settings?: BillSettings) {
  const ctx = await billViewContext(organizationId, bills, false, settings);
  return bills.map((bill) => billSummaryView(ctx, bill));
}

async function toBillDetail(organizationId: string, bill: BillDocument, settings?: BillSettings) {
  const ctx = await billViewContext(organizationId, [bill], true, settings);
  return billDetailView(organizationId, ctx, bill);
}

// ==========================================
// Reads
// ==========================================

export interface ListBillsQuery {
  search?: string;
  vendorId?: string;
  status?: string;
  overdue?: string;
  goodsReceiptId?: string;
  from?: string;
  to?: string;
  dueFrom?: string;
  dueTo?: string;
  page?: number;
  limit?: number;
}

export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `BILL-0001`, `0001` and the bare prefix (`B`, `BILL`) as a number prefix. */
export function numberPrefix(term: string, prefix: string): string {
  const upper = term.toUpperCase();
  return prefix.startsWith(upper) ? prefix : upper.startsWith(prefix) ? upper : `${prefix}${upper}`;
}

/** Comma-separated values; unrecognised ones are ignored. Undefined when nothing usable is left. */
export function csvFilter<T extends string>(value: string | undefined, allowed: readonly T[]): T[] | undefined {
  if (value === undefined) return undefined;
  const values = value
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is T => (allowed as readonly string[]).includes(part));
  return values.length ? [...new Set(values)] : undefined;
}

/**
 * Lists bills, newest number first. Filters are lenient: a malformed id matches nothing, an
 * invalid date or unknown status is ignored.
 */
export async function listBills(organizationId: string, query: ListBillsQuery) {
  const { page, limit, skip } = resolvePaging(query);
  const empty = () => ({ bills: [], pagination: buildPaginationMeta(page, limit, 0) });
  const settings = await billSettings(organizationId);
  const conditions: Record<string, unknown>[] = [{ organizationId }];

  if (query.vendorId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(query.vendorId)) return empty();
    conditions.push({ vendorId: oid(query.vendorId) });
  }
  if (query.goodsReceiptId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(query.goodsReceiptId)) return empty();
    conditions.push({ goodsReceiptIds: oid(query.goodsReceiptId) });
  }

  const statuses = csvFilter(query.status, BILL_STATUSES);
  if (statuses) conditions.push({ status: { $in: statuses } });
  if (query.overdue === "true") {
    conditions.push({ status: { $in: PAYABLE_BILL_STATUSES }, dueDate: { $lt: settings.today } });
  }

  const dateRange = (field: string, from?: string, to?: string) => {
    const start = from?.trim();
    const end = to?.trim();
    if (start && isCalendarDate(start)) conditions.push({ [field]: { $gte: start } });
    if (end && isCalendarDate(end)) conditions.push({ [field]: { $lte: end } });
  };
  dateRange("billDate", query.from, query.to);
  dateRange("dueDate", query.dueFrom, query.dueTo);

  // A NUL byte makes MongoDB reject the regex (500); no bill text can contain one.
  const term = query.search?.replace(/\0/g, "").trim();
  if (term) {
    conditions.push({
      $or: [
        { number: { $regex: `^${escapeRegex(numberPrefix(term, "BILL-"))}` } },
        { vendorInvoiceNumber: { $regex: `^${escapeRegex(term)}`, $options: "i" } },
      ],
    });
  }

  const filter = { $and: conditions };
  const [total, bills] = await Promise.all([
    Bill.countDocuments(filter),
    Bill.find(filter).sort({ sequence: -1 }).skip(skip).limit(limit),
  ]);
  return {
    bills: await toBillSummaries(organizationId, bills, settings),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

export async function getBill(organizationId: string, billId: string) {
  const bill = await Bill.findOne({ _id: billId, organizationId });
  if (!bill) throw billNotFound();
  return { bill: await toBillDetail(organizationId, bill) };
}

// ==========================================
// Posting: planning the lines
// ==========================================

type RateRef = IPurchaseOrderLineTax["taxRate"];

/** One line, resolved and priced, before anything is written. */
interface PlannedLine {
  index: number;
  receipt: GoodsReceiptDocument | null;
  receiptLine: IGoodsReceiptLine | null;
  variant: ProductVariantDocument;
  product: ProductDocument;
  quantityMilli: number;
  unitCostMinor: number;
  /** The rate before the vendor/product rules: the explicit one, or the default. */
  rate: RateRef;
  note: string | null;
}

const rateRef = (rate: TaxRateDocument): NonNullable<RateRef> => ({ id: rate._id, name: rate.name, rate: rate.rate });

async function loadReceipts(organizationId: string, input: CreateBillInput, session: mongoose.ClientSession) {
  const ids = [...new Set(input.lines.flatMap((line) => (line.goodsReceiptId ? [line.goodsReceiptId.toLowerCase()] : [])))];
  const receipts = ids.length
    ? await GoodsReceipt.find({ organizationId, _id: { $in: ids.map(oid) } }).session(session)
    : [];
  const byId = new Map(receipts.map((receipt) => [receipt._id.toString(), receipt]));

  const missing: ApiErrorDetail[] = [];
  const resolved = input.lines.map((line, index) => {
    if (!line.goodsReceiptId) return null;
    const receipt = byId.get(line.goodsReceiptId.toLowerCase());
    if (!receipt) {
      missing.push({ field: `lines[${index}].goodsReceiptId`, code: "GOODS_RECEIPT_NOT_FOUND", message: "Goods receipt not found." });
      return null;
    }
    const receiptLine = receipt.lines.find((l) => l._id.toString() === line.goodsReceiptLineId!.toLowerCase());
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
  return { resolved, receipts };
}

/** The PO line rates of receipts against a PO: the default VAT rate of their goods lines. */
async function purchaseOrderRates(organizationId: string, receipts: GoodsReceiptDocument[], session: mongoose.ClientSession) {
  const poIds = [...new Set(receipts.flatMap((receipt) => (receipt.purchaseOrderId ? [receipt.purchaseOrderId.toString()] : [])))];
  const rates = new Map<string, RateRef>();
  if (poIds.length === 0) return rates;
  const pos = await PurchaseOrder.find({ organizationId, _id: { $in: poIds.map(oid) } }).session(session);
  for (const po of pos) {
    for (const line of po.lines) rates.set(line._id.toString(), line.taxRate ?? null);
  }
  return rates;
}

async function loadCatalog(organizationId: string, variantIds: ObjectId[]) {
  // Deleted variants are loaded too: a receipt's goods can always be billed. Service lines check.
  const variants = await ProductVariant.find({ organizationId, _id: { $in: variantIds }, isDelete: anyState });
  const products = await Product.find({
    organizationId,
    _id: { $in: variants.map((variant) => variant.productId) },
    isDelete: anyState,
  });
  const productById = new Map(products.map((product) => [product._id.toString(), product]));
  const byVariant = new Map<string, { variant: ProductVariantDocument; product: ProductDocument }>();
  for (const variant of variants) {
    const product = productById.get(variant.productId.toString());
    if (product) byVariant.set(variant._id.toString(), { variant, product });
  }
  return { byVariant, products };
}

async function loadExplicitRates(organizationId: string, input: CreateBillInput) {
  const ids = [...new Set(input.lines.flatMap((line) => (line.taxRateId ? [line.taxRateId.toLowerCase()] : [])))];
  const rates = ids.length ? await TaxRate.find({ organizationId, _id: { $in: ids.map(oid) } }) : [];
  return new Map(rates.map((rate) => [rate._id.toString(), rate]));
}

/**
 * Resolves and prices every line, collecting problems across lines: a receipt from another vendor,
 * a goods product on a service line, unknown variants or tax rates, costs that do not fit the
 * currency, and fractional quantities of whole-number units (400, together).
 */
async function planLines(
  organizationId: string,
  input: CreateBillInput,
  vendor: VendorDocument,
  settings: BillSettings,
  session: mongoose.ClientSession
): Promise<PlannedLine[]> {
  const { resolved, receipts } = await loadReceipts(organizationId, input, session);
  const variantIds = input.lines.map((line, index) => resolved[index]?.receiptLine.variantId ?? oid(line.variantId!));
  const [{ byVariant, products }, poRates, explicitRates] = await Promise.all([
    loadCatalog(organizationId, variantIds),
    purchaseOrderRates(organizationId, receipts, session),
    loadExplicitRates(organizationId, input),
  ]);
  const defaultRates = await taxRatesFor(organizationId, products);

  const errors: ApiErrorDetail[] = [];
  const planned: PlannedLine[] = [];
  input.lines.forEach((line, index) => {
    const goods = resolved[index];
    const entry = byVariant.get(variantIds[index].toString());
    let lineOk = true;

    if (goods) {
      if (!goods.receipt.vendorId.equals(vendor._id)) {
        errors.push({
          field: `lines[${index}].goodsReceiptId`,
          code: "VENDOR_MISMATCH",
          message: `Goods receipt ${goods.receipt.number} is from a different vendor.`,
          meta: { goodsReceiptNumber: goods.receipt.number },
        });
        lineOk = false;
      }
      if (!entry) {
        // Receipts keep their variants (catalog deletes refuse purchase history); defensive only.
        errors.push({ field: `lines[${index}].goodsReceiptLineId`, code: "VARIANT_NOT_FOUND", message: "This line's variant no longer exists." });
        return;
      }
    } else {
      const field = `lines[${index}].variantId`;
      if (!entry || entry.variant.isDelete || entry.product.isDelete) {
        errors.push({ field, code: "VARIANT_NOT_FOUND", message: `Variant '${line.variantId}' not found.` });
        return;
      }
      if (entry.product.type !== "service") {
        errors.push({
          field,
          code: "GOODS_REQUIRE_RECEIPT",
          message: `'${variantDisplayName(entry.product, entry.variant.attributeValues)}' is goods. Receive it first, then bill the goods receipt line.`,
        });
        lineOk = false;
      }
    }

    let rate: RateRef;
    if (line.taxRateId === null) {
      rate = null;
    } else if (line.taxRateId !== undefined) {
      const explicit = explicitRates.get(line.taxRateId.toLowerCase());
      if (!explicit) {
        errors.push({ field: `lines[${index}].taxRateId`, code: "TAX_RATE_NOT_FOUND", message: `Tax rate '${line.taxRateId}' not found.` });
        lineOk = false;
      }
      rate = explicit ? rateRef(explicit) : null;
    } else {
      const poRate = goods?.receiptLine.purchaseOrderLineId ? poRates.get(goods.receiptLine.purchaseOrderLineId.toString()) : null;
      rate = poRate ?? lineTax(entry.product, "vat_registered", defaultRates).taxRate;
    }

    let unitCostMinor: number | undefined;
    if (line.unitCost !== undefined) {
      unitCostMinor = parseAmount(line.unitCost, settings.decimals, `lines[${index}].unitCost`, errors);
      if (unitCostMinor === undefined) lineOk = false;
    } else {
      unitCostMinor = goods!.receiptLine.unitCostMinor;
    }

    // A goods line's quantity defaults to what is left to bill (checked against what was received later).
    const remainingMilli = goods ? billableMilli(goods.receiptLine) : 0;
    const quantityMilli = line.quantity !== undefined ? toMilli(line.quantity) : remainingMilli;
    // Exactly what is left is always accepted, even if the unit has since become whole-number only.
    if (line.quantity !== undefined && !(goods && quantityMilli === remainingMilli) && !unitAllowsDecimal(entry.product.unit) && quantityMilli % 1000 !== 0) {
      errors.push(wholeUnitError(index, entry.product.unit));
      lineOk = false;
    }

    if (!lineOk) return;
    planned.push({
      index,
      receipt: goods?.receipt ?? null,
      receiptLine: goods?.receiptLine ?? null,
      variant: entry.variant,
      product: entry.product,
      quantityMilli,
      unitCostMinor: unitCostMinor!,
      rate,
      note: line.note ?? null,
    });
  });
  if (errors.length > 0) throw collected(400, errors);
  return planned;
}

/** Goods lines that would bill more than was received, all at once (409). */
function assertWithinReceived(planned: PlannedLine[]) {
  const exceeded: ApiErrorDetail[] = [];
  for (const line of planned) {
    if (!line.receiptLine) continue;
    const received = line.receiptLine.quantityMilli;
    const billed = line.receiptLine.billedQuantityMilli ?? 0;
    // Goods returned before being billed can no longer be billed (Phase 3e).
    const remaining = Math.max(0, billableMilli(line.receiptLine));
    if (line.quantityMilli <= 0 || line.quantityMilli > remaining) {
      const name = variantDisplayName(line.product, line.variant.attributeValues);
      exceeded.push({
        field: `lines[${line.index}].quantity`,
        code: "BILLED_QUANTITY_EXCEEDS_RECEIVED",
        message: `More than was received would be billed for '${name}' on ${line.receipt!.number}: ${fromMilli(remaining)} left to bill.`,
        meta: { received: fromMilli(received), billed: fromMilli(billed), remaining: fromMilli(remaining) },
      });
    }
  }
  if (exceeded.length > 0) throw collected(409, exceeded);
}

/** Prices a planned line: subtotal, VAT (vendor and product rules), total and the cost variance. */
function priceLine(line: PlannedLine, vendor: VendorDocument, settings: BillSettings): Omit<IBillLine, "_id"> {
  const quantity = fromMilli(line.quantityMilli);
  const subtotalMinor = multiplyMoney(line.unitCostMinor, quantity);
  const charged = vendor.vatTreatment === "vat_registered" && line.product.taxPreference === "standard";
  const taxRate = charged ? line.rate : null;
  const taxMinor = taxRate ? applyRate(subtotalMinor, taxRate.rate) : 0;
  // sumMoney, not +: a total beyond the safe-integer range is AMOUNT_OUT_OF_RANGE (400), not a database error.
  const totalMinor = sumMoney([subtotalMinor, taxMinor]);

  let costVarianceMinor = 0;
  if (line.receiptLine) {
    costVarianceMinor = settings.vatInCost
      ? sumMoney([totalMinor, -multiplyMoney(line.receiptLine.stockUnitCostMinor, quantity)])
      : sumMoney([subtotalMinor, -multiplyMoney(line.receiptLine.unitCostMinor, quantity)]);
  }

  return {
    kind: line.receiptLine ? "goods" : "service",
    goodsReceiptId: line.receipt?._id ?? null,
    goodsReceiptNumber: line.receipt?.number ?? null,
    goodsReceiptDate: line.receipt?.receivedDate ?? null,
    goodsReceiptLineId: line.receiptLine?._id ?? null,
    storeId: line.receipt?.storeId ?? null,
    variantId: line.variant._id,
    productId: line.product._id,
    quantityMilli: line.quantityMilli,
    unitCostMinor: line.unitCostMinor,
    receivedUnitCostMinor: line.receiptLine?.unitCostMinor ?? null,
    subtotalMinor,
    taxPreference: line.product.taxPreference,
    taxRate: taxRate ? { id: taxRate.id, name: taxRate.name, rate: taxRate.rate } : null,
    taxMinor,
    totalMinor,
    costVarianceMinor,
    returnedQuantityMilli: 0,
    creditedMinor: 0,
    creditedTaxMinor: 0,
    note: line.note,
  };
}

// ==========================================
// Posting
// ==========================================

function duplicateInvoice(bill: { _id: ObjectId; number: string }): ApiError {
  return ApiError.coded(
    409,
    "DUPLICATE_VENDOR_INVOICE",
    `This vendor invoice is already recorded as ${bill.number}. Void that bill first to enter it again.`,
    [{ field: "vendorInvoiceNumber", code: "DUPLICATE_VENDOR_INVOICE", meta: { billId: bill._id, billNumber: bill.number } }]
  );
}

/** Moves a receipt line's billed quantity by `deltaMilli`, never below 0 or above what was received. */
async function moveBilledQuantity(
  organizationId: ObjectId,
  receiptId: ObjectId,
  storeId: ObjectId,
  receiptLineId: ObjectId,
  deltaMilli: number,
  receivedMilli: number,
  session: mongoose.ClientSession
): Promise<boolean> {
  // `$not: { $gt }` also matches receipts posted before Phase 3d, which have no billed quantity.
  const room = deltaMilli > 0 ? { $not: { $gt: receivedMilli - deltaMilli } } : { $gte: -deltaMilli };
  const result = await GoodsReceipt.updateOne(
    { _id: receiptId, organizationId, storeId, lines: { $elemMatch: { _id: receiptLineId, billedQuantityMilli: room } } },
    { $inc: { "lines.$.billedQuantityMilli": deltaMilli } },
    { session }
  );
  return result.matchedCount === 1;
}

/**
 * Records a vendor bill. Runs inside the caller's transaction (see idempotency.service).
 * Checked in this order: the vendor (400), receipts and their lines (404), line problems (400),
 * the VAT adjustment and dates (400), a duplicate invoice number (409), over-billing (409).
 */
export async function createBill(organizationId: string, input: CreateBillInput, actorUserId: string, session: mongoose.ClientSession) {
  const settings = await billSettings(organizationId);
  const orgId = oid(organizationId);

  // Deactivated vendors can still be billed: deactivating does not cancel a debt.
  const vendor = await Vendor.findOne({ _id: oid(input.vendorId), organizationId }).session(session);
  if (!vendor) {
    throw ApiError.coded(400, "VENDOR_NOT_FOUND", "Vendor not found.", [{ field: "vendorId", code: "VENDOR_NOT_FOUND" }]);
  }

  const planned = await planLines(organizationId, input, vendor, settings, session);
  // Goods lines' variants are held by their receipts; service lines claim theirs, so a concurrent
  // product/variant delete conflicts with the bill (catalogClaims.service).
  const serviceLines = planned.filter((line) => !line.receipt);
  const gone = new Set((await claimVariants(organizationId, serviceLines.map((line) => line.variant._id), session)).map(String));
  const missing = serviceLines.flatMap((line): ApiErrorDetail[] =>
    gone.has(line.variant._id.toString())
      ? [{ field: `lines[${line.index}].variantId`, code: "VARIANT_NOT_FOUND", message: `Variant '${line.variant._id}' not found.` }]
      : []
  );
  if (missing.length > 0) throw collected(400, missing);
  const vatAdjustmentMinor = parseVatAdjustment(input.vatAdjustment, settings.decimals);

  const billDate = input.billDate ?? settings.today;
  if (billDate > settings.today) throw validationError("billDate", "billDate cannot be in the future.");
  const latestReceipt = planned.reduce<string | null>(
    (latest, line) => (line.receipt && (!latest || line.receipt.receivedDate > latest) ? line.receipt.receivedDate : latest),
    null
  );
  if (latestReceipt && billDate < latestReceipt) {
    throw validationError("billDate", `billDate cannot be before the latest receivedDate of the receipts billed (${latestReceipt}).`);
  }
  const dueDate = input.dueDate ?? addDays(billDate, vendor.paymentTermsDays ?? 0);
  if (dueDate < billDate) throw validationError("dueDate", "dueDate cannot be before billDate.");

  // Priced before the 409 checks: an adjustment that makes the VAT negative is a 400 and comes first.
  const lines: IBillLine[] = planned.map((line) => ({ _id: new mongoose.Types.ObjectId(), ...priceLine(line, vendor, settings) }));
  const subtotalMinor = sumMoney(lines.map((line) => line.subtotalMinor));
  const linesTaxMinor = sumMoney(lines.map((line) => line.taxMinor));
  // A rounding correction only exists where VAT was charged: adding VAT to a bill whose lines
  // carry none would claim input VAT the invoice does not show (a VAT-return error in the GCC).
  if (linesTaxMinor === 0 && vatAdjustmentMinor > 0) throw vatAdjustmentWithoutVat();
  const taxMinor = sumMoney([linesTaxMinor, vatAdjustmentMinor]);
  if (taxMinor < 0) throw vatAdjustmentTooLarge(settings.decimals);
  const totalMinor = sumMoney([subtotalMinor, taxMinor]);

  const invoiceKey = input.vendorInvoiceNumber.toLowerCase();
  const existing = await Bill.findOne({ organizationId: orgId, vendorId: vendor._id, activeInvoiceKey: invoiceKey })
    .select("number")
    .session(session);
  if (existing) throw duplicateInvoice(existing);

  assertWithinReceived(planned);

  for (const [i, line] of planned.entries()) {
    if (!line.receiptLine) continue;
    const moved = await moveBilledQuantity(
      orgId,
      line.receipt!._id,
      line.receipt!.storeId,
      line.receiptLine._id,
      lines[i].quantityMilli,
      // The ceiling for billed: what was received less what went back unbilled.
      line.receiptLine.quantityMilli - (line.receiptLine.returnedUnbilledMilli ?? 0),
      session
    );
    // The read and this write share the transaction's snapshot, so a concurrent bill normally
    // aborts with a retried write conflict before reaching here.
    if (!moved) assertWithinReceived([{ ...line, quantityMilli: Number.MAX_SAFE_INTEGER }]);
  }

  // Counts toward the vendor's purchase documents, so it cannot be deleted (VENDOR_IN_USE).
  await Vendor.updateOne({ _id: vendor._id, organizationId: orgId }, { $inc: { purchaseDocumentCount: 1 } }, { session });

  const sequence = await nextDocumentNumber({ organizationId: orgId, type: "bill" }, session);
  const number = `BILL-${String(sequence).padStart(5, "0")}`;
  const actor = oid(actorUserId);

  let bill: BillDocument;
  try {
    [bill] = await Bill.create(
      [
        {
          organizationId: orgId,
          number,
          sequence,
          status: totalMinor === 0 ? "paid" : "unpaid",
          vendorId: vendor._id,
          vendorSnapshot: {
            name: vendor.name,
            legalName: vendor.legalName ?? null,
            taxRegistrationNumber: vendor.taxRegistrationNumber ?? null,
            vatTreatment: vendor.vatTreatment,
          },
          vendorInvoiceNumber: input.vendorInvoiceNumber,
          activeInvoiceKey: invoiceKey,
          billDate,
          dueDate,
          notes: input.notes ?? null,
          lines,
          goodsReceiptIds: [...new Map(planned.flatMap((line) => (line.receipt ? [[line.receipt._id.toString(), line.receipt._id]] : []))).values()],
          subtotalMinor,
          taxMinor,
          vatAdjustmentMinor,
          totalMinor,
          paidMinor: 0,
          creditedMinor: 0,
          costVarianceMinor: sumMoney(lines.map((line) => line.costVarianceMinor)),
          version: 1,
          createdBy: actor,
          voided: null,
          voidReason: null,
        },
      ],
      { session }
    );
  } catch (error) {
    const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
    if (dup.code === 11000 && dup.keyPattern?.activeInvoiceKey !== undefined) {
      // Another bill with this invoice number committed between the check and this insert.
      throw ApiError.coded(
        409,
        "DUPLICATE_VENDOR_INVOICE",
        "This vendor invoice was just recorded on another bill. Reload the vendor's bills.",
        [{ field: "vendorInvoiceNumber", code: "DUPLICATE_VENDOR_INVOICE" }]
      );
    }
    throw error;
  }

  logger.info(`Bill recorded: ${number} (${bill._id}) vendor=${vendor._id} org=${organizationId} by user=${actorUserId}`);
  return { bill: await toBillDetail(organizationId, bill, settings) };
}

// ==========================================
// Void
// ==========================================

/**
 * Voids a bill with no payments (that are not void). Gives the receipt lines their billed
 * quantities back and frees the vendor invoice number. The vendor keeps counting it.
 */
export async function voidBill(
  organizationId: string,
  billId: string,
  input: VoidBillInput,
  actorUserId: string,
  session: mongoose.ClientSession
) {
  const orgId = oid(organizationId);
  const bill = await Bill.findOne({ _id: billId, organizationId: orgId }).session(session);
  if (!bill) throw billNotFound();
  if (bill.version !== input.version) {
    throw ApiError.coded(409, "BILL_VERSION_CONFLICT", "This bill was changed by someone else. Reload it and try again.", [
      { field: "version", code: "BILL_VERSION_CONFLICT", meta: { currentVersion: bill.version } },
    ]);
  }
  if (bill.status === "void") {
    throw ApiError.coded(409, "BILL_STATUS_CONFLICT", "This bill is already void.", [
      { code: "BILL_STATUS_CONFLICT", meta: { status: bill.status } },
    ]);
  }
  const payments = await VendorPayment.find({ organizationId: orgId, "allocations.billId": bill._id, status: "posted" })
    .sort({ sequence: 1 })
    .select("number")
    .session(session);
  if (payments.length > 0) {
    const numbers = payments.map((payment) => payment.number);
    throw ApiError.coded(409, "BILL_HAS_PAYMENTS", `This bill has payments (${numbers.join(", ")}). Void them first.`, [
      { code: "BILL_HAS_PAYMENTS", meta: { payments: numbers } },
    ]);
  }
  // A debit note credited it (its own note, or spare credit applied to it): a return's credit is
  // final, and a price adjustment must be voided first.
  const credits = await DebitNote.find({
    organizationId: orgId,
    status: { $ne: "void" },
    $or: [{ billId: bill._id }, { "applications.billId": bill._id }],
  })
    .sort({ sequence: 1 })
    .select("number")
    .session(session);
  if (credits.length > 0) {
    const numbers = credits.map((note) => note.number);
    throw ApiError.coded(409, "BILL_HAS_CREDITS", `This bill has debit notes (${numbers.join(", ")}), so it cannot be voided.`, [
      { code: "BILL_HAS_CREDITS", meta: { debitNotes: numbers } },
    ]);
  }

  for (const line of bill.lines) {
    if (!line.goodsReceiptId || !line.goodsReceiptLineId || !line.storeId) continue;
    const moved = await moveBilledQuantity(orgId, line.goodsReceiptId, line.storeId, line.goodsReceiptLineId, -line.quantityMilli, 0, session);
    if (!moved) {
      throw new Error(`Bill ${bill.number}: receipt line ${line.goodsReceiptLineId} has less billed than this bill's line.`);
    }
  }

  const updated = await Bill.findOneAndUpdate(
    { _id: bill._id, organizationId: orgId, version: bill.version },
    {
      $set: { status: "void", activeInvoiceKey: null, voided: { at: new Date(), by: oid(actorUserId) }, voidReason: input.reason },
      $inc: { version: 1 },
    },
    { new: true, session }
  );
  if (!updated) {
    throw ApiError.coded(409, "BILL_VERSION_CONFLICT", "This bill was changed by someone else. Reload it and try again.", [
      { field: "version", code: "BILL_VERSION_CONFLICT" },
    ]);
  }

  logger.info(`Bill voided: ${bill.number} (${bill._id}) org=${organizationId} by user=${actorUserId}`);
  return { bill: await toBillDetail(organizationId, updated) };
}

/** Variants on any bill (service lines leave no other trace): the catalog cannot delete them. */
export async function variantsOnBills(organizationId: string, variantIds: ObjectId[], session?: mongoose.ClientSession): Promise<boolean> {
  if (variantIds.length === 0) return false;
  return (await Bill.exists({ organizationId, "lines.variantId": { $in: variantIds } }).session(session ?? null)) !== null;
}
