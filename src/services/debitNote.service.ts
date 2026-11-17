/**
 * Purpose: Debit Note Service (Phase 3e).
 * Credit from a vendor against one bill: posting it (from a vendor return, or a price adjustment
 * on its own), applying spare credit to the vendor's other open bills, voiding price adjustments,
 * and reading them.
 *
 * Posting a note, in the caller's transaction (see idempotency.service), all or nothing:
 * - each line's credit is added to its bill line (`creditedMinor`, `creditedTaxMinor`, and for
 *   returns `returnedQuantityMilli`), so a bill line is never credited above its subtotal and VAT;
 * - the note's total is applied to its own bill as far as the bill still owes (`creditedMinor`,
 *   `status`); the rest stays on the note as vendor credit;
 * - the vendor's document count goes up, and the note takes its DN- number.
 *
 * Concurrency: every bill is read in the transaction and written on `{ _id, version }`, as
 * payments do, so a payment or another note racing for the same bill conflicts and the
 * transaction runs again with fresh reads. Notes are written on `{ _id, version }` too.
 *
 * Money is in minor units and quantities in thousandths.
 */

import mongoose from "mongoose";
import { Bill, BillDocument, IBillLine, billDueMinor } from "../models/bill.model";
import { DebitNote, DebitNoteDocument, IDebitNoteLine } from "../models/debitNote.model";
import { DocumentCounter } from "../models/documentCounter.model";
import { Vendor, VendorDocument } from "../models/vendor.model";
import { ApiError, ApiErrorDetail } from "../utils/ApiError";
import { applyRate, formatMoney, sumMoney } from "../utils/money";
import { fromMilli } from "../utils/quantity";
import { resolvePaging, buildPaginationMeta } from "../utils/pagination";
import { logger } from "../config/logger.config";
import { catalogRefs, storeRefs, userRefs, CatalogRefs, StoreRef, UserRef } from "./stock.service";
import {
  BillSettings,
  billSettings,
  collected,
  csvFilter,
  escapeRegex,
  numberPrefix,
  parseAmount,
  statusForPaid,
  toBillSummaries,
  validationError,
} from "./bill.service";
import { isCalendarDate } from "../validators/purchaseOrder.validator";
import { PAYABLE_BILL_STATUSES } from "../validators/bill.validator";
import {
  DEBIT_NOTE_STATUSES,
  DEBIT_NOTE_TYPES,
  ApplyDebitNoteInput,
  CreateDebitNoteInput,
  DebitNoteType,
  VoidDebitNoteInput,
} from "../validators/vendorReturn.validator";

type ObjectId = mongoose.Types.ObjectId;
const oid = (id: string | ObjectId) => new mongoose.Types.ObjectId(String(id));

const anyState = { $in: [true, false] };

// ==========================================
// Errors
// ==========================================

export function debitNoteNotFound(): ApiError {
  return ApiError.coded(404, "DEBIT_NOTE_NOT_FOUND", "Debit note not found.");
}

function versionConflict(currentVersion?: number): ApiError {
  return ApiError.coded(409, "DEBIT_NOTE_VERSION_CONFLICT", "This debit note was changed by someone else. Reload it and try again.", [
    { field: "version", code: "DEBIT_NOTE_VERSION_CONFLICT", ...(currentVersion === undefined ? {} : { meta: { currentVersion } }) },
  ]);
}

export function billChanged(field: string): ApiError {
  return ApiError.coded(409, "BILL_STATUS_CONFLICT", "A bill changed while the credit was being recorded. Reload it and try again.", [
    { field, code: "BILL_STATUS_CONFLICT" },
  ]);
}

// ==========================================
// Crediting bill lines
// ==========================================

/** What a bill line can still be credited: VAT-exclusive subtotal and its VAT. */
export function creditRoom(line: IBillLine) {
  return {
    subtotalMinor: line.subtotalMinor - (line.creditedMinor ?? 0),
    taxMinor: line.taxMinor - (line.creditedTaxMinor ?? 0),
    quantityMilli: line.quantityMilli - (line.returnedQuantityMilli ?? 0),
  };
}

/**
 * VAT on a credit of `subtotalMinor` (≤ the line's room) at the bill line's rate. Never above the
 * line's VAT not yet credited, and exactly that when the credit takes the rest of the subtotal,
 * so a fully credited line gives back exactly the VAT it charged.
 */
export function creditTax(line: IBillLine, subtotalMinor: number): number {
  const room = creditRoom(line);
  if (subtotalMinor >= room.subtotalMinor) return Math.max(0, room.taxMinor);
  const tax = line.taxRate ? applyRate(subtotalMinor, line.taxRate.rate) : 0;
  return Math.max(0, Math.min(tax, room.taxMinor));
}

/** One line of a note being posted. */
export interface PlannedCredit {
  billLine: IBillLine;
  /** Return notes: the quantity credited; null for a price adjustment. */
  quantityMilli: number | null;
  subtotalMinor: number;
  note: string | null;
}

export interface PostDebitNoteInput {
  organizationId: ObjectId;
  bill: BillDocument;
  type: DebitNoteType;
  credits: PlannedCredit[];
  debitNoteDate: string;
  reason: string;
  vendorReference: string | null;
  notes: string | null;
  vendorReturn: { id: ObjectId; number: string; storeId: ObjectId } | null;
  actor: ObjectId;
  at: Date;
}

/**
 * Posts one debit note against its bill: credits the bill lines, applies what the bill still owes,
 * counts the note on the vendor and numbers it. The caller has checked the bill is not void and
 * every credit fits its line (creditRoom). Returns the note and the bill after the change.
 */
export async function postDebitNote(
  input: PostDebitNoteInput,
  session: mongoose.ClientSession
): Promise<{ note: DebitNoteDocument; bill: BillDocument }> {
  const { organizationId, bill, actor, at } = input;

  const lines: IDebitNoteLine[] = input.credits.map((credit) => {
    const taxMinor = creditTax(credit.billLine, credit.subtotalMinor);
    return {
      _id: new mongoose.Types.ObjectId(),
      billLineId: credit.billLine._id,
      variantId: credit.billLine.variantId,
      productId: credit.billLine.productId,
      quantityMilli: credit.quantityMilli,
      unitCostMinor: credit.quantityMilli === null ? null : credit.billLine.unitCostMinor,
      subtotalMinor: credit.subtotalMinor,
      taxRate: credit.billLine.taxRate ?? null,
      taxMinor,
      totalMinor: sumMoney([credit.subtotalMinor, taxMinor]),
      note: credit.note,
    };
  });
  const subtotalMinor = sumMoney(lines.map((line) => line.subtotalMinor));
  const taxMinor = sumMoney(lines.map((line) => line.taxMinor));
  const totalMinor = sumMoney([subtotalMinor, taxMinor]);

  // The credit goes to its own bill first, as far as the bill still owes; the rest is vendor credit.
  const payable = PAYABLE_BILL_STATUSES.includes(bill.status);
  const appliedMinor = payable ? Math.max(0, Math.min(totalMinor, billDueMinor(bill))) : 0;
  const creditedMinor = (bill.creditedMinor ?? 0) + appliedMinor;

  const inc: Record<string, number> = { version: 1 };
  if (appliedMinor > 0) inc.creditedMinor = appliedMinor;
  const arrayFilters = lines.map((line, i) => {
    inc[`lines.$[l${i}].creditedMinor`] = line.subtotalMinor;
    inc[`lines.$[l${i}].creditedTaxMinor`] = line.taxMinor;
    if (line.quantityMilli !== null) inc[`lines.$[l${i}].returnedQuantityMilli`] = line.quantityMilli;
    return { [`l${i}._id`]: line.billLineId };
  });
  const updatedBill = await Bill.findOneAndUpdate(
    { _id: bill._id, organizationId, version: bill.version, status: { $ne: "void" } },
    {
      $set: { status: payable ? statusForPaid(bill.totalMinor, bill.paidMinor + creditedMinor) : bill.status },
      $inc: inc,
    },
    { new: true, session, arrayFilters }
  );
  // Reads and writes share the transaction's snapshot: a concurrent change normally aborts with a
  // retried write conflict before reaching here.
  if (!updatedBill) throw billChanged("billId");

  await Vendor.updateOne({ _id: bill.vendorId, organizationId }, { $inc: { purchaseDocumentCount: 1 } }, { session });

  const counter = await DocumentCounter.findOneAndUpdate(
    { organizationId, type: "debit_note" },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );
  const sequence = counter!.seq;
  const number = `DN-${String(sequence).padStart(5, "0")}`;

  const [note] = await DebitNote.create(
    [
      {
        organizationId,
        number,
        sequence,
        type: input.type,
        status: appliedMinor < totalMinor ? "open" : "applied",
        vendorId: bill.vendorId,
        vendorSnapshot: bill.vendorSnapshot,
        billId: bill._id,
        billNumber: bill.number,
        vendorInvoiceNumber: bill.vendorInvoiceNumber,
        billDate: bill.billDate,
        vendorReturnId: input.vendorReturn?.id ?? null,
        vendorReturnNumber: input.vendorReturn?.number ?? null,
        storeId: input.vendorReturn?.storeId ?? null,
        debitNoteDate: input.debitNoteDate,
        vendorReference: input.vendorReference,
        reason: input.reason,
        notes: input.notes,
        lines,
        subtotalMinor,
        taxMinor,
        totalMinor,
        appliedMinor,
        applications:
          appliedMinor > 0
            ? [
                {
                  _id: new mongoose.Types.ObjectId(),
                  billId: bill._id,
                  billNumber: bill.number,
                  vendorInvoiceNumber: bill.vendorInvoiceNumber,
                  amountMinor: appliedMinor,
                  at,
                  by: actor,
                },
              ]
            : [],
        version: 1,
        createdBy: actor,
        voided: null,
        voidReason: null,
      },
    ],
    { session }
  );

  logger.info(`Debit note posted: ${number} (${note._id}) type=${input.type} bill=${bill.number} org=${organizationId} by user=${actor}`);
  return { note, bill: updatedBill };
}

// ==========================================
// Views
// ==========================================

interface ViewContext {
  decimals: number;
  users: Map<string, UserRef>;
  stores: Map<string, StoreRef>;
  vendors: Map<string, VendorDocument>;
  catalog: CatalogRefs | null;
}

async function viewContext(organizationId: string, notes: DebitNoteDocument[], withLines: boolean, settings?: BillSettings): Promise<ViewContext> {
  const lines = withLines ? notes.flatMap((note) => note.lines) : [];
  const userIds = notes.flatMap((note) => [
    note.createdBy,
    ...(note.voided ? [note.voided.by] : []),
    ...(withLines ? note.applications.map((a) => a.by) : []),
  ]);
  const [resolved, users, stores, vendors, catalog] = await Promise.all([
    settings ?? billSettings(organizationId),
    userRefs(organizationId, userIds),
    storeRefs(organizationId, notes.flatMap((note) => note.storeId ?? [])),
    notes.length
      ? Vendor.find({ organizationId, _id: { $in: notes.map((note) => note.vendorId) }, isDelete: anyState })
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
    users,
    stores,
    vendors: new Map(vendors.map((vendor) => [vendor._id.toString(), vendor])),
    catalog,
  };
}

const userRef = (ctx: ViewContext, id: ObjectId) => ctx.users.get(id.toString()) ?? { id, name: "(unknown)" };

function coreView(ctx: ViewContext, note: DebitNoteDocument) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  const vendor = ctx.vendors.get(note.vendorId.toString());
  const snapshot = note.vendorSnapshot;
  const isVoid = note.status === "void";
  return {
    id: note._id,
    number: note.number,
    type: note.type,
    status: note.status,
    vendor: {
      id: note.vendorId,
      name: snapshot.name,
      legalName: snapshot.legalName ?? null,
      taxRegistrationNumber: snapshot.taxRegistrationNumber ?? null,
      vatTreatment: snapshot.vatTreatment,
      isActive: Boolean(vendor && vendor.isActive && !vendor.isDelete),
    },
    bill: { id: note.billId, number: note.billNumber, vendorInvoiceNumber: note.vendorInvoiceNumber, billDate: note.billDate },
    vendorReturn:
      note.vendorReturnId && note.storeId
        ? {
            id: note.vendorReturnId,
            number: note.vendorReturnNumber ?? "",
            store: ctx.stores.get(note.storeId.toString()) ?? { id: note.storeId, name: "(unknown)", code: "" },
          }
        : null,
    debitNoteDate: note.debitNoteDate,
    vendorReference: note.vendorReference ?? null,
    reason: note.reason,
    subtotal: money(note.subtotalMinor),
    tax: money(note.taxMinor),
    total: money(note.totalMinor),
    applied: money(isVoid ? 0 : note.appliedMinor),
    unapplied: money(isVoid ? 0 : note.totalMinor - note.appliedMinor),
    version: note.version,
    createdBy: userRef(ctx, note.createdBy),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function summaryView(ctx: ViewContext, note: DebitNoteDocument) {
  return { ...coreView(ctx, note), lineCount: note.lines.length };
}

function detailView(ctx: ViewContext, note: DebitNoteDocument) {
  const money = (minor: number) => formatMoney(minor, ctx.decimals);
  const catalog = ctx.catalog!;
  return {
    ...coreView(ctx, note),
    notes: note.notes ?? null,
    lines: note.lines.map((line) => ({
      id: line._id,
      billLineId: line.billLineId,
      variant: catalog.variant(line.variantId),
      product: catalog.product(line.productId),
      quantity: line.quantityMilli === null || line.quantityMilli === undefined ? null : fromMilli(line.quantityMilli),
      unitCost: line.unitCostMinor === null || line.unitCostMinor === undefined ? null : money(line.unitCostMinor),
      subtotal: money(line.subtotalMinor),
      tax: {
        taxRate: line.taxRate ? { id: line.taxRate.id, name: line.taxRate.name, rate: line.taxRate.rate } : null,
        tax: money(line.taxMinor),
      },
      total: money(line.totalMinor),
      note: line.note ?? null,
    })),
    applications: note.applications.map((application) => ({
      bill: { id: application.billId, number: application.billNumber, vendorInvoiceNumber: application.vendorInvoiceNumber },
      amount: money(application.amountMinor),
      appliedAt: application.at,
      appliedBy: userRef(ctx, application.by),
    })),
    voided: note.voided ? { at: note.voided.at, by: userRef(ctx, note.voided.by) } : null,
    voidReason: note.voidReason ?? null,
  };
}

async function toData(organizationId: string, note: DebitNoteDocument, bills: BillDocument[], settings?: BillSettings) {
  const resolved = settings ?? (await billSettings(organizationId));
  const ctx = await viewContext(organizationId, [note], true, resolved);
  return { debitNote: detailView(ctx, note), bills: await toBillSummaries(organizationId, bills, resolved) };
}

// ==========================================
// Reads
// ==========================================

export interface ListDebitNotesQuery {
  search?: string;
  vendorId?: string;
  billId?: string;
  vendorReturnId?: string;
  type?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

/** Lists debit notes, newest number first. Filters are lenient, as for bills. */
export async function listDebitNotes(organizationId: string, query: ListDebitNotesQuery) {
  const { page, limit, skip } = resolvePaging(query);
  const empty = () => ({ debitNotes: [], pagination: buildPaginationMeta(page, limit, 0) });
  const conditions: Record<string, unknown>[] = [{ organizationId }];

  for (const field of ["vendorId", "vendorReturnId"] as const) {
    const value = query[field];
    if (value === undefined) continue;
    if (!mongoose.Types.ObjectId.isValid(value)) return empty();
    conditions.push({ [field]: oid(value) });
  }
  if (query.billId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(query.billId)) return empty();
    const billId = oid(query.billId);
    conditions.push({ $or: [{ billId }, { "applications.billId": billId }] });
  }
  const types = csvFilter(query.type, DEBIT_NOTE_TYPES);
  if (types) conditions.push({ type: { $in: types } });
  const statuses = csvFilter(query.status, DEBIT_NOTE_STATUSES);
  if (statuses) conditions.push({ status: { $in: statuses } });

  const from = query.from?.trim();
  const to = query.to?.trim();
  if (from && isCalendarDate(from)) conditions.push({ debitNoteDate: { $gte: from } });
  if (to && isCalendarDate(to)) conditions.push({ debitNoteDate: { $lte: to } });

  // A NUL byte makes MongoDB reject the regex (500); no note text can contain one.
  const term = query.search?.replace(/\0/g, "").trim();
  if (term) {
    conditions.push({
      $or: [
        { number: { $regex: `^${escapeRegex(numberPrefix(term, "DN-"))}` } },
        { vendorReference: { $regex: `^${escapeRegex(term)}`, $options: "i" } },
      ],
    });
  }

  const filter = { $and: conditions };
  const [total, notes] = await Promise.all([
    DebitNote.countDocuments(filter),
    DebitNote.find(filter).sort({ sequence: -1 }).skip(skip).limit(limit),
  ]);
  const ctx = await viewContext(organizationId, notes, false);
  return { debitNotes: notes.map((note) => summaryView(ctx, note)), pagination: buildPaginationMeta(page, limit, total) };
}

export async function getDebitNote(organizationId: string, debitNoteId: string) {
  const note = await DebitNote.findOne({ _id: debitNoteId, organizationId });
  if (!note) throw debitNoteNotFound();
  const ctx = await viewContext(organizationId, [note], true);
  return { debitNote: detailView(ctx, note), bills: [] };
}

// ==========================================
// Price adjustments
// ==========================================

/**
 * Records a price adjustment debit note against one bill. Runs inside the caller's transaction.
 * Checked in this order: the bill and its lines (404), amounts and the date (400), a void bill
 * (409), credit above what a line has left (409).
 */
export async function createDebitNote(organizationId: string, input: CreateDebitNoteInput, actorUserId: string, session: mongoose.ClientSession) {
  const settings = await billSettings(organizationId);
  const orgId = oid(organizationId);

  const bill = await Bill.findOne({ _id: oid(input.billId), organizationId: orgId }).session(session);
  if (!bill) throw ApiError.coded(404, "BILL_NOT_FOUND", "Bill not found.", [{ field: "billId", code: "BILL_NOT_FOUND" }]);

  const missing: ApiErrorDetail[] = [];
  const billLines = input.lines.map((line, i) => {
    const billLine = bill.lines.find((l) => l._id.toString() === line.billLineId.toLowerCase());
    if (!billLine) {
      missing.push({ field: `lines[${i}].billLineId`, code: "BILL_NOT_FOUND", message: `Bill ${bill.number} has no line '${line.billLineId}'.` });
    }
    return billLine!;
  });
  if (missing.length > 0) throw collected(404, missing);

  const amountErrors: ApiErrorDetail[] = [];
  const amounts = input.lines.map((line, i) => parseAmount(line.amount, settings.decimals, `lines[${i}].amount`, amountErrors));
  if (amountErrors.length > 0) throw collected(400, amountErrors);

  const debitNoteDate = input.debitNoteDate ?? settings.today;
  if (debitNoteDate > settings.today) throw validationError("debitNoteDate", "debitNoteDate cannot be in the future.");
  if (debitNoteDate < bill.billDate) {
    throw validationError("debitNoteDate", `debitNoteDate cannot be before the bill's billDate (${bill.billDate}).`);
  }

  if (bill.status === "void") {
    throw ApiError.coded(409, "BILL_STATUS_CONFLICT", `Bill ${bill.number} is void, so it cannot be credited.`, [
      { field: "billId", code: "BILL_STATUS_CONFLICT", meta: { status: bill.status } },
    ]);
  }

  const exceeded: ApiErrorDetail[] = [];
  billLines.forEach((billLine, i) => {
    const room = creditRoom(billLine).subtotalMinor;
    if (amounts[i]! > room) {
      const money = (minor: number) => formatMoney(minor, settings.decimals);
      exceeded.push({
        field: `lines[${i}].amount`,
        code: "CREDIT_EXCEEDS_BILLED",
        message: `This would credit more than was billed on the line (${money(Math.max(0, room))} left).`,
        meta: { subtotal: money(billLine.subtotalMinor), credited: money(billLine.creditedMinor ?? 0), remaining: money(Math.max(0, room)) },
      });
    }
  });
  if (exceeded.length > 0) throw collected(409, exceeded);

  const { note, bill: updated } = await postDebitNote(
    {
      organizationId: orgId,
      bill,
      type: "price_adjustment",
      credits: billLines.map((billLine, i) => ({ billLine, quantityMilli: null, subtotalMinor: amounts[i]!, note: input.lines[i].note ?? null })),
      debitNoteDate,
      reason: input.reason,
      vendorReference: input.vendorReference ?? null,
      notes: input.notes ?? null,
      vendorReturn: null,
      actor: oid(actorUserId),
      at: new Date(),
    },
    session
  );
  return toData(organizationId, note, [updated], settings);
}

// ==========================================
// Applying spare credit
// ==========================================

/** Applies a note's unapplied credit to other open bills of the same vendor. */
export async function applyDebitNote(
  organizationId: string,
  debitNoteId: string,
  input: ApplyDebitNoteInput,
  actorUserId: string,
  session: mongoose.ClientSession
) {
  const settings = await billSettings(organizationId);
  const orgId = oid(organizationId);
  const money = (minor: number) => formatMoney(minor, settings.decimals);

  const note = await DebitNote.findOne({ _id: debitNoteId, organizationId: orgId }).session(session);
  if (!note) throw debitNoteNotFound();

  const amountErrors: ApiErrorDetail[] = [];
  const amounts = input.applications.map((a, i) => parseAmount(a.amount, settings.decimals, `applications[${i}].amount`, amountErrors));
  if (amountErrors.length > 0) throw collected(400, amountErrors);

  const bills = await Bill.find({ organizationId: orgId, _id: { $in: input.applications.map((a) => oid(a.billId)) } }).session(session);
  const billById = new Map(bills.map((bill) => [bill._id.toString(), bill]));
  const missing: ApiErrorDetail[] = [];
  const targets = input.applications.map((a, i) => {
    const bill = billById.get(a.billId.toLowerCase());
    if (!bill) missing.push({ field: `applications[${i}].billId`, code: "BILL_NOT_FOUND", message: "Bill not found." });
    return bill!;
  });
  if (missing.length > 0) throw collected(404, missing);

  const mismatched: ApiErrorDetail[] = [];
  targets.forEach((bill, i) => {
    if (!bill.vendorId.equals(note.vendorId)) {
      mismatched.push({
        field: `applications[${i}].billId`,
        code: "VENDOR_MISMATCH",
        message: `Bill ${bill.number} is from a different vendor.`,
        meta: { billNumber: bill.number },
      });
    }
  });
  if (mismatched.length > 0) throw collected(400, mismatched);

  if (note.version !== input.version) throw versionConflict(note.version);
  const unappliedMinor = note.totalMinor - note.appliedMinor;
  if (note.status !== "open" || unappliedMinor <= 0) {
    const message = note.status === "void" ? "This debit note is void." : "This debit note has no credit left to apply.";
    throw ApiError.coded(409, "DEBIT_NOTE_STATUS_CONFLICT", message, [{ code: "DEBIT_NOTE_STATUS_CONFLICT", meta: { status: note.status } }]);
  }
  const requested = sumMoney(amounts as number[]);
  if (requested > unappliedMinor) {
    throw ApiError.coded(409, "CREDIT_EXCEEDS_AVAILABLE", `This credit is more than the debit note has left (${money(unappliedMinor)}).`, [
      { field: "applications", code: "CREDIT_EXCEEDS_AVAILABLE", meta: { unapplied: money(unappliedMinor) } },
    ]);
  }

  const unpayable: ApiErrorDetail[] = [];
  targets.forEach((bill, i) => {
    if (!PAYABLE_BILL_STATUSES.includes(bill.status)) {
      unpayable.push({
        field: `applications[${i}].billId`,
        code: "BILL_STATUS_CONFLICT",
        message: `Bill ${bill.number} is ${bill.status.replace("_", " ")}, so credit cannot be applied to it.`,
        meta: { status: bill.status },
      });
    }
  });
  if (unpayable.length > 0) throw collected(409, unpayable);

  const exceeded: ApiErrorDetail[] = [];
  targets.forEach((bill, i) => {
    const due = billDueMinor(bill);
    if (amounts[i]! > due) {
      exceeded.push({
        field: `applications[${i}].amount`,
        code: "CREDIT_EXCEEDS_DUE",
        message: `This credit is more than is still due on ${bill.number} (${money(due)}).`,
        meta: { balanceDue: money(due) },
      });
    }
  });
  if (exceeded.length > 0) throw collected(409, exceeded);

  const updatedBills: BillDocument[] = [];
  for (const [i, bill] of targets.entries()) {
    const amount = amounts[i]!;
    const updated = await Bill.findOneAndUpdate(
      { _id: bill._id, organizationId: orgId, version: bill.version, status: { $in: PAYABLE_BILL_STATUSES } },
      {
        $set: { status: statusForPaid(bill.totalMinor, bill.paidMinor + (bill.creditedMinor ?? 0) + amount) },
        $inc: { creditedMinor: amount, version: 1 },
      },
      { new: true, session }
    );
    if (!updated) throw billChanged(`applications[${i}].billId`);
    updatedBills.push(updated);
  }

  const at = new Date();
  const actor = oid(actorUserId);
  const appliedMinor = note.appliedMinor + requested;
  const updatedNote = await DebitNote.findOneAndUpdate(
    { _id: note._id, organizationId: orgId, version: note.version, status: "open" },
    {
      $set: { status: appliedMinor < note.totalMinor ? "open" : "applied" },
      $inc: { appliedMinor: requested, version: 1 },
      $push: {
        applications: {
          $each: targets.map((bill, i) => ({
            _id: new mongoose.Types.ObjectId(),
            billId: bill._id,
            billNumber: bill.number,
            vendorInvoiceNumber: bill.vendorInvoiceNumber,
            amountMinor: amounts[i]!,
            at,
            by: actor,
          })),
        },
      },
    },
    { new: true, session }
  );
  if (!updatedNote) throw versionConflict();

  logger.info(`Debit note applied: ${note.number} (${note._id}) to ${targets.map((b) => b.number).join(", ")} org=${organizationId} by user=${actorUserId}`);
  return toData(organizationId, updatedNote, updatedBills, settings);
}

// ==========================================
// Void (price adjustments only)
// ==========================================

/**
 * Voids a price adjustment: every application is reversed (each bill's credited and status) and
 * its own bill's lines give the credit back. A return's note is final.
 */
export async function voidDebitNote(
  organizationId: string,
  debitNoteId: string,
  input: VoidDebitNoteInput,
  actorUserId: string,
  session: mongoose.ClientSession
) {
  const orgId = oid(organizationId);
  const note = await DebitNote.findOne({ _id: debitNoteId, organizationId: orgId }).session(session);
  if (!note) throw debitNoteNotFound();
  if (note.version !== input.version) throw versionConflict(note.version);
  if (note.status === "void") {
    throw ApiError.coded(409, "DEBIT_NOTE_STATUS_CONFLICT", "This debit note is already void.", [
      { code: "DEBIT_NOTE_STATUS_CONFLICT", meta: { status: note.status } },
    ]);
  }
  if (note.type === "return") {
    throw ApiError.coded(409, "DEBIT_NOTE_FROM_RETURN", `This debit note was created by ${note.vendorReturnNumber}: the goods went back, so it cannot be voided.`, [
      { code: "DEBIT_NOTE_FROM_RETURN", meta: { vendorReturnNumber: note.vendorReturnNumber } },
    ]);
  }

  // Credit to give back per bill; the note's own bill also gives back its lines' credit.
  const creditByBill = new Map<string, number>();
  for (const application of note.applications) {
    const key = application.billId.toString();
    creditByBill.set(key, (creditByBill.get(key) ?? 0) + application.amountMinor);
  }
  if (!creditByBill.has(note.billId.toString())) creditByBill.set(note.billId.toString(), 0);

  const updatedBills: BillDocument[] = [];
  for (const [billId, amount] of creditByBill) {
    const bill = await Bill.findOne({ _id: oid(billId), organizationId: orgId }).session(session);
    // A bill credited by a note that is not void cannot be voided, and credit only grows by applications.
    if (!bill || bill.status === "void" || (bill.creditedMinor ?? 0) < amount) {
      throw new Error(`Debit note ${note.number}: bill ${billId} does not hold this credit.`);
    }
    const inc: Record<string, number> = { version: 1 };
    if (amount > 0) inc.creditedMinor = -amount;
    let arrayFilters: Record<string, ObjectId>[] | undefined;
    if (bill._id.equals(note.billId)) {
      arrayFilters = note.lines.map((line, i) => {
        inc[`lines.$[l${i}].creditedMinor`] = -line.subtotalMinor;
        inc[`lines.$[l${i}].creditedTaxMinor`] = -line.taxMinor;
        return { [`l${i}._id`]: line.billLineId };
      });
    }
    const updated = await Bill.findOneAndUpdate(
      { _id: bill._id, organizationId: orgId, version: bill.version },
      { $set: { status: statusForPaid(bill.totalMinor, bill.paidMinor + (bill.creditedMinor ?? 0) - amount) }, $inc: inc },
      { new: true, session, ...(arrayFilters ? { arrayFilters } : {}) }
    );
    if (!updated) throw billChanged("debitNoteId");
    updatedBills.push(updated);
  }

  const voided = await DebitNote.findOneAndUpdate(
    { _id: note._id, organizationId: orgId, version: note.version, status: { $ne: "void" } },
    { $set: { status: "void", voided: { at: new Date(), by: oid(actorUserId) }, voidReason: input.reason }, $inc: { version: 1 } },
    { new: true, session }
  );
  if (!voided) throw versionConflict();

  logger.info(`Debit note voided: ${note.number} (${note._id}) org=${organizationId} by user=${actorUserId}`);
  return toData(organizationId, voided, updatedBills);
}
