/**
 * Purpose: Category Service.
 * Creating, listing, renaming/reordering and deleting an organization's product categories.
 * Each category is returned with its productCount (non-deleted products in it).
 * Category is organization-scoped by the tenantScopePlugin; organizationId is still passed
 * explicitly, as in every other service.
 */

import mongoose from "mongoose";
import { Category, CategoryDocument } from "../models/category.model";
import { Product } from "../models/product.model";
import { ApiError } from "../utils/ApiError";
import { logger } from "../config/logger.config";
import type { CreateCategoryInput, UpdateCategoryInput } from "../validators/category.validator";

function nameTaken(name: string): ApiError {
  return ApiError.coded(409, "CATEGORY_NAME_TAKEN", `A category named '${name}' already exists.`, [
    { field: "name", code: "CATEGORY_NAME_TAKEN" },
  ]);
}

function isDuplicateKey(error: unknown, field: string): boolean {
  const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
  return dup.code === 11000 && Boolean(dup.keyPattern?.[field]);
}

/** Thrown by the category lookups; the product service reports a bad categoryId as 400. */
export function categoryNotFound(statusCode = 404): ApiError {
  return ApiError.coded(statusCode, "CATEGORY_NOT_FOUND", "Category not found.", [
    { field: "categoryId", code: "CATEGORY_NOT_FOUND" },
  ]);
}

async function findCategoryOrThrow(organizationId: string, categoryId: string) {
  const category = await Category.findOne({ _id: categoryId, organizationId });
  if (!category) {
    throw categoryNotFound();
  }
  return category;
}

/** Non-deleted product counts per category, for the given categories. */
async function countProducts(
  organizationId: string,
  categoryIds: mongoose.Types.ObjectId[]
): Promise<Map<string, number>> {
  const rows = await Product.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    {
      $match: {
        organizationId: new mongoose.Types.ObjectId(organizationId),
        categoryId: { $in: categoryIds },
      },
    },
    { $group: { _id: "$categoryId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
}

/** The documented Category shape: deleted categories are never returned, so isDelete is noise. */
function toView(category: CategoryDocument, productCount: number) {
  const { isDelete: _isDelete, ...view } = category.toJSON();
  return { ...view, productCount };
}

/** Every category in the organization (a flat, unpaginated list), by sortOrder then name. */
export async function listCategories(organizationId: string) {
  const categories = await Category.find({ organizationId }).sort({ sortOrder: 1, nameKey: 1, _id: 1 });
  const counts = await countProducts(
    organizationId,
    categories.map((category) => category._id)
  );
  return {
    categories: categories.map((category) => toView(category, counts.get(category._id.toString()) ?? 0)),
  };
}

export async function getCategory(organizationId: string, categoryId: string) {
  const category = await findCategoryOrThrow(organizationId, categoryId);
  const counts = await countProducts(organizationId, [category._id]);
  return toView(category, counts.get(category._id.toString()) ?? 0);
}

/**
 * Confirms a category exists for a product to reference. A missing one is the caller's input
 * error (400), not a missing resource of the request path.
 */
export async function assertCategoryExists(organizationId: string, categoryId: string) {
  if (!(await Category.exists({ _id: categoryId, organizationId }))) {
    throw categoryNotFound(400);
  }
}

export async function createCategory(organizationId: string, input: CreateCategoryInput, actorUserId: string) {
  const nameKey = input.name.trim().toLowerCase();
  if (await Category.exists({ organizationId, nameKey })) {
    throw nameTaken(input.name);
  }

  let category: CategoryDocument;
  try {
    category = await Category.create({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      name: input.name,
      sortOrder: input.sortOrder,
    });
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) {
      throw nameTaken(input.name);
    }
    throw error;
  }

  logger.info(`Category created: ${category._id} org=${organizationId} by user=${actorUserId}`);
  return toView(category, 0);
}

export async function updateCategory(
  organizationId: string,
  categoryId: string,
  input: UpdateCategoryInput,
  actorUserId: string
) {
  const category = await findCategoryOrThrow(organizationId, categoryId);

  if (input.name !== undefined) {
    const nameKey = input.name.trim().toLowerCase();
    if (nameKey !== category.nameKey && (await Category.exists({ organizationId, nameKey }))) {
      throw nameTaken(input.name);
    }
    category.name = input.name;
  }
  if (input.sortOrder !== undefined) {
    category.sortOrder = input.sortOrder;
  }

  try {
    // save() (not findOneAndUpdate) so the pre-validate hook re-derives nameKey.
    await category.save();
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) {
      throw nameTaken(input.name ?? category.name);
    }
    throw error;
  }

  logger.info(`Category updated: ${categoryId} org=${organizationId} by user=${actorUserId}`);
  return getCategory(organizationId, categoryId);
}

/** Soft-deletes a category. Refused while any non-deleted product is in it. */
export async function deleteCategory(organizationId: string, categoryId: string, actorUserId: string) {
  const category = await findCategoryOrThrow(organizationId, categoryId);

  const productCount = await Product.countDocuments({ organizationId, categoryId: category._id });
  if (productCount > 0) {
    throw ApiError.coded(
      409,
      "CATEGORY_IN_USE",
      `This category still has ${productCount} product${productCount === 1 ? "" : "s"}. Move them to another category first.`,
      [{ code: "CATEGORY_IN_USE", meta: { productCount } }]
    );
  }

  category.isDelete = true;
  await category.save();

  logger.info(`Category deleted: ${categoryId} org=${organizationId} by user=${actorUserId}`);
}
