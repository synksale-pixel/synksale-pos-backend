/**
 * Purpose: StockTransfer model definition.
 * A one-step transfer between two stores of the organization: every line leaves fromStoreId and
 * arrives at toStoreId in the same transaction (a transfer_out and a transfer_in movement), at the
 * source store's average cost. Organization-scoped rather than store-scoped because it spans two
 * stores. Append-only: never edited or deleted.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export interface IStockTransferLine {
  variantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  quantityMilli: number;
  unitCostMinor: number;
  /** quantity × the source's average cost: the value that left the source and reached the destination. */
  valueMinor: number;
  fromQuantityAfterMilli: number;
  toQuantityAfterMilli: number;
}

export interface IStockTransfer {
  organizationId: mongoose.Types.ObjectId;
  fromStoreId: mongoose.Types.ObjectId;
  toStoreId: mongoose.Types.ObjectId;
  note: string | null;
  lines: IStockTransferLine[];
  totalValueMinor: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

export type StockTransferDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IStockTransfer> &
  IStockTransfer;

export type StockTransferModel = mongoose.Model<IStockTransfer, Record<string, never>>;

const lineSchema = new Schema<IStockTransferLine>(
  {
    variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    quantityMilli: { type: Number, required: true, min: 1 },
    unitCostMinor: { type: Number, required: true, min: 0 },
    valueMinor: { type: Number, required: true, min: 0 },
    fromQuantityAfterMilli: { type: Number, required: true },
    toQuantityAfterMilli: { type: Number, required: true },
  },
  { _id: false }
);

const stockTransferSchema = new Schema<IStockTransfer, StockTransferModel>(
  {
    fromStoreId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    toStoreId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    note: { type: String, default: null },
    lines: { type: [lineSchema], required: true },
    totalValueMinor: { type: Number, required: true, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

stockTransferSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });
stockTransferSchema.index({ organizationId: 1, fromStoreId: 1, createdAt: -1 });
stockTransferSchema.index({ organizationId: 1, toStoreId: 1, createdAt: -1 });

stockTransferSchema.plugin(tenantScopePlugin, { scope: "organization", softDelete: false });

const StockTransfer = mongoose.model<IStockTransfer, StockTransferModel>("StockTransfer", stockTransferSchema);

export default StockTransfer;
export { StockTransfer };
