/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: TaxRate model definition.
 * An organization-wide VAT (or GST) rate that products and document lines point to. A rate is a
 * list of components so a single-rate VAT ("VAT 10%") and a split tax ("CGST 9% + SGST 9%") share
 * one shape. Document lines copy the rate they used, so editing a rate never rewrites history.
 */

import mongoose, { Schema, Document } from "mongoose";
import Decimal from "decimal.js";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export interface ITaxComponent {
  name: string;
  /** Percentage, up to 4 decimal places (e.g. 10 or 2.5). */
  rate: number;
}

export interface ITaxRate {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  /** Lowercased, trimmed name; backs the per-organization uniqueness index. */
  nameKey: string;
  components: ITaxComponent[];
  /** Sum of the component rates, maintained on validate. */
  rate: number;
  /** The rate pre-selected for new products. At most one per organization. */
  isDefault: boolean;
  isActive: boolean;
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type TaxRateDocument = Document<
  mongoose.Types.ObjectId,
  Record<string, never>,
  ITaxRate
> &
  ITaxRate;

export type TaxRateModel = mongoose.Model<ITaxRate, Record<string, never>>;

const componentSchema = new Schema<ITaxComponent>(
  {
    name: {
      type: String,
      required: [true, "Tax component name is required"],
      trim: true,
    },
    rate: {
      type: Number,
      required: [true, "Tax component rate is required"],
      min: [0, "Tax rate cannot be negative"],
      max: [100, "Tax rate cannot exceed 100%"],
    },
  },
  { _id: false }
);

const taxRateSchema = new Schema<ITaxRate, TaxRateModel>(
  {
    name: {
      type: String,
      required: [true, "Tax rate name is required"],
      trim: true,
    },
    nameKey: {
      type: String,
      required: true,
    },
    components: {
      type: [componentSchema],
      validate: {
        validator: (value: ITaxComponent[]) => Array.isArray(value) && value.length > 0,
        message: "A tax rate needs at least one component",
      },
    },
    rate: {
      type: Number,
      min: [0, "Tax rate cannot be negative"],
      max: [100, "Tax rate cannot exceed 100%"],
    },
    isDefault: {
      type: Boolean,
      default: false,
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

/** Keeps nameKey and the total rate derived from their sources, whatever path saved the doc. */
taxRateSchema.pre("validate", function (next) {
  if (this.name) {
    this.nameKey = this.name.trim().toLowerCase();
  }
  if (Array.isArray(this.components)) {
    this.rate = this.components
      .reduce((total, component) => total.plus(component.rate ?? 0), new Decimal(0))
      .toNumber();
  }
  next();
});

/** Name unique per organization among non-deleted rates, so a deleted name can be reused. */
taxRateSchema.index(
  { organizationId: 1, nameKey: 1 },
  { unique: true, partialFilterExpression: { isDelete: false } }
);

/** At most one default rate per organization, enforced by MongoDB. */
taxRateSchema.index(
  { organizationId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true, isDelete: false } }
);

taxRateSchema.plugin(tenantScopePlugin, { scope: "organization" });

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  delete ret.nameKey;
  return ret;
};

taxRateSchema.set("toJSON", {
  transform: cleanTransform,
  virtuals: true,
});

taxRateSchema.set("toObject", {
  transform: cleanTransform,
  virtuals: true,
});

const TaxRate = mongoose.model<ITaxRate, TaxRateModel>("TaxRate", taxRateSchema);

export default TaxRate;
export { TaxRate };
