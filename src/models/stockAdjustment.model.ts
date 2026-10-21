/**
 * Purpose: StockAdjustment model definition.
 * One adjustment document per save of the adjustment screen: a reason, an optional note and one
 * line per variant, each recording the quantity before, the change and the quantity after. The
 * stock itself changes through the movements it writes (source.type "adjustment").
 * Append-only like the ledger it belongs to: never edited or deleted.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";
import { ADJUSTMENT_REASONS, AdjustmentReason } from "../validators/stock.validator";

export interface IStockAdjustmentLine {
  variantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  mode: "change" | "count";
  countedQuantityMilli: number | null;
  quantityBeforeMilli: number;
  /** 0 when a count matched the stock (no movement was written for the line). */
  quantityChangeMilli: number;
  quantityAfterMilli: number;
  unitCostMinor: number;
  valueChangeMinor: number;
}

export interface IStockAdjustment {
  organizationId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  reason: AdjustmentReason;
  note: string | null;
  lines: IStockAdjustmentLine[];
  valueChangeMinor: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

export type StockAdjustmentDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IStockAdjustment> &
  IStockAdjustment;

export type StockAdjustmentModel = mongoose.Model<IStockAdjustment, Record<string, never>>;

const lineSchema = new Schema<IStockAdjustmentLine>(
  {
    variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    mode: { type: String, enum: ["change", "count"], required: true },
    countedQuantityMilli: { type: Number, default: null },
    quantityBeforeMilli: { type: Number, required: true },
    quantityChangeMilli: { type: Number, required: true },
    quantityAfterMilli: { type: Number, required: true },
    unitCostMinor: { type: Number, required: true, min: 0 },
    valueChangeMinor: { type: Number, required: true },
  },
  { _id: false }
);

const stockAdjustmentSchema = new Schema<IStockAdjustment, StockAdjustmentModel>(
  {
    reason: { type: String, enum: ADJUSTMENT_REASONS, required: true },
    note: { type: String, default: null },
    lines: { type: [lineSchema], required: true },
    valueChangeMinor: { type: Number, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

/** A store's adjustments, newest first. */
stockAdjustmentSchema.index({ organizationId: 1, storeId: 1, createdAt: -1, _id: -1 });

stockAdjustmentSchema.plugin(tenantScopePlugin, { scope: "organization+store", softDelete: false });

const StockAdjustment = mongoose.model<IStockAdjustment, StockAdjustmentModel>("StockAdjustment", stockAdjustmentSchema);

export default StockAdjustment;
export { StockAdjustment };
