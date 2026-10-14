/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Product model definition.
 * The organization-wide catalog entry: what is sold, how it is taxed and grouped. Everything that
 * differs per sellable unit (SKU, barcodes, prices, reorder point) lives on ProductVariant; every
 * product has at least one variant, and a `single` item has exactly one with `isDefault: true`.
 * Stock, purchase and sale lines reference the variant, never the product.
 *
 * `type` and `itemType` are fixed at creation. Opening stock is not stored here; it arrives with
 * the stock ledger (Phase 2).
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";
import { DEFAULT_UNIT, UNIT_CODES } from "../config/units.config";

export const PRODUCT_TYPES = ["goods", "service"] as const;
export const ITEM_TYPES = ["single", "variant"] as const;
export const TAX_PREFERENCES = ["standard", "zero_rated", "exempt", "out_of_scope"] as const;

export type ProductType = (typeof PRODUCT_TYPES)[number];
export type ItemType = (typeof ITEM_TYPES)[number];
export type TaxPreference = (typeof TAX_PREFERENCES)[number];

export interface IProductAttribute {
  name: string;
  options: string[];
}

export interface IProduct {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  /** Lowercased, trimmed name; backs the case-insensitive prefix search and the name sort. */
  nameKey: string;
  type: ProductType;
  itemType: ItemType;
  categoryId: mongoose.Types.ObjectId | null;
  unit: string;
  brand: string | null;
  manufacturer: string | null;
  taxPreference: TaxPreference;
  /** Set only when taxPreference is standard (the service resolves the org default when omitted). */
  taxRateId: mongoose.Types.ObjectId | null;
  imageUrl: string | null;
  dimensions: { length: number; width: number; height: number; unit: "cm" | "in" } | null;
  weight: { value: number; unit: "kg" | "lb" } | null;
  reportingTags: string[];
  sales: { description: string | null };
  purchase: { description: string | null; preferredVendorName: string | null };
  inventory: {
    trackInventory: boolean;
    returnable: boolean;
    valuationMethod: "weighted_average";
  };
  /** Variant items only (empty for single items). Variant attributeValues must use these options. */
  attributes: IProductAttribute[];
  isActive: boolean;
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ProductDocument = Document<
  mongoose.Types.ObjectId,
  Record<string, never>,
  IProduct
> &
  IProduct;

export type ProductModel = mongoose.Model<IProduct, Record<string, never>>;

const nullableText = { type: String, trim: true, default: null };

const attributeSchema = new Schema<IProductAttribute>(
  {
    name: { type: String, required: true, trim: true },
    options: { type: [{ type: String, trim: true }], default: [] },
  },
  { _id: false }
);

const productSchema = new Schema<IProduct, ProductModel>(
  {
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
      maxlength: [200, "Product name must be at most 200 characters long"],
    },
    nameKey: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: PRODUCT_TYPES,
      required: [true, "Product type is required"],
      immutable: true,
    },
    itemType: {
      type: String,
      enum: ITEM_TYPES,
      default: "single",
      immutable: true,
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    unit: {
      type: String,
      enum: UNIT_CODES,
      default: DEFAULT_UNIT,
    },
    brand: nullableText,
    manufacturer: nullableText,
    taxPreference: {
      type: String,
      enum: TAX_PREFERENCES,
      default: "standard",
    },
    taxRateId: {
      type: Schema.Types.ObjectId,
      ref: "TaxRate",
      default: null,
    },
    imageUrl: nullableText,
    dimensions: {
      type: new Schema(
        {
          length: { type: Number, required: true, min: 0 },
          width: { type: Number, required: true, min: 0 },
          height: { type: Number, required: true, min: 0 },
          unit: { type: String, enum: ["cm", "in"], required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    weight: {
      type: new Schema(
        {
          value: { type: Number, required: true, min: 0 },
          unit: { type: String, enum: ["kg", "lb"], required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    reportingTags: {
      type: [{ type: String, trim: true }],
      default: [],
    },
    sales: {
      description: nullableText,
    },
    purchase: {
      description: nullableText,
      preferredVendorName: nullableText,
    },
    inventory: {
      trackInventory: { type: Boolean, default: true },
      returnable: { type: Boolean, default: true },
      valuationMethod: {
        type: String,
        enum: ["weighted_average"],
        default: "weighted_average",
      },
    },
    attributes: {
      type: [attributeSchema],
      default: [],
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
 * Keeps nameKey derived from name and enforces the rules no update path may break: a service
 * never tracks inventory, and only a standard-rated product carries a tax rate. Runs on save()
 * and create() only; the service applies the same rules before any query-style update.
 */
productSchema.pre("validate", function (next) {
  if (this.name) {
    this.nameKey = this.name.trim().toLowerCase();
  }
  if (this.type === "service") {
    this.inventory.trackInventory = false;
  }
  if (this.taxPreference !== "standard") {
    this.taxRateId = null;
  }
  if (this.itemType === "single" && this.attributes.length > 0) {
    this.invalidate("attributes", "Only variant items have attributes");
  }
  next();
});

/** Default list order and case-insensitive name prefix search (`^term` on nameKey). */
productSchema.index({ organizationId: 1, nameKey: 1 });

/** Category filter, and the productCount shown on each category. */
productSchema.index({ organizationId: 1, categoryId: 1 });

/** Reporting-tag filter (multikey). */
productSchema.index({ organizationId: 1, reportingTags: 1 });

/** Tax-rate-in-use guard: a rate referenced by a product cannot be deleted. */
productSchema.index({ organizationId: 1, taxRateId: 1 });

productSchema.plugin(tenantScopePlugin, { scope: "organization" });

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  delete ret.nameKey;
  return ret;
};

productSchema.set("toJSON", {
  transform: cleanTransform,
  virtuals: true,
});

productSchema.set("toObject", {
  transform: cleanTransform,
  virtuals: true,
});

const Product = mongoose.model<IProduct, ProductModel>("Product", productSchema);

export default Product;
export { Product };
