/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Category model definition.
 * An organization-wide group of products, optionally nested under a parent category up to
 * MAX_CATEGORY_DEPTH levels (Category → Subcategory). Products may sit on any category, not only
 * the deepest ones. Siblings are ordered by `sortOrder`, then name.
 *
 * The tree is stored as `parentId` plus `ancestors` (root first), so "this category and
 * everything under it" is one indexed query and a move rewrites only the moved subtree.
 * Categories created before nesting existed have neither field; Mongoose fills the defaults on
 * read, and MongoDB matches a missing parentId as null, so they behave as roots.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

/**
 * How many levels the tree may have: 2 means root categories and one level of subcategories.
 * Raising it needs no data change; the service checks depth against this constant.
 */
export const MAX_CATEGORY_DEPTH = 2;

export interface ICategory {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  /** Lowercased, trimmed name; backs the per-organization uniqueness index and the name sort. */
  nameKey: string;
  sortOrder: number;
  /** The parent category, or null for a root category. */
  parentId: mongoose.Types.ObjectId | null;
  /** Every ancestor from the root down to the parent; empty for a root. Its length is the depth. */
  ancestors: mongoose.Types.ObjectId[];
  /**
   * Bumped whenever a child is put under this category. It carries no meaning of its own: the
   * write makes concurrent tree changes on the same parent conflict (see category.service).
   */
  treeVersion: number;
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
    parentId: {
      type: Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    ancestors: {
      type: [{ type: Schema.Types.ObjectId, ref: "Category" }],
      default: [],
    },
    treeVersion: {
      type: Number,
      default: 0,
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

/**
 * Name unique among siblings (non-deleted), so "Accessories" can sit under both Mobiles and
 * Laptops, and a deleted name can be reused. A root's null parentId indexes as null, so roots are
 * unique among themselves. This replaced a per-organization { organizationId, nameKey } index,
 * which must be dropped (npm run sync:indexes -- --apply) or it still refuses sibling-scoped names.
 */
categorySchema.index(
  { organizationId: 1, parentId: 1, nameKey: 1 },
  { unique: true, partialFilterExpression: { isDelete: false } }
);

/** "This category and everything under it" (multikey). */
categorySchema.index({ organizationId: 1, ancestors: 1 });

/** Serves the list order: sortOrder ascending, ties by name. */
categorySchema.index({ organizationId: 1, sortOrder: 1, nameKey: 1 });

categorySchema.plugin(tenantScopePlugin, { scope: "organization" });

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  delete ret.nameKey;
  delete ret.ancestors;
  delete ret.treeVersion;
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
