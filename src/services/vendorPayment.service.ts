/**
 * Purpose: Vendor Payment Service (Phase 3d).
 * Recording payments to a vendor (split across its open bills), voiding them, and reading them.
 *
 * A payment is posted in one transaction (the caller's, see idempotency.service): the payment
 * and its number, and each allocated bill's `paidMinor`, `status` and `version`. Each bill is
 * written on `{ _id, version }` after being read in the same transaction, so two payments racing
 * for one bill conflict, the transaction runs again with fresh reads, and the second one is
 * refused if it would pay more than is still due (PAYMENT_EXCEEDS_DUE).
 *
 * No advances or overpayments in v1: the amount always equals the sum of the allocations
 * (checked by the validator, and again here in minor units).
 */

import mongoose from "mongoose";
import { Bill, BillDocument } from "../models/bill.model";
import { VendorPayment, VendorPaymentDocument } from "../models/vendorPayment.model";
import { DocumentCounter } from "../models/documentCounter.model";
import { Vendor, VendorDocument } from "../models/vendor.model";
import { ApiError, ApiErrorDetail } from "../utils/ApiError";
import { formatMoney, sumMoney } from "../utils/money";
import { resolvePaging, buildPaginationMeta } from "../utils/pagination";
import { logger } from "../config/logger.config";
import { userRefs, UserRef } from "./stock.service";
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
import {
  PAYABLE_BILL_STATUSES,
  PAYMENT_METHODS,
  VENDOR_PAYMENT_STATUSES,
  CreateVendorPaymentInput,
  VoidVendorPaymentInput,
} from "../validators/bill.validator";

type ObjectId = mongoose.Types.ObjectId;
const oid = (id: string | ObjectId) => new mongoose.Types.ObjectId(String(id));

const anyState = { $in: [true, false] };

function paymentNotFound(): ApiError {
  return ApiError.coded(404, "VENDOR_PAYMENT_NOT_FOUND", "Vendor payment not found.");
}

function billChanged(field: string): ApiError {
  return ApiError.coded(409, "BILL_STATUS_CONFLICT", "A bill changed while the payment was being recorded. Reload it and try again.", [
    { field, code: "BILL_STATUS_CONFLICT" },
  ]);
}

// ==========================================
// Views
// ==========================================

interface PaymentViewContext {
  decimals: number;
  users: Map<string, UserRef>;
  vendors: Map<string, VendorDocument>;
}

async function paymentViewContext(organizationId: string, payments: VendorPaymentDocument[], settings?: BillSettings): Promise<PaymentViewContext> {
  const [resolved, users, vendors] = await Promise.all([
    settings ?? billSettings(organizationId),
    userRefs(
      organizationId,
      payments.flatMap((payment) => [payment.createdBy, payment.voided?.by ?? null])
    ),
    payments.length
      ? Vendor.find({ organizationId, _id: { $in: payments.map((payment) => payment.vendorId) }, isDelete: anyState })
      : Promise.resolve([] as VendorDocument[]),
  ]);
  return { decimals: resolved.decimals, users, vendors: new Map(vendors.map((vendor) => [vendor._id.toString(), vendor])) };
}

const userRef = (ctx: PaymentViewContext, id: ObjectId) => ctx.users.get(id.toString()) ?? { id, name: "(unknown)" };

function coreView(ctx: PaymentViewContext, payment: VendorPaymentDocument) {
  const vendor = ctx.vendors.get(payment.vendorId.toString());
  return {
    id: payment._id,
    number: payment.number,
    status: payment.status,
    vendor: { id: payment.vendorId, name: payment.vendorName, isActive: Boolean(vendor && vendor.isActive && !vendor.isDelete) },
    paymentDate: payment.paymentDate,
    amount: formatMoney(payment.amountMinor, ctx.decimals),
    method: payment.method,
    reference: payment.reference ?? null,
    version: payment.version,
    createdBy: userRef(ctx, payment.createdBy),
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

function detailView(ctx: PaymentViewContext, payment: VendorPaymentDocument) {
  return {
    ...coreView(ctx, payment),
    notes: payment.notes ?? null,
    allocations: payment.allocations.map((allocation) => ({
      bill: { id: allocation.billId, number: allocation.billNumber, vendorInvoiceNumber: allocation.vendorInvoiceNumber },
      amount: formatMoney(allocation.amountMinor, ctx.decimals),
    })),
    voided: payment.voided ? { at: payment.voided.at, by: userRef(ctx, payment.voided.by) } : null,
    voidReason: payment.voidReason ?? null,
  };
}

async function toData(organizationId: string, payment: VendorPaymentDocument, bills: BillDocument[], settings?: BillSettings) {
  const resolved = settings ?? (await billSettings(organizationId));
  const ctx = await paymentViewContext(organizationId, [payment], resolved);
  return { payment: detailView(ctx, payment), bills: await toBillSummaries(organizationId, bills, resolved) };
}

// ==========================================
// Reads
// ==========================================

export interface ListVendorPaymentsQuery {
  search?: string;
  vendorId?: string;
  billId?: string;
  status?: string;
  method?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export async function listVendorPayments(organizationId: string, query: ListVendorPaymentsQuery) {
  const { page, limit, skip } = resolvePaging(query);
  const empty = () => ({ payments: [], pagination: buildPaginationMeta(page, limit, 0) });
  const conditions: Record<string, unknown>[] = [{ organizationId }];

  if (query.vendorId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(query.vendorId)) return empty();
    conditions.push({ vendorId: oid(query.vendorId) });
  }
  if (query.billId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(query.billId)) return empty();
    conditions.push({ "allocations.billId": oid(query.billId) });
  }
  const statuses = csvFilter(query.status, VENDOR_PAYMENT_STATUSES);
  if (statuses) conditions.push({ status: { $in: statuses } });
  const methods = csvFilter(query.method, PAYMENT_METHODS);
  if (methods) conditions.push({ method: { $in: methods } });

  const from = query.from?.trim();
  const to = query.to?.trim();
  if (from && isCalendarDate(from)) conditions.push({ paymentDate: { $gte: from } });
  if (to && isCalendarDate(to)) conditions.push({ paymentDate: { $lte: to } });

  const term = query.search?.replace(/\0/g, "").trim();
  if (term) {
    conditions.push({
      $or: [
        { number: { $regex: `^${escapeRegex(numberPrefix(term, "PAY-"))}` } },
        { reference: { $regex: `^${escapeRegex(term)}`, $options: "i" } },
      ],
    });
  }

  const filter = { $and: conditions };
  const [total, payments] = await Promise.all([
    VendorPayment.countDocuments(filter),
    VendorPayment.find(filter).sort({ sequence: -1 }).skip(skip).limit(limit),
  ]);
  const ctx = await paymentViewContext(organizationId, payments);
  return {
    payments: payments.map((payment) => ({ ...coreView(ctx, payment), billCount: payment.allocations.length })),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

export async function getVendorPayment(organizationId: string, paymentId: string) {
  const payment = await VendorPayment.findOne({ _id: paymentId, organizationId });
  if (!payment) throw paymentNotFound();
  const ctx = await paymentViewContext(organizationId, [payment]);
  return { payment: detailView(ctx, payment), bills: [] };
}

// ==========================================
// Posting
// ==========================================

/**
 * Records a payment to one vendor. Runs inside the caller's transaction (see idempotency.service).
 * Checked in this order: the vendor (400), amounts that do not fit the currency (400), bills not
 * found (404), bills of another vendor (400), bills not payable (409), the date (400), then
 * allocations above what is still due (409).
 */
export async function createVendorPayment(
  organizationId: string,
  input: CreateVendorPaymentInput,
  actorUserId: string,
  session: mongoose.ClientSession
) {
  const settings = await billSettings(organizationId);
  const orgId = oid(organizationId);

  const vendor = await Vendor.findOne({ _id: oid(input.vendorId), organizationId }).session(session);
  if (!vendor) {
    throw ApiError.coded(400, "VENDOR_NOT_FOUND", "Vendor not found.", [{ field: "vendorId", code: "VENDOR_NOT_FOUND" }]);
  }

  const amountErrors: ApiErrorDetail[] = [];
  const amountMinor = parseAmount(input.amount, settings.decimals, "amount", amountErrors);
  const allocationMinor = input.allocations.map((allocation, i) =>
    parseAmount(allocation.amount, settings.decimals, `allocations[${i}].amount`, amountErrors)
  );
  if (amountErrors.length > 0) throw collected(400, amountErrors);
  const amounts = allocationMinor as number[];
  if (sumMoney(amounts) !== amountMinor) {
    throw validationError("amount", "amount must equal the sum of allocations[].amount (advances and overpayments are not supported).");
  }

  const bills = await Bill.find({ organizationId: orgId, _id: { $in: input.allocations.map((a) => oid(a.billId)) } }).session(session);
  const billById = new Map(bills.map((bill) => [bill._id.toString(), bill]));
  const allocated = input.allocations.map((allocation) => billById.get(allocation.billId.toLowerCase()));

  const missing: ApiErrorDetail[] = [];
  allocated.forEach((bill, i) => {
    if (!bill) missing.push({ field: `allocations[${i}].billId`, code: "BILL_NOT_FOUND", message: "Bill not found." });
  });
  if (missing.length > 0) throw collected(404, missing);
  const targets = allocated as BillDocument[];

  const mismatched: ApiErrorDetail[] = [];
  targets.forEach((bill, i) => {
    if (!bill.vendorId.equals(vendor._id)) {
      mismatched.push({
        field: `allocations[${i}].billId`,
        code: "VENDOR_MISMATCH",
        message: `Bill ${bill.number} is from a different vendor.`,
        meta: { billNumber: bill.number },
      });
    }
  });
  if (mismatched.length > 0) throw collected(400, mismatched);

  const unpayable: ApiErrorDetail[] = [];
  targets.forEach((bill, i) => {
    if (!PAYABLE_BILL_STATUSES.includes(bill.status)) {
      unpayable.push({
        field: `allocations[${i}].billId`,
        code: "BILL_STATUS_CONFLICT",
        message: `Bill ${bill.number} is ${bill.status.replace("_", " ")}, so it cannot be paid.`,
        meta: { status: bill.status },
      });
    }
  });
  if (unpayable.length > 0) throw collected(409, unpayable);

  const paymentDate = input.paymentDate ?? settings.today;
  if (paymentDate > settings.today) throw validationError("paymentDate", "paymentDate cannot be in the future.");
  const latest = targets.reduce((max, bill) => (bill.billDate > max.billDate ? bill : max), targets[0]);
  if (paymentDate < latest.billDate) {
    throw validationError("paymentDate", `paymentDate cannot be before the billDate of ${latest.number} (${latest.billDate}).`);
  }

  const exceeded: ApiErrorDetail[] = [];
  targets.forEach((bill, i) => {
    const dueMinor = bill.totalMinor - bill.paidMinor;
    if (amounts[i] > dueMinor) {
      const balanceDue = formatMoney(dueMinor, settings.decimals);
      exceeded.push({
        field: `allocations[${i}].amount`,
        code: "PAYMENT_EXCEEDS_DUE",
        message: `This payment is more than is still due on ${bill.number} (${balanceDue}).`,
        meta: { balanceDue },
      });
    }
  });
  if (exceeded.length > 0) throw collected(409, exceeded);

  const updatedBills: BillDocument[] = [];
  for (const [i, bill] of targets.entries()) {
    const paidMinor = bill.paidMinor + amounts[i];
    const updated = await Bill.findOneAndUpdate(
      { _id: bill._id, organizationId: orgId, version: bill.version, status: { $in: PAYABLE_BILL_STATUSES } },
      { $set: { status: statusForPaid(bill.totalMinor, paidMinor) }, $inc: { paidMinor: amounts[i], version: 1 } },
      { new: true, session }
    );
    // Reads and writes share the transaction's snapshot: a concurrent payment normally aborts with
    // a retried write conflict before reaching here.
    if (!updated) throw billChanged(`allocations[${i}].billId`);
    updatedBills.push(updated);
  }

  // Counts toward the vendor's purchase documents (it already has bills, so this only adds to the count).
  await Vendor.updateOne({ _id: vendor._id, organizationId: orgId }, { $inc: { purchaseDocumentCount: 1 } }, { session });

  const counter = await DocumentCounter.findOneAndUpdate(
    { organizationId: orgId, type: "vendor_payment" },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );
  const sequence = counter!.seq;
  const number = `PAY-${String(sequence).padStart(5, "0")}`;

  const [payment] = await VendorPayment.create(
    [
      {
        organizationId: orgId,
        number,
        sequence,
        status: "posted",
        vendorId: vendor._id,
        vendorName: vendor.name,
        paymentDate,
        amountMinor,
        method: input.method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        allocations: targets.map((bill, i) => ({
          billId: bill._id,
          billNumber: bill.number,
          vendorInvoiceNumber: bill.vendorInvoiceNumber,
          amountMinor: amounts[i],
        })),
        version: 1,
        createdBy: oid(actorUserId),
        voided: null,
        voidReason: null,
      },
    ],
    { session }
  );

  logger.info(`Vendor payment recorded: ${number} (${payment._id}) vendor=${vendor._id} org=${organizationId} by user=${actorUserId}`);
  return toData(organizationId, payment, updatedBills, settings);
}

/** Voids a payment and reverses every allocation: each bill's paid goes down, its status back. */
export async function voidVendorPayment(
  organizationId: string,
  paymentId: string,
  input: VoidVendorPaymentInput,
  actorUserId: string,
  session: mongoose.ClientSession
) {
  const orgId = oid(organizationId);
  const payment = await VendorPayment.findOne({ _id: paymentId, organizationId: orgId }).session(session);
  if (!payment) throw paymentNotFound();
  if (payment.version !== input.version) {
    throw ApiError.coded(
      409,
      "VENDOR_PAYMENT_VERSION_CONFLICT",
      "This payment was changed by someone else. Reload it and try again.",
      [{ field: "version", code: "VENDOR_PAYMENT_VERSION_CONFLICT", meta: { currentVersion: payment.version } }]
    );
  }
  if (payment.status === "void") {
    throw ApiError.coded(409, "VENDOR_PAYMENT_STATUS_CONFLICT", "This payment is already void.", [
      { code: "VENDOR_PAYMENT_STATUS_CONFLICT", meta: { status: payment.status } },
    ]);
  }

  const updatedBills: BillDocument[] = [];
  for (const allocation of payment.allocations) {
    const bill = await Bill.findOne({ _id: allocation.billId, organizationId: orgId }).session(session);
    // A bill with a posted payment cannot be voided, and paid only grows by allocations.
    if (!bill || bill.status === "void" || bill.paidMinor < allocation.amountMinor) {
      throw new Error(`Payment ${payment.number}: bill ${allocation.billNumber} does not hold this allocation.`);
    }
    const paidMinor = bill.paidMinor - allocation.amountMinor;
    const updated = await Bill.findOneAndUpdate(
      { _id: bill._id, organizationId: orgId, version: bill.version },
      { $set: { status: statusForPaid(bill.totalMinor, paidMinor) }, $inc: { paidMinor: -allocation.amountMinor, version: 1 } },
      { new: true, session }
    );
    if (!updated) throw billChanged("paymentId");
    updatedBills.push(updated);
  }

  const voided = await VendorPayment.findOneAndUpdate(
    { _id: payment._id, organizationId: orgId, version: payment.version, status: "posted" },
    { $set: { status: "void", voided: { at: new Date(), by: oid(actorUserId) }, voidReason: input.reason }, $inc: { version: 1 } },
    { new: true, session }
  );
  if (!voided) {
    throw ApiError.coded(409, "VENDOR_PAYMENT_VERSION_CONFLICT", "This payment was changed by someone else. Reload it and try again.", [
      { field: "version", code: "VENDOR_PAYMENT_VERSION_CONFLICT" },
    ]);
  }

  logger.info(`Vendor payment voided: ${payment.number} (${payment._id}) org=${organizationId} by user=${actorUserId}`);
  return toData(organizationId, voided, updatedBills);
}
