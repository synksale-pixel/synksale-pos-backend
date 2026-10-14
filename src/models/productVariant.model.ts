/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: ProductVariant model definition.
 * One sellable unit of a Product: what is scanned, priced, stocked and put on sale/purchase lines.
 * A `single` item has exactly one variant with `isDefault: true` and empty attributeValues; a
 * `variant` item has one per attribute combination.
 *
 * Money is stored as integer minor units (fils, cents) of the organization's currency, which
 * cannot change once products exist. Selling prices are as entered (VAT-inclusive when the org's
 * `settings.sales.pricesIncludeTax` is true); cost prices are always VAT-exclusive.
 *
 * Uniqueness within an organization (case-insensitive, non-deleted variants only):
 * - SKU, when present (skuKey).
 * - Every scannable barcode (UPC, EAN, ISBN) across all three kinds (scanCodes), so a scan
 *   resolves to exactly one variant. MPN is reference-only and not unique.
 * - The attribute combination within its product (comboKey).
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export interface IProductBarcodes {
  upc: string | null;
  ean: string | null;
  isbn: string | null;
  mpn: string | null;
}

export interface IProductVariant {
  organizationId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  /** Attribute name -> option, e.g. { Size: "M", Colour: "Red" }. Empty for a default variant. */
  attributeValues: Map<string, string>;
  /**
   * Lowercased values in the product's attribute order, joined by \u0000; "" for a default
   * variant. Set by the service, which knows the attribute order. Backs combination uniqueness.
   */
  comboKey: string;
  sku: string | null;
  /** Lowercased SKU; backs case-insensitive uniqueness and lookup. Null when there is no SKU. */
  skuKey: string | null;
  barcodes: IProductBarcodes;
  /** The distinct UPC/EAN/ISBN values; backs barcode uniqueness and scan lookup. */
  scanCodes: string[];
  /** Minor units of the org currency. */
  sellingPriceMinor: number;
  /** Minor units of the org currency, VAT-exclusive. Null when unknown. */
  costPriceMinor: number | null;
  /** In the product's unit; at most 3 decimals. Null when not set. */
  reorderPoint: number | null;
  isDefault: boolean;
  isActive: boolean;
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ProductVariantDocument = Document<
  mongoose.Types.ObjectId,
  Record<string, never>,
  IProductVariant
> &
  IProductVariant;

export type ProductVariantModel = mongoose.Model<IProductVariant, Record<string, never>>;

const nullableCode = { type: String, trim: true, default: null };

const minorAmount = (label: string) => ({
  min: [0, `${label} cannot be negative`] as [number, string],
  validate: {
    validator: (value: number | null) => value === null || Number.isSafeInteger(value),
    message: `${label} must be a whole number of minor units`,
  },
});

const productVariantSchema = new Schema<IProductVariant, ProductVariantModel>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: [true, "Product reference is required"],
      immutable: true,
    },
    attributeValues: {
      type: Map,
      of: String,
      default: () => new Map(),
      immutable: true,
    },
    comboKey: {
      type: String,
      default: "",
      immutable: true,
    },
    sku: {
      type: String,
      trim: true,
      default: null,
    },
    skuKey: {
      type: String,
      default: null,
    },
    barcodes: {
      upc: nullableCode,
      ean: nullableCode,
      isbn: nullableCode,
      mpn: nullableCode,
    },
    scanCodes: {
      type: [String],
      default: [],
    },
    sellingPriceMinor: {
      type: Number,
      required: [true, "Selling price is required"],
      ...minorAmount("Selling price"),
    },
    costPriceMinor: {
      type: Number,
      default: null,
      ...minorAmount("Cost price"),
    },
    reorderPoint: {
      type: Number,
      default: null,
      min: [0, "Reorder point cannot be negative"],
    },
    isDefault: {
      type: Boolean,
      default: false,
      immutable: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Keeps skuKey and scanCodes derived from their sources on save() and create(). Query-style
 * updates skip this hook, so the service sets them alongside sku/barcodes on every update.
 */
productVariantSchema.pre("validate", function (next) {
  this.skuKey = this.sku ? this.sku.trim().toLowerCase() : null;
  this.scanCodes = deriveScanCodes(this.barcodes);
  next();
});

/** The distinct scannable codes of a variant (a book's ISBN-13 is usually also its EAN-13). */
export function deriveScanCodes(barcodes: Partial<IProductBarcodes> | null | undefined): string[] {
  if (!barcodes) return [];
  const codes = [barcodes.upc, barcodes.ean, barcodes.isbn].filter(
    (code): code is string => typeof code === "string" && code.length > 0
  );
  return [...new Set(codes)];
}

/** Loads a product's variants in creation order. */
productVariantSchema.index({ organizationId: 1, productId: 1 });

/** One variant per attribute combination within a product. */
productVariantSchema.index(
  { organizationId: 1, productId: 1, comboKey: 1 },
  { unique: true, partialFilterExpression: { isDelete: false } }
);

/** At most one default variant per product. */
productVariantSchema.index(
  { productId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true, isDelete: false } }
);

/**
 * SKU unique per organization when present. `$type: "string"` keeps SKU-less variants (null) out
 * of the index, so any number of them can coexist.
 */
productVariantSchema.index(
  { organizationId: 1, skuKey: 1 },
  { unique: true, partialFilterExpression: { isDelete: false, skuKey: { $type: "string" } } }
);

/**
 * Each scannable code unique per organization (multikey). `$type: "string"` matches only arrays
 * with at least one element; without it every variant with no barcodes would index as the same
 * empty key and collide.
 */
productVariantSchema.index(
  { organizationId: 1, scanCodes: 1 },
  { unique: true, partialFilterExpression: { isDelete: false, scanCodes: { $type: "string" } } }
);

productVariantSchema.plugin(tenantScopePlugin, { scope: "organization" });

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  delete ret.skuKey;
  delete ret.scanCodes;
  delete ret.comboKey;
  return ret;
};

productVariantSchema.set("toJSON", {
  transform: cleanTransform,
  virtuals: true,
});

productVariantSchema.set("toObject", {
  transform: cleanTransform,
  virtuals: true,
});

const ProductVariant = mongoose.model<IProductVariant, ProductVariantModel>(
  "ProductVariant",
  productVariantSchema
);

export default ProductVariant;
export { ProductVariant };
