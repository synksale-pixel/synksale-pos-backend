/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Category model definition.
 * A flat, organization-wide group of products. Ordered by `sortOrder`, then name. A `parentId`
 * may be added later without changing existing documents.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export interface ICategory {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  /** Lowercased, trimmed name; backs the per-organization uniqueness index and the name sort. */
  nameKey: string;
  sortOrder: number;
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CategoryDocument = Document<
  mongoose.Types.ObjectId,
  Record<string, never>,
  ICategory
> &
  ICategory;

export type CategoryModel = mongoose.Model<ICategory, Record<string, never>>;

const categorySchema = new Schema<ICategory, CategoryModel>(
  {
    name: {
      type: String,
      required: [true, "Category name is required"],
      trim: true,
      maxlength: [60, "Category name must be at most 60 characters long"],
    },
    nameKey: {
      type: String,
      required: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      min: [0, "sortOrder cannot be negative"],
      validate: {
        validator: Number.isInteger,
        message: "sortOrder must be a whole number",
      },
    },
  },
  {
    timestamps: true,
  }
);

/** Keeps nameKey derived from name, whatever path saved the doc. */
categorySchema.pre("validate", function (next) {
  if (this.name) {
    this.nameKey = this.name.trim().toLowerCase();
  }
  next();
});

/** Name unique per organization among non-deleted categories, so a deleted name can be reused. */
categorySchema.index(
  { organizationId: 1, nameKey: 1 },
  { unique: true, partialFilterExpression: { isDelete: false } }
);

/** Serves the list order: sortOrder ascending, ties by name. */
categorySchema.index({ organizationId: 1, sortOrder: 1, nameKey: 1 });

categorySchema.plugin(tenantScopePlugin, { scope: "organization" });

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  delete ret.nameKey;
  return ret;
};

categorySchema.set("toJSON", {
  transform: cleanTransform,
  virtuals: true,
});

categorySchema.set("toObject", {
  transform: cleanTransform,
  virtuals: true,
});

const Category = mongoose.model<ICategory, CategoryModel>("Category", categorySchema);

export default Category;
export { Category };
