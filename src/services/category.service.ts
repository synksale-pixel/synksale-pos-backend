/**
 * Purpose: Category Service.
 * Creating, listing, renaming/reordering, nesting/moving and deleting an organization's product
 * categories. Categories nest up to MAX_CATEGORY_DEPTH levels; each is returned with its
 * productCount (non-deleted products directly in it) and totalProductCount (including every
 * subcategory below it).
 * Category is organization-scoped by the tenantScopePlugin; organizationId is still passed
 * explicitly, as in every other service.
 */

import mongoose from "mongoose";
import { Category, CategoryDocument, MAX_CATEGORY_DEPTH } from "../models/category.model";
import { Product } from "../models/product.model";
import { ApiError } from "../utils/ApiError";
import { logger } from "../config/logger.config";
import type { CreateCategoryInput, UpdateCategoryInput } from "../validators/category.validator";

/** Path separator in a category's display path, e.g. "Mobiles › Accessories". */
const PATH_SEPARATOR = " › ";

function nameTaken(name: string, parentName: string | null): ApiError {
  const where = parentName ? ` under '${parentName}'` : " at the top level";
  return ApiError.coded(409, "CATEGORY_NAME_TAKEN", `A category named '${name}' already exists${where}.`, [
    { field: "name", code: "CATEGORY_NAME_TAKEN" },
  ]);
}

function isDuplicateKey(error: unknown, field: string): boolean {
  const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
  return dup.code === 11000 && Boolean(dup.keyPattern?.[field]);
}

/** Thrown by the category lookups; a bad categoryId or parentId in a request body is a 400. */
export function categoryNotFound(statusCode = 404, field = "categoryId"): ApiError {
  return ApiError.coded(statusCode, "CATEGORY_NOT_FOUND", "Category not found.", [
    { field, code: "CATEGORY_NOT_FOUND" },
  ]);
}

function depthExceeded(message: string): ApiError {
  return ApiError.coded(400, "CATEGORY_DEPTH_EXCEEDED", message, [
    { field: "parentId", code: "CATEGORY_DEPTH_EXCEEDED", meta: { maxDepth: MAX_CATEGORY_DEPTH } },
  ]);
}

async function findCategoryOrThrow(organizationId: string, categoryId: string) {
  const category = await Category.findOne({ _id: categoryId, organizationId });
  if (!category) {
    throw categoryNotFound();
  }
  return category;
}

/** Non-deleted product counts per category (direct members only), for the given categories. */
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

/**
 * Direct and subtree product counts for every category in `categories`, which must include all
 * descendants of any category whose total is wanted.
 */
async function productCounts(organizationId: string, categories: CategoryDocument[]) {
  const direct = await countProducts(
    organizationId,
    categories.map((category) => category._id)
  );
  const total = new Map<string, number>();
  for (const category of categories) {
    const own = direct.get(category._id.toString()) ?? 0;
    for (const id of [category._id, ...(category.ancestors ?? [])]) {
      total.set(id.toString(), (total.get(id.toString()) ?? 0) + own);
    }
  }
  return { direct, total };
}

/** The documented Category shape: deleted categories are never returned, so isDelete is noise. */
function toView(
  category: CategoryDocument,
  counts: { direct: Map<string, number>; total: Map<string, number> }
) {
  const { isDelete: _isDelete, ...view } = category.toJSON();
  const id = category._id.toString();
  return {
    ...view,
    parentId: category.parentId ?? null,
    depth: category.ancestors?.length ?? 0,
    productCount: counts.direct.get(id) ?? 0,
    totalProductCount: counts.total.get(id) ?? 0,
  };
}

/**
 * Every category in the organization as a flat, unpaginated list, by sortOrder then name. Clients
 * build the tree from parentId.
 */
export async function listCategories(organizationId: string) {
  const categories = await Category.find({ organizationId }).sort({ sortOrder: 1, nameKey: 1, _id: 1 });
  const counts = await productCounts(organizationId, categories);
  return { categories: categories.map((category) => toView(category, counts)) };
}

export async function getCategory(organizationId: string, categoryId: string) {
  const category = await findCategoryOrThrow(organizationId, categoryId);
  const descendants = await Category.find({ organizationId, ancestors: category._id });
  const counts = await productCounts(organizationId, [category, ...descendants]);
  return toView(category, counts);
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

/** The category and every category below it, for "products in this category" filters. */
export async function categoryWithDescendants(
  organizationId: string,
  categoryId: mongoose.Types.ObjectId
): Promise<mongoose.Types.ObjectId[]> {
  const descendants = await Category.find({ organizationId, ancestors: categoryId }).select("_id");
  return [categoryId, ...descendants.map((category) => category._id)];
}

export interface CategoryRef {
  id: mongoose.Types.ObjectId;
  name: string;
  /** Names from the root down, e.g. "Mobiles › Accessories"; just the name for a root. */
  path: string;
}

/** The {id, name, path} references products show for their category, keyed by category id. */
export async function categoryRefs(
  organizationId: string,
  categoryIds: mongoose.Types.ObjectId[]
): Promise<Map<string, CategoryRef>> {
  const refs = new Map<string, CategoryRef>();
  if (categoryIds.length === 0) return refs;

  const categories = await Category.find({ organizationId, _id: { $in: categoryIds } }).select("name ancestors");
  const ancestorIds = categories.flatMap((category) => category.ancestors ?? []);
  const ancestors =
    ancestorIds.length > 0
      ? await Category.find({ organizationId, _id: { $in: ancestorIds } }).select("name")
      : [];
  const nameOf = new Map(ancestors.map((ancestor) => [ancestor._id.toString(), ancestor.name]));

  for (const category of categories) {
    const names = [...(category.ancestors ?? []).map((id) => nameOf.get(id.toString())), category.name];
    refs.set(category._id.toString(), {
      id: category._id,
      name: category.name,
      path: names.filter(Boolean).join(PATH_SEPARATOR),
    });
  }
  return refs;
}

/**
 * Loads the parent a category will sit under and returns the ancestors it will have. `height` is
 * how many levels the category already has below it (0 for one without subcategories).
 */
async function resolveParent(
  organizationId: string,
  parentId: string | null | undefined,
  height: number,
  session: mongoose.ClientSession
) {
  if (!parentId) {
    return { parent: null, ancestors: [] as mongoose.Types.ObjectId[] };
  }
  const parent = await Category.findOne({ _id: parentId, organizationId }).session(session);
  if (!parent) {
    throw categoryNotFound(400, "parentId");
  }
  const ancestors = [...(parent.ancestors ?? []), parent._id];
  if (ancestors.length + height > MAX_CATEGORY_DEPTH - 1) {
    throw depthExceeded(
      height > 0
        ? `'${parent.name}' cannot take this category: it has subcategories of its own, and categories nest at most ${MAX_CATEGORY_DEPTH} levels.`
        : `'${parent.name}' is already a subcategory; categories nest at most ${MAX_CATEGORY_DEPTH} levels.`
    );
  }
  return { parent, ancestors };
}

/**
 * Writes to a parent the transaction is about to put a child under. Tree rules span documents
 * (a parent's depth, a category's children), and MongoDB only detects a conflict between two
 * transactions that write the same document. With this write, a concurrent move or delete of the
 * parent conflicts with the child being added; the losing transaction is retried and its checks
 * then see the other's result, so the depth limit and "no orphans" hold under concurrency.
 */
async function claimParent(organizationId: string, parentId: mongoose.Types.ObjectId, session: mongoose.ClientSession) {
  await Category.updateOne({ _id: parentId, organizationId }, { $inc: { treeVersion: 1 } }, { session, timestamps: false });
}

/**
 * Tree checks and writes run inside one transaction so they validate the state they write to.
 * connection.transaction() retries on a transient write conflict (see claimParent) and resets the
 * state of documents saved inside it between attempts.
 */
const inTreeTransaction = (work: (session: mongoose.ClientSession) => Promise<void>) =>
  mongoose.connection.transaction(work);

export async function createCategory(organizationId: string, input: CreateCategoryInput, actorUserId: string) {
  const nameKey = input.name.trim().toLowerCase();
  let parentName: string | null = null;
  let categoryId!: mongoose.Types.ObjectId;

  try {
    await inTreeTransaction(async (session) => {
      const { parent, ancestors } = await resolveParent(organizationId, input.parentId, 0, session);
      parentName = parent?.name ?? null;

      if (await Category.exists({ organizationId, parentId: parent?._id ?? null, nameKey }).session(session)) {
        throw nameTaken(input.name, parentName);
      }
      if (parent) {
        await claimParent(organizationId, parent._id, session);
      }
      const [category] = await Category.create(
        [
          {
            organizationId: new mongoose.Types.ObjectId(organizationId),
            name: input.name,
            sortOrder: input.sortOrder,
            parentId: parent?._id ?? null,
            ancestors,
          },
        ],
        { session }
      );
      categoryId = category._id;
    });
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) {
      throw nameTaken(input.name, parentName);
    }
    throw error;
  }

  logger.info(`Category created: ${categoryId} org=${organizationId} by user=${actorUserId}`);
  return getCategory(organizationId, categoryId.toString());
}

/**
 * Renames, reorders and/or moves a category. A move rewrites the ancestors of the category and of
 * every category below it; products keep their categoryId. Everything is read and checked inside
 * the transaction that writes it, so a subcategory added meanwhile is either seen by the checks
 * or makes this transaction conflict and retry.
 */
export async function updateCategory(
  organizationId: string,
  categoryId: string,
  input: UpdateCategoryInput,
  actorUserId: string
) {
  // Outside the transaction only to give a missing category its 404 without opening one.
  await findCategoryOrThrow(organizationId, categoryId);

  let name = input.name ?? "";
  let parentName: string | null = null;
  let moving = false;

  try {
    await inTreeTransaction(async (session) => {
      const category = await Category.findOne({ _id: categoryId, organizationId }).session(session);
      if (!category) {
        throw categoryNotFound();
      }
      const currentParentId = category.parentId ? category.parentId.toString() : null;
      moving = input.parentId !== undefined && input.parentId !== currentParentId;
      name = input.name ?? category.name;
      const oldDepth = category.ancestors?.length ?? 0;

      let newAncestors = category.ancestors ?? [];
      if (moving) {
        if (input.parentId === categoryId) {
          throw ApiError.coded(400, "CATEGORY_CYCLE", "A category cannot be its own parent.", [
            { field: "parentId", code: "CATEGORY_CYCLE" },
          ]);
        }
        const descendants = await Category.find({ organizationId, ancestors: category._id })
          .select("ancestors")
          .session(session);
        if (input.parentId && descendants.some((descendant) => descendant._id.toString() === input.parentId)) {
          throw ApiError.coded(400, "CATEGORY_CYCLE", "A category cannot be moved under one of its own subcategories.", [
            { field: "parentId", code: "CATEGORY_CYCLE" },
          ]);
        }
        const height = descendants.reduce((max, d) => Math.max(max, (d.ancestors?.length ?? 0) - oldDepth), 0);
        const resolved = await resolveParent(organizationId, input.parentId, height, session);
        parentName = resolved.parent?.name ?? null;
        newAncestors = resolved.ancestors;
        if (resolved.parent) {
          await claimParent(organizationId, resolved.parent._id, session);
        }
      } else if (category.parentId) {
        parentName =
          (await Category.findOne({ _id: category.parentId, organizationId }).select("name").session(session))?.name ??
          null;
      }

      const nameKey = name.trim().toLowerCase();
      const newParentId = moving ? (input.parentId ?? null) : category.parentId;
      if (
        (nameKey !== category.nameKey || moving) &&
        (await Category.exists({ organizationId, parentId: newParentId, nameKey, _id: { $ne: category._id } }).session(
          session
        ))
      ) {
        throw nameTaken(name, parentName);
      }

      if (input.name !== undefined) category.name = input.name;
      if (input.sortOrder !== undefined) category.sortOrder = input.sortOrder;
      if (moving) {
        category.parentId = input.parentId ? new mongoose.Types.ObjectId(input.parentId) : null;
        category.ancestors = newAncestors;
      }
      // save() (not findOneAndUpdate) so the pre-validate hook re-derives nameKey. Saving the
      // category also makes a concurrent "add a child under it" conflict with this move.
      await category.save({ session });

      if (!moving) return;
      const descendants = await Category.find({ organizationId, ancestors: category._id })
        .select("ancestors")
        .session(session);
      for (const descendant of descendants) {
        await Category.updateOne(
          { _id: descendant._id, organizationId },
          { $set: { ancestors: [...newAncestors, category._id, ...descendant.ancestors.slice(oldDepth + 1)] } },
          { session }
        );
      }
    });
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) {
      throw nameTaken(name, parentName);
    }
    throw error;
  }

  logger.info(
    `Category updated${moving ? ` (moved under ${input.parentId ?? "top level"})` : ""}: ${categoryId} org=${organizationId} by user=${actorUserId}`
  );
  return getCategory(organizationId, categoryId);
}

/**
 * Soft-deletes a category. Refused while any non-deleted product or subcategory is in it. The
 * subcategory check and the delete share a transaction: a child added concurrently claims this
 * category (claimParent), so one of the two conflicts and its retry sees the other.
 * NOTE: products do not claim their category, so a product created at the same instant as its
 * category is deleted can still reference a deleted category.
 */
export async function deleteCategory(organizationId: string, categoryId: string, actorUserId: string) {
  await findCategoryOrThrow(organizationId, categoryId);

  await inTreeTransaction(async (session) => {
    const category = await Category.findOne({ _id: categoryId, organizationId }).session(session);
    if (!category) {
      throw categoryNotFound();
    }

    const productCount = await Product.countDocuments({ organizationId, categoryId: category._id }).session(session);
    if (productCount > 0) {
      throw ApiError.coded(
        409,
        "CATEGORY_IN_USE",
        `This category still has ${productCount} product${productCount === 1 ? "" : "s"}. Move them to another category first.`,
        [{ code: "CATEGORY_IN_USE", meta: { productCount } }]
      );
    }

    const childCount = await Category.countDocuments({ organizationId, parentId: category._id }).session(session);
    if (childCount > 0) {
      throw ApiError.coded(
        409,
        "CATEGORY_HAS_CHILDREN",
        `This category still has ${childCount} subcategor${childCount === 1 ? "y" : "ies"}. Move or delete them first.`,
        [{ code: "CATEGORY_HAS_CHILDREN", meta: { childCount } }]
      );
    }

    category.isDelete = true;
    await category.save({ session });
  });

  logger.info(`Category deleted: ${categoryId} org=${organizationId} by user=${actorUserId}`);
}
