/**
 * Purpose: VendorPayment model definition (Phase 3d).
 * Money paid to one vendor, split across one or more of its bills. Organization-level, posted on
 * create, never edited or deleted: the only change is a void, which reverses every allocation.
 *
 * - `number` (PAY-00001) is taken from the organization's counter inside the posting transaction.
 * - Each allocation copies the bill's number and vendor invoice number for display.
 * - `amountMinor` always equals the sum of the allocations (no advances or credit in v1).
 *
 * Money is in minor units of the organization's currency.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";
import { IStatusEvent } from "./purchaseOrder.model";
import {
  PAYMENT_METHODS,
  PaymentMethod,
  VENDOR_PAYMENT_STATUSES,
  VendorPaymentStatus,
} from "../validators/bill.validator";

export interface IVendorPaymentAllocation {
  billId: mongoose.Types.ObjectId;
  billNumber: string;
  vendorInvoiceNumber: string;
  amountMinor: number;
}

export interface IVendorPayment {
  organizationId: mongoose.Types.ObjectId;
  number: string;
  sequence: number;
  status: VendorPaymentStatus;
  vendorId: mongoose.Types.ObjectId;
  /** The vendor's name when the payment was posted. */
  vendorName: string;
  /** Calendar date (YYYY-MM-DD). */
  paymentDate: string;
  amountMinor: number;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  allocations: IVendorPaymentAllocation[];
  version: number;
  createdBy: mongoose.Types.ObjectId;
  voided: IStatusEvent | null;
  voidReason: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type VendorPaymentDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IVendorPayment> &
  IVendorPayment;

export type VendorPaymentModel = mongoose.Model<IVendorPayment, Record<string, never>>;

const integer = { validator: Number.isSafeInteger, message: "must be a whole number" };

const allocationSchema = new Schema<IVendorPaymentAllocation>(
  {
    billId: { type: Schema.Types.ObjectId, ref: "Bill", required: true },
    billNumber: { type: String, required: true },
    vendorInvoiceNumber: { type: String, required: true },
    amountMinor: { type: Number, required: true, min: 1, validate: integer },
  },
  { _id: false }
);

const statusEventSchema = new Schema<IStatusEvent>(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: false }
);

const vendorPaymentSchema = new Schema<IVendorPayment, VendorPaymentModel>(
  {
    number: { type: String, required: true },
    sequence: { type: Number, required: true },
    status: { type: String, enum: VENDOR_PAYMENT_STATUSES, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    vendorName: { type: String, required: true },
    paymentDate: { type: String, required: true },
    amountMinor: { type: Number, required: true, min: 1, validate: integer },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    reference: { type: String, default: null },
    notes: { type: String, default: null },
    allocations: { type: [allocationSchema], required: true },
    version: { type: Number, required: true, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    voided: { type: statusEventSchema, default: null },
    voidReason: { type: String, default: null },
  },
  { timestamps: true }
);

vendorPaymentSchema.index({ organizationId: 1, number: 1 }, { unique: true });
vendorPaymentSchema.index({ organizationId: 1, sequence: -1 });
vendorPaymentSchema.index({ organizationId: 1, vendorId: 1, sequence: -1 });
/** A bill's payments. */
vendorPaymentSchema.index({ organizationId: 1, "allocations.billId": 1, sequence: 1 });

const NO_DELETE = ["deleteOne", "deleteMany", "findOneAndDelete", "replaceOne", "findOneAndReplace"] as const;

for (const method of NO_DELETE) {
  vendorPaymentSchema.pre(method as never, function () {
    throw new Error(`Vendor payments are never deleted or replaced; ${method} is not allowed. Void the payment instead.`);
  });
}

vendorPaymentSchema.plugin(tenantScopePlugin, { scope: "organization", softDelete: false });

const VendorPayment = mongoose.model<IVendorPayment, VendorPaymentModel>("VendorPayment", vendorPaymentSchema);

export default VendorPayment;
export { VendorPayment };
