/**
 * Purpose: StockMovement model definition.
 * The stock ledger: one row per change to one variant's stock in one store. Append-only: a
 * movement is never updated or deleted, and a mistake is corrected by a new adjustment. The
 * model refuses update and delete queries outright so no code path can rewrite history.
 *
 * Quantities are in thousandths (see utils/quantity.ts); money in minor units of the
 * organization's currency, VAT-exclusive.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";
import { MOVEMENT_TYPES, MovementType } from "../validators/stock.validator";

export { MOVEMENT_TYPES };
export type { MovementType };

export const MOVEMENT_SOURCE_TYPES = ["product", "adjustment", "transfer", "goods_receipt"] as const;
export type MovementSourceType = (typeof MOVEMENT_SOURCE_TYPES)[number];

export interface IMovementSource {
  type: MovementSourceType;
  id: mongoose.Types.ObjectId;
  /** The source document's display number, when it has one (GRN-00001 for a goods receipt). */
  number: string | null;
}

export interface IStockMovement {
  organizationId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  variantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  type: MovementType;
  /** Signed: positive adds stock. */
  quantityMilli: number;
  quantityAfterMilli: number;
  unitCostMinor: number;
  /** Signed: quantity × unit cost, or the exact remaining value when the stock is emptied. */
  valueChangeMinor: number;
  source: IMovementSource;
  reason: string | null;
  note: string | null;
  createdBy: mongoose.Types.ObjectId | null;
  createdAt?: Date;
}

export type StockMovementDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IStockMovement> &
  IStockMovement;

export type StockMovementModel = mongoose.Model<IStockMovement, Record<string, never>>;

const integer = { validator: Number.isSafeInteger, message: "must be a whole number" };

const stockMovementSchema = new Schema<IStockMovement, StockMovementModel>(
  {
    variantId: { type: Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    quantityMilli: { type: Number, required: true, validate: integer },
    quantityAfterMilli: { type: Number, required: true, validate: integer },
    unitCostMinor: { type: Number, required: true, min: 0, validate: integer },
    valueChangeMinor: { type: Number, required: true, validate: integer },
    source: {
      type: { type: String, enum: MOVEMENT_SOURCE_TYPES, required: true },
      id: { type: Schema.Types.ObjectId, required: true },
      number: { type: String, default: null },
    },
    reason: { type: String, default: null },
    note: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

/** A store's history, newest first. */
stockMovementSchema.index({ organizationId: 1, storeId: 1, createdAt: -1, _id: -1 });

/** A variant's history, and the "has this variant ever moved" check (in-use and unit locks). */
stockMovementSchema.index({ organizationId: 1, variantId: 1, createdAt: -1 });

/** A product's movements (PRODUCT_IN_USE). */
stockMovementSchema.index({ organizationId: 1, productId: 1 });

/** Movements of one source document. */
stockMovementSchema.index({ organizationId: 1, "source.type": 1, "source.id": 1 });

const APPEND_ONLY = [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const;

for (const method of APPEND_ONLY) {
  stockMovementSchema.pre(method as never, function () {
    throw new Error(`Stock movements are append-only; ${method} is not allowed.`);
  });
}

stockMovementSchema.plugin(tenantScopePlugin, { scope: "organization+store", softDelete: false });

const StockMovement = mongoose.model<IStockMovement, StockMovementModel>("StockMovement", stockMovementSchema);

export default StockMovement;
export { StockMovement };
