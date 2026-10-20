/**
 * Purpose: StockLevel model definition.
 * How much of one variant one store holds, and what it is worth. A projection of the stock
 * ledger (StockMovement): it is only ever written by stock.service, in the same transaction as
 * the movement that changes it, and never edited directly.
 *
 * - quantityMilli: quantity × 1000 (see utils/quantity.ts); negative only when the organization
 *   allows negative stock.
 * - valueMinor: the weighted-average value of the quantity on hand, in minor units of the
 *   organization's currency, VAT-exclusive. Kept instead of a rounded average so repeated
 *   receipts do not drift; 0 whenever the quantity is 0 or negative.
 * - avgCostMinor: the average cost per unit (rounded), kept while the quantity is 0 or negative
 *   so stock removed then still has a cost. Null until the variant first receives stock here.
 *
 * No row means the store never held the variant (quantity 0).
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export interface IStockLevel {
  organizationId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  variantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  quantityMilli: number;
  valueMinor: number;
  avgCostMinor: number | null;
  lastMovementAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type StockLevelDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IStockLevel> & IStockLevel;

export type StockLevelModel = mongoose.Model<IStockLevel, Record<string, never>>;

const wholeNumber = (label: string) => ({
  validator: (value: number | null) => value === null || Number.isSafeInteger(value),
  message: `${label} must be a whole number`,
});

const stockLevelSchema = new Schema<IStockLevel, StockLevelModel>(
  {
    variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true, immutable: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, immutable: true },
    quantityMilli: { type: Number, required: true, default: 0, validate: wholeNumber("quantityMilli") },
    valueMinor: { type: Number, required: true, default: 0, min: 0, validate: wholeNumber("valueMinor") },
    avgCostMinor: { type: Number, default: null, min: 0, validate: wholeNumber("avgCostMinor") },
    lastMovementAt: { type: Date, required: true },
  },
  { timestamps: true }
);

/** One row per store and variant. */
stockLevelSchema.index({ organizationId: 1, storeId: 1, variantId: 1 }, { unique: true });

/** Organization-wide totals per variant (stockOnHand, the product stock tab). */
stockLevelSchema.index({ organizationId: 1, variantId: 1 });

// Never soft-deleted: a level is a projection of an append-only ledger.
stockLevelSchema.plugin(tenantScopePlugin, { scope: "organization+store", softDelete: false });

const StockLevel = mongoose.model<IStockLevel, StockLevelModel>("StockLevel", stockLevelSchema);

export default StockLevel;
export { StockLevel };
