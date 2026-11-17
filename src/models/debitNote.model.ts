/**
 * Purpose: DebitNote model definition (Phase 3e).
 * Credit from a vendor against one bill (the invoice it corrects): created by a vendor return of
 * billed goods (`type: return`, one per bill), or recorded on its own for a price correction
 * (`type: price_adjustment`). Organization-level, posted on create.
 *
 * - `number` (DN-00001) is taken from the organization's counter inside the posting transaction.
 * - `vendorSnapshot` is the bill's copy of the vendor (the invoice being corrected).
 * - Each line credits a bill line: VAT-exclusive `subtotalMinor` plus `taxMinor` at the bill
 *   line's rate.
 * - `applications` record where the credit went: its own bill first (as far as the bill still
 *   owed), then other bills of the vendor. `appliedMinor` is their sum; total − applied is the
 *   vendor credit still to use.
 * - The only changes after posting are applications and a void (price adjustments only), each
 *   raising `version`.
 *
 * Money is in minor units of the organization's currency and quantities in thousandths.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";
import { IPurchaseOrderVendorSnapshot, IStatusEvent } from "./purchaseOrder.model";
import { VAT_TREATMENTS } from "./vendor.model";
import { DEBIT_NOTE_STATUSES, DEBIT_NOTE_TYPES, DebitNoteStatus, DebitNoteType } from "../validators/vendorReturn.validator";

export interface IDebitNoteLine {
  _id: mongoose.Types.ObjectId;
  billLineId: mongoose.Types.ObjectId;
  variantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  /** Return notes: the quantity credited and the bill line's price; null for a price adjustment. */
  quantityMilli: number | null;
  unitCostMinor: number | null;
  subtotalMinor: number;
  taxRate: { id: mongoose.Types.ObjectId; name: string; rate: number } | null;
  taxMinor: number;
  totalMinor: number;
  note: string | null;
}

export interface IDebitNoteApplication {
  _id: mongoose.Types.ObjectId;
  billId: mongoose.Types.ObjectId;
  billNumber: string;
  vendorInvoiceNumber: string;
  amountMinor: number;
  at: Date;
  by: mongoose.Types.ObjectId;
}

export interface IDebitNote {
  organizationId: mongoose.Types.ObjectId;
  number: string;
  sequence: number;
  type: DebitNoteType;
  status: DebitNoteStatus;
  vendorId: mongoose.Types.ObjectId;
  vendorSnapshot: IPurchaseOrderVendorSnapshot;
  billId: mongoose.Types.ObjectId;
  billNumber: string;
  vendorInvoiceNumber: string;
  billDate: string;
  vendorReturnId: mongoose.Types.ObjectId | null;
  vendorReturnNumber: string | null;
  /** The return's store (return notes only). */
  storeId: mongoose.Types.ObjectId | null;
  /** Calendar date (YYYY-MM-DD). */
  debitNoteDate: string;
  vendorReference: string | null;
  reason: string;
  notes: string | null;
  lines: IDebitNoteLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  appliedMinor: number;
  applications: IDebitNoteApplication[];
  version: number;
  createdBy: mongoose.Types.ObjectId;
  voided: IStatusEvent | null;
  voidReason: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type DebitNoteDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IDebitNote> & IDebitNote;

export type DebitNoteModel = mongoose.Model<IDebitNote, Record<string, never>>;

const integer = { validator: Number.isSafeInteger, message: "must be a whole number" };

const lineSchema = new Schema<IDebitNoteLine>({
  billLineId: { type: Schema.Types.ObjectId, required: true },
  variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  quantityMilli: { type: Number, default: null },
  unitCostMinor: { type: Number, default: null },
  subtotalMinor: { type: Number, required: true, min: 0, validate: integer },
  taxRate: {
    type: new Schema(
      {
        id: { type: Schema.Types.ObjectId, ref: "TaxRate", required: true },
        name: { type: String, required: true },
        rate: { type: Number, required: true },
      },
      { _id: false }
    ),
    default: null,
  },
  taxMinor: { type: Number, required: true, min: 0, validate: integer },
  totalMinor: { type: Number, required: true, min: 0, validate: integer },
  note: { type: String, default: null },
});

const applicationSchema = new Schema<IDebitNoteApplication>({
  billId: { type: Schema.Types.ObjectId, ref: "Bill", required: true },
  billNumber: { type: String, required: true },
  vendorInvoiceNumber: { type: String, required: true },
  amountMinor: { type: Number, required: true, min: 1, validate: integer },
  at: { type: Date, required: true },
  by: { type: Schema.Types.ObjectId, ref: "User", required: true },
});

const statusEventSchema = new Schema<IStatusEvent>(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: false }
);

const vendorSnapshotSchema = new Schema<IPurchaseOrderVendorSnapshot>(
  {
    name: { type: String, required: true },
    legalName: { type: String, default: null },
    taxRegistrationNumber: { type: String, default: null },
    vatTreatment: { type: String, enum: VAT_TREATMENTS, required: true },
  },
  { _id: false }
);

const debitNoteSchema = new Schema<IDebitNote, DebitNoteModel>(
  {
    number: { type: String, required: true },
    sequence: { type: Number, required: true },
    type: { type: String, enum: DEBIT_NOTE_TYPES, required: true },
    status: { type: String, enum: DEBIT_NOTE_STATUSES, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    vendorSnapshot: { type: vendorSnapshotSchema, required: true },
    billId: { type: Schema.Types.ObjectId, ref: "Bill", required: true },
    billNumber: { type: String, required: true },
    vendorInvoiceNumber: { type: String, required: true },
    billDate: { type: String, required: true },
    vendorReturnId: { type: Schema.Types.ObjectId, ref: "VendorReturn", default: null },
    vendorReturnNumber: { type: String, default: null },
    storeId: { type: Schema.Types.ObjectId, ref: "Store", default: null },
    debitNoteDate: { type: String, required: true },
    vendorReference: { type: String, default: null },
    reason: { type: String, required: true },
    notes: { type: String, default: null },
    lines: { type: [lineSchema], required: true },
    subtotalMinor: { type: Number, required: true, min: 0, validate: integer },
    taxMinor: { type: Number, required: true, min: 0, validate: integer },
    totalMinor: { type: Number, required: true, min: 0, validate: integer },
    appliedMinor: { type: Number, required: true, default: 0, min: 0, validate: integer },
    applications: { type: [applicationSchema], default: [] },
    version: { type: Number, required: true, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    voided: { type: statusEventSchema, default: null },
    voidReason: { type: String, default: null },
  },
  { timestamps: true }
);

debitNoteSchema.index({ organizationId: 1, number: 1 }, { unique: true });
debitNoteSchema.index({ organizationId: 1, sequence: -1 });
/** A vendor's notes (open credit: status "open"). */
debitNoteSchema.index({ organizationId: 1, vendorId: 1, status: 1, sequence: -1 });
/** Notes against a bill, or applied to it. */
debitNoteSchema.index({ organizationId: 1, billId: 1 });
debitNoteSchema.index({ organizationId: 1, "applications.billId": 1 });
debitNoteSchema.index({ organizationId: 1, vendorReturnId: 1 });

const NO_DELETE = ["deleteOne", "deleteMany", "findOneAndDelete", "replaceOne", "findOneAndReplace"] as const;

for (const method of NO_DELETE) {
  debitNoteSchema.pre(method as never, function () {
    throw new Error(`Debit notes are never deleted or replaced; ${method} is not allowed. Void the note instead.`);
  });
}

debitNoteSchema.plugin(tenantScopePlugin, { scope: "organization", softDelete: false });

const DebitNote = mongoose.model<IDebitNote, DebitNoteModel>("DebitNote", debitNoteSchema);

export default DebitNote;
export { DebitNote };
