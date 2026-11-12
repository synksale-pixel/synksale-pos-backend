/**
 * Purpose: GoodsReceipt model definition.
 * Goods that arrived at one store, against a purchase order or without one. The only purchase
 * document that adds stock. Final once posted: never updated or deleted (a mistake is fixed with
 * a stock adjustment, or a return to vendor in Phase 3e).
 *
 * - `number` (GRN-00001) is taken from the organization's counter inside the posting transaction.
 * - `vendorSnapshot` is the vendor's details at posting (the PO's issue copy against a PO).
 * - Each line keeps the cost it was received at (`unitCostMinor`, VAT-exclusive) and the cost that
 *   went into stock (`stockUnitCostMinor`: plus input VAT for an organization with no TRN).
 * - `stocked` is false for goods that do not track inventory: no movement, `quantityAfterMilli` null.
 *
 * Money is in minor units of the organization's currency and quantities in thousandths.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";
import { IPurchaseOrderVendorSnapshot } from "./purchaseOrder.model";
import { VAT_TREATMENTS } from "./vendor.model";

export interface IGoodsReceiptLine {
  _id: mongoose.Types.ObjectId;
  /** The PO line received; null without a PO. */
  purchaseOrderLineId: mongoose.Types.ObjectId | null;
  variantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  quantityMilli: number;
  unitCostMinor: number;
  subtotalMinor: number;
  stockUnitCostMinor: number;
  stockValueMinor: number;
  stocked: boolean;
  quantityAfterMilli: number | null;
  note: string | null;
}

export interface IGoodsReceipt {
  organizationId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  number: string;
  /** The number as an integer: list order (newest first). */
  sequence: number;
  purchaseOrderId: mongoose.Types.ObjectId | null;
  purchaseOrderNumber: string | null;
  vendorId: mongoose.Types.ObjectId;
  vendorSnapshot: IPurchaseOrderVendorSnapshot;
  /** Calendar date (YYYY-MM-DD) the goods arrived. */
  receivedDate: string;
  vendorReference: string | null;
  notes: string | null;
  lines: IGoodsReceiptLine[];
  subtotalMinor: number;
  stockValueMinor: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

export type GoodsReceiptDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IGoodsReceipt> & IGoodsReceipt;

export type GoodsReceiptModel = mongoose.Model<IGoodsReceipt, Record<string, never>>;

const integer = { validator: Number.isSafeInteger, message: "must be a whole number" };

const lineSchema = new Schema<IGoodsReceiptLine>({
  purchaseOrderLineId: { type: Schema.Types.ObjectId, default: null },
  variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  quantityMilli: { type: Number, required: true, min: 1, validate: integer },
  unitCostMinor: { type: Number, required: true, min: 0, validate: integer },
  subtotalMinor: { type: Number, required: true, min: 0, validate: integer },
  stockUnitCostMinor: { type: Number, required: true, min: 0, validate: integer },
  stockValueMinor: { type: Number, required: true, min: 0, validate: integer },
  stocked: { type: Boolean, required: true },
  quantityAfterMilli: { type: Number, default: null },
  note: { type: String, default: null },
});

const vendorSnapshotSchema = new Schema<IPurchaseOrderVendorSnapshot>(
  {
    name: { type: String, required: true },
    legalName: { type: String, default: null },
    taxRegistrationNumber: { type: String, default: null },
    vatTreatment: { type: String, enum: VAT_TREATMENTS, required: true },
  },
  { _id: false }
);

const goodsReceiptSchema = new Schema<IGoodsReceipt, GoodsReceiptModel>(
  {
    number: { type: String, required: true },
    sequence: { type: Number, required: true },
    purchaseOrderId: { type: Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },
    purchaseOrderNumber: { type: String, default: null },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    vendorSnapshot: { type: vendorSnapshotSchema, required: true },
    receivedDate: { type: String, required: true },
    vendorReference: { type: String, default: null },
    notes: { type: String, default: null },
    lines: { type: [lineSchema], required: true },
    subtotalMinor: { type: Number, required: true, validate: integer },
    stockValueMinor: { type: Number, required: true, validate: integer },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

goodsReceiptSchema.index({ organizationId: 1, number: 1 }, { unique: true });
/** Newest number first, per store and across stores. */
goodsReceiptSchema.index({ organizationId: 1, storeId: 1, sequence: -1 });
goodsReceiptSchema.index({ organizationId: 1, sequence: -1 });
goodsReceiptSchema.index({ organizationId: 1, vendorId: 1, sequence: -1 });
/** A PO's delivery history. */
goodsReceiptSchema.index({ organizationId: 1, purchaseOrderId: 1, sequence: -1 });

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
  goodsReceiptSchema.pre(method as never, function () {
    throw new Error(`Goods receipts are final; ${method} is not allowed.`);
  });
}

goodsReceiptSchema.plugin(tenantScopePlugin, { scope: "organization+store", softDelete: false });

const GoodsReceipt = mongoose.model<IGoodsReceipt, GoodsReceiptModel>("GoodsReceipt", goodsReceiptSchema);

export default GoodsReceipt;
export { GoodsReceipt };
