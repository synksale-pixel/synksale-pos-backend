/**
 * Purpose: VendorReturn model definition (Phase 3e).
 * Goods sent back to a vendor from one store, line by line against goods receipt lines. Final
 * once posted: never updated or deleted (goods sent back by mistake come in on a new receipt).
 *
 * - `number` (RTN-00001) is taken from the organization's counter inside the posting transaction.
 * - `vendorSnapshot` is the vendor's details at posting.
 * - Each line splits its quantity: `unbilledQuantityMilli` came off the receipt line's unbilled
 *   quantity (no money involved); the rest was billed and is credited on `billLineId` at the
 *   bill line's `unitCost`, through one debit note per bill (`debitNotes`).
 * - `unitCostMinor` / `stockValueMinor` are the store's average cost when the goods left
 *   (0 and `stocked: false` for goods that do not track inventory).
 *
 * Money is in minor units of the organization's currency and quantities in thousandths.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";
import { IPurchaseOrderVendorSnapshot } from "./purchaseOrder.model";
import { VAT_TREATMENTS } from "./vendor.model";
import { RETURN_REASONS, ReturnReason } from "../validators/vendorReturn.validator";

export interface IVendorReturnLine {
  _id: mongoose.Types.ObjectId;
  goodsReceiptId: mongoose.Types.ObjectId;
  goodsReceiptNumber: string;
  goodsReceiptDate: string;
  goodsReceiptLineId: mongoose.Types.ObjectId;
  variantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  quantityMilli: number;
  unbilledQuantityMilli: number;
  /** The bill line credited for quantityMilli − unbilledQuantityMilli; null when nothing was billed. */
  billId: mongoose.Types.ObjectId | null;
  billNumber: string | null;
  billLineId: mongoose.Types.ObjectId | null;
  billUnitCostMinor: number | null;
  stocked: boolean;
  unitCostMinor: number;
  stockValueMinor: number;
  quantityAfterMilli: number | null;
  note: string | null;
}

export interface IVendorReturnDebitNoteRef {
  debitNoteId: mongoose.Types.ObjectId;
  number: string;
  billId: mongoose.Types.ObjectId;
  billNumber: string;
  totalMinor: number;
}

export interface IVendorReturn {
  organizationId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  number: string;
  /** The number as an integer: list order (newest first). */
  sequence: number;
  vendorId: mongoose.Types.ObjectId;
  vendorSnapshot: IPurchaseOrderVendorSnapshot;
  /** Calendar date (YYYY-MM-DD, store timezone) the goods left. */
  returnDate: string;
  reason: ReturnReason;
  vendorReference: string | null;
  notes: string | null;
  lines: IVendorReturnLine[];
  /** The receipts returned from (distinct), for a receipt's return history. */
  goodsReceiptIds: mongoose.Types.ObjectId[];
  stockValueMinor: number;
  creditMinor: number;
  debitNotes: IVendorReturnDebitNoteRef[];
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

export type VendorReturnDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IVendorReturn> & IVendorReturn;

export type VendorReturnModel = mongoose.Model<IVendorReturn, Record<string, never>>;

const integer = { validator: Number.isSafeInteger, message: "must be a whole number" };

const lineSchema = new Schema<IVendorReturnLine>({
  goodsReceiptId: { type: Schema.Types.ObjectId, ref: "GoodsReceipt", required: true },
  goodsReceiptNumber: { type: String, required: true },
  goodsReceiptDate: { type: String, required: true },
  goodsReceiptLineId: { type: Schema.Types.ObjectId, required: true },
  variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  quantityMilli: { type: Number, required: true, min: 1, validate: integer },
  unbilledQuantityMilli: { type: Number, required: true, min: 0, validate: integer },
  billId: { type: Schema.Types.ObjectId, ref: "Bill", default: null },
  billNumber: { type: String, default: null },
  billLineId: { type: Schema.Types.ObjectId, default: null },
  billUnitCostMinor: { type: Number, default: null },
  stocked: { type: Boolean, required: true },
  unitCostMinor: { type: Number, required: true, min: 0, validate: integer },
  stockValueMinor: { type: Number, required: true, min: 0, validate: integer },
  quantityAfterMilli: { type: Number, default: null },
  note: { type: String, default: null },
});

const debitNoteRefSchema = new Schema<IVendorReturnDebitNoteRef>(
  {
    debitNoteId: { type: Schema.Types.ObjectId, ref: "DebitNote", required: true },
    number: { type: String, required: true },
    billId: { type: Schema.Types.ObjectId, ref: "Bill", required: true },
    billNumber: { type: String, required: true },
    totalMinor: { type: Number, required: true, min: 0, validate: integer },
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

const vendorReturnSchema = new Schema<IVendorReturn, VendorReturnModel>(
  {
    number: { type: String, required: true },
    sequence: { type: Number, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    vendorSnapshot: { type: vendorSnapshotSchema, required: true },
    returnDate: { type: String, required: true },
    reason: { type: String, enum: RETURN_REASONS, required: true },
    vendorReference: { type: String, default: null },
    notes: { type: String, default: null },
    lines: { type: [lineSchema], required: true },
    goodsReceiptIds: { type: [Schema.Types.ObjectId], default: [] },
    stockValueMinor: { type: Number, required: true, min: 0, validate: integer },
    creditMinor: { type: Number, required: true, min: 0, validate: integer },
    debitNotes: { type: [debitNoteRefSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

vendorReturnSchema.index({ organizationId: 1, number: 1 }, { unique: true });
/** Newest number first, per store and across stores. */
vendorReturnSchema.index({ organizationId: 1, storeId: 1, sequence: -1 });
vendorReturnSchema.index({ organizationId: 1, sequence: -1 });
vendorReturnSchema.index({ organizationId: 1, vendorId: 1, sequence: -1 });
/** A receipt's return history. */
vendorReturnSchema.index({ organizationId: 1, goodsReceiptIds: 1 });

const IMMUTABLE = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const;

for (const method of IMMUTABLE) {
  vendorReturnSchema.pre(method as never, function () {
    throw new Error(`Vendor returns are final; ${method} is not allowed.`);
  });
}

vendorReturnSchema.plugin(tenantScopePlugin, { scope: "organization+store", softDelete: false });

const VendorReturn = mongoose.model<IVendorReturn, VendorReturnModel>("VendorReturn", vendorReturnSchema);

export default VendorReturn;
export { VendorReturn };
