/**
 * Purpose: PurchaseOrder model definition.
 * What one store plans to buy from one vendor. A PO never changes stock: goods receipts
 * (Phase 3c) do, and record what arrived in each line's `receivedQuantityMilli`.
 *
 * - `number` (PO-00001) is given when the draft is created and never reused; deleted drafts are
 *   soft-deleted so their numbers stay taken.
 * - `version` goes up on every change. Every write is conditional on the version the caller
 *   loaded, so two people editing at once cannot overwrite each other.
 * - `vendorSnapshot` is null while a draft and a copy of the vendor's details from issue on, so
 *   later vendor edits do not change an issued PO.
 * - Lines keep the tax they were estimated with, so a later tax-rate change does not rewrite them.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";
import { PURCHASE_ORDER_STATUSES, PurchaseOrderStatus } from "../validators/purchaseOrder.validator";
import { TAX_PREFERENCES, TaxPreference } from "./product.model";
import { VAT_TREATMENTS, VatTreatment } from "./vendor.model";

export interface IPurchaseOrderLineTax {
  taxPreference: TaxPreference;
  /** The rate used for the estimate; null when no VAT is estimated. */
  taxRate: { id: mongoose.Types.ObjectId; name: string; rate: number } | null;
}

export interface IPurchaseOrderLine extends IPurchaseOrderLineTax {
  _id: mongoose.Types.ObjectId;
  variantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  quantityMilli: number;
  receivedQuantityMilli: number;
  unitCostMinor: number;
  subtotalMinor: number;
  estimatedTaxMinor: number;
  totalMinor: number;
  note: string | null;
}

export interface IPurchaseOrderVendorSnapshot {
  name: string;
  legalName: string | null;
  taxRegistrationNumber: string | null;
  vatTreatment: VatTreatment;
}

export interface IStatusEvent {
  at: Date;
  by: mongoose.Types.ObjectId;
}

export interface IPurchaseOrder {
  organizationId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  number: string;
  /** The number as an integer: list order (newest first), since "PO-100000" sorts before "PO-99999" as text. */
  sequence: number;
  status: PurchaseOrderStatus;
  vendorId: mongoose.Types.ObjectId;
  vendorSnapshot: IPurchaseOrderVendorSnapshot | null;
  /** Calendar dates (YYYY-MM-DD): a PO date has no time or timezone. */
  orderDate: string;
  expectedDate: string | null;
  vendorReference: string | null;
  notes: string | null;
  lines: IPurchaseOrderLine[];
  subtotalMinor: number;
  estimatedTaxMinor: number;
  estimatedTotalMinor: number;
  version: number;
  createdBy: mongoose.Types.ObjectId;
  issued: IStatusEvent | null;
  cancelled: IStatusEvent | null;
  closed: IStatusEvent | null;
  statusReason: string | null;
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type PurchaseOrderDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IPurchaseOrder> &
  IPurchaseOrder;

export type PurchaseOrderModel = mongoose.Model<IPurchaseOrder, Record<string, never>>;

const lineSchema = new Schema<IPurchaseOrderLine>({
  variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  quantityMilli: { type: Number, required: true, min: 1 },
  receivedQuantityMilli: { type: Number, required: true, default: 0, min: 0 },
  unitCostMinor: { type: Number, required: true, min: 0 },
  subtotalMinor: { type: Number, required: true, min: 0 },
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
  estimatedTaxMinor: { type: Number, required: true, min: 0 },
  totalMinor: { type: Number, required: true, min: 0 },
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

const purchaseOrderSchema = new Schema<IPurchaseOrder, PurchaseOrderModel>(
  {
    number: { type: String, required: true },
    sequence: { type: Number, required: true },
    status: { type: String, enum: PURCHASE_ORDER_STATUSES, required: true, default: "draft" },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    vendorSnapshot: { type: vendorSnapshotSchema, default: null },
    orderDate: { type: String, required: true },
    expectedDate: { type: String, default: null },
    vendorReference: { type: String, default: null },
    notes: { type: String, default: null },
    lines: { type: [lineSchema], required: true },
    subtotalMinor: { type: Number, required: true },
    estimatedTaxMinor: { type: Number, required: true },
    estimatedTotalMinor: { type: Number, required: true },
    version: { type: Number, required: true, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    issued: { type: statusEventSchema, default: null },
    cancelled: { type: statusEventSchema, default: null },
    closed: { type: statusEventSchema, default: null },
    statusReason: { type: String, default: null },
  },
  { timestamps: true }
);

/** Numbers are never reused, so deleted drafts stay in the index. */
purchaseOrderSchema.index({ organizationId: 1, number: 1 }, { unique: true });
/** Newest number first, per store and across stores. */
purchaseOrderSchema.index({ organizationId: 1, storeId: 1, sequence: -1 });
purchaseOrderSchema.index({ organizationId: 1, sequence: -1 });
purchaseOrderSchema.index({ organizationId: 1, vendorId: 1 });
/** The open-PO check on product and variant delete. */
purchaseOrderSchema.index({ organizationId: 1, "lines.variantId": 1, status: 1 });

purchaseOrderSchema.plugin(tenantScopePlugin, { scope: "organization+store" });

const PurchaseOrder = mongoose.model<IPurchaseOrder, PurchaseOrderModel>("PurchaseOrder", purchaseOrderSchema);

export default PurchaseOrder;
export { PurchaseOrder };
