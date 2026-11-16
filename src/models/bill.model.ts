/**
 * Purpose: Bill model definition (vendor bills, Phase 3d).
 * The vendor's invoice: what the organization owes. Organization-level (one invoice can cover
 * several stores' deliveries) and posted on create: no drafts, edits or deletes. The only
 * changes after posting are payments (`paidMinor`, `status`) and a void.
 *
 * - `number` (BILL-00001) is taken from the organization's counter inside the posting transaction.
 * - `vendorSnapshot` is the vendor's details at posting; its `vatTreatment` decided the VAT.
 * - Goods lines copy the receipt line they bill (`goodsReceiptLineId`) with its store, variant
 *   and received cost; service lines have no receipt.
 * - `activeInvoiceKey` is the lower-cased vendor invoice number while the bill is not void, and
 *   null once void, so the unique index lets a voided invoice number be entered again.
 * - `version` goes up on every change, so a stale screen cannot void a bill it has not seen paid.
 *
 * Money is in minor units of the organization's currency and quantities in thousandths.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";
import { IPurchaseOrderLineTax, IPurchaseOrderVendorSnapshot, IStatusEvent } from "./purchaseOrder.model";
import { TAX_PREFERENCES } from "./product.model";
import { VAT_TREATMENTS } from "./vendor.model";
import { BILL_STATUSES, BillStatus } from "../validators/bill.validator";

export const BILL_LINE_KINDS = ["goods", "service"] as const;
export type BillLineKind = (typeof BILL_LINE_KINDS)[number];

export interface IBillLine extends IPurchaseOrderLineTax {
  _id: mongoose.Types.ObjectId;
  kind: BillLineKind;
  /** Goods lines: the receipt billed, its number and date (copied); null on a service line. */
  goodsReceiptId: mongoose.Types.ObjectId | null;
  goodsReceiptNumber: string | null;
  goodsReceiptDate: string | null;
  goodsReceiptLineId: mongoose.Types.ObjectId | null;
  /** Goods lines: the receiving store; null on a service line. */
  storeId: mongoose.Types.ObjectId | null;
  variantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  quantityMilli: number;
  unitCostMinor: number;
  /** Goods lines: the receipt line's unitCost; null on a service line. */
  receivedUnitCostMinor: number | null;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Signed: what the line costs minus what the receipt put into stock for the same quantity. */
  costVarianceMinor: number;
  note: string | null;
}

export interface IBill {
  organizationId: mongoose.Types.ObjectId;
  number: string;
  /** The number as an integer: list order (newest first). */
  sequence: number;
  status: BillStatus;
  vendorId: mongoose.Types.ObjectId;
  vendorSnapshot: IPurchaseOrderVendorSnapshot;
  vendorInvoiceNumber: string;
  activeInvoiceKey: string | null;
  /** Calendar dates (YYYY-MM-DD). */
  billDate: string;
  dueDate: string;
  notes: string | null;
  lines: IBillLine[];
  /** The receipts billed (distinct), for the receipt's billing history. */
  goodsReceiptIds: mongoose.Types.ObjectId[];
  subtotalMinor: number;
  /** Lines' tax plus vatAdjustmentMinor. */
  taxMinor: number;
  vatAdjustmentMinor: number;
  totalMinor: number;
  paidMinor: number;
  costVarianceMinor: number;
  version: number;
  createdBy: mongoose.Types.ObjectId;
  voided: IStatusEvent | null;
  voidReason: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type BillDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IBill> & IBill;

export type BillModel = mongoose.Model<IBill, Record<string, never>>;

const integer = { validator: Number.isSafeInteger, message: "must be a whole number" };

const lineSchema = new Schema<IBillLine>({
  kind: { type: String, enum: BILL_LINE_KINDS, required: true },
  goodsReceiptId: { type: Schema.Types.ObjectId, ref: "GoodsReceipt", default: null },
  goodsReceiptNumber: { type: String, default: null },
  goodsReceiptDate: { type: String, default: null },
  goodsReceiptLineId: { type: Schema.Types.ObjectId, default: null },
  storeId: { type: Schema.Types.ObjectId, ref: "Store", default: null },
  variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  quantityMilli: { type: Number, required: true, min: 1, validate: integer },
  unitCostMinor: { type: Number, required: true, min: 0, validate: integer },
  receivedUnitCostMinor: { type: Number, default: null },
  subtotalMinor: { type: Number, required: true, min: 0, validate: integer },
  taxPreference: { type: String, enum: TAX_PREFERENCES, required: true },
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
  costVarianceMinor: { type: Number, required: true, validate: integer },
  note: { type: String, default: null },
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

const billSchema = new Schema<IBill, BillModel>(
  {
    number: { type: String, required: true },
    sequence: { type: Number, required: true },
    status: { type: String, enum: BILL_STATUSES, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    vendorSnapshot: { type: vendorSnapshotSchema, required: true },
    vendorInvoiceNumber: { type: String, required: true },
    activeInvoiceKey: { type: String, default: null },
    billDate: { type: String, required: true },
    dueDate: { type: String, required: true },
    notes: { type: String, default: null },
    lines: { type: [lineSchema], required: true },
    goodsReceiptIds: { type: [Schema.Types.ObjectId], default: [] },
    subtotalMinor: { type: Number, required: true, validate: integer },
    taxMinor: { type: Number, required: true, min: 0, validate: integer },
    vatAdjustmentMinor: { type: Number, required: true, default: 0, validate: integer },
    totalMinor: { type: Number, required: true, min: 0, validate: integer },
    paidMinor: { type: Number, required: true, default: 0, min: 0, validate: integer },
    costVarianceMinor: { type: Number, required: true, default: 0, validate: integer },
    version: { type: Number, required: true, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    voided: { type: statusEventSchema, default: null },
    voidReason: { type: String, default: null },
  },
  { timestamps: true }
);

billSchema.index({ organizationId: 1, number: 1 }, { unique: true });
/** One bill (not void) per vendor invoice number. */
billSchema.index(
  { organizationId: 1, vendorId: 1, activeInvoiceKey: 1 },
  { unique: true, partialFilterExpression: { activeInvoiceKey: { $type: "string" } } }
);
/** Newest number first; per vendor; per status (bills still owed, overdue). */
billSchema.index({ organizationId: 1, sequence: -1 });
billSchema.index({ organizationId: 1, vendorId: 1, sequence: -1 });
billSchema.index({ organizationId: 1, status: 1, dueDate: 1 });
/** A receipt's billing history. */
billSchema.index({ organizationId: 1, goodsReceiptIds: 1 });
/** Catalog delete checks: is this variant on any bill? */
billSchema.index({ organizationId: 1, "lines.variantId": 1 });

const NO_DELETE = ["deleteOne", "deleteMany", "findOneAndDelete", "replaceOne", "findOneAndReplace"] as const;

for (const method of NO_DELETE) {
  billSchema.pre(method as never, function () {
    throw new Error(`Bills are never deleted or replaced; ${method} is not allowed. Void the bill instead.`);
  });
}

billSchema.plugin(tenantScopePlugin, { scope: "organization", softDelete: false });

const Bill = mongoose.model<IBill, BillModel>("Bill", billSchema);

export default Bill;
export { Bill };
