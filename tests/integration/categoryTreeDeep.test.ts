/**
 * Purpose: Exercises the subtree rewrite of a category move, which cannot run at the production
 * depth (MAX_CATEGORY_DEPTH = 2: a category with children can never move). The depth constant is
 * raised to 3 for this file only, so a subcategory that has its own children can move.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

vi.mock("../../src/models/category.model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/models/category.model")>()),
  MAX_CATEGORY_DEPTH: 3,
}));

import { Organization } from "../../src/models/organization.model";
import { Category } from "../../src/models/category.model";
import * as categories from "../../src/services/category.service";
import * as products from "../../src/services/product.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { createCategorySchema, updateCategorySchema } from "../../src/validators/category.validator";
import { createProductSchema } from "../../src/validators/product.validator";

const actor = new mongoose.Types.ObjectId().toString();
let orgId: string;

const mk = (name: string, parentId?: unknown) =>
  categories.createCategory(
    orgId,
    createCategorySchema.parse({ name, ...(parentId ? { parentId: String(parentId) } : {}) }),
    actor
  );
const move = (id: unknown, body: Record<string, unknown>) =>
  categories.updateCategory(orgId, String(id), updateCategorySchema.parse(body), actor);
const ancestorsOf = async (id: unknown) => ((await Category.findById(id).lean())!.ancestors ?? []).map(String);

beforeAll(async () => {
  await Category.init();
});

beforeEach(async () => {
  const org = await Organization.create({
    name: "deep",
    slug: "deep-org",
    contactEmail: "o@deep.test",
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency: "BHD", timezone: "Asia/Bahrain" },
  });
  await seedDefaultTaxRates(org._id, "BHD");
  orgId = String(org._id);
});

describe("moving a category that has subcategories (depth limit raised to 3)", () => {
  it("rewrites the ancestors of every descendant, and refuses a move that would overflow", async () => {
    const x = await mk("X");
    const w = await mk("W");
    const y = await mk("Y", x._id);
    const z = await mk("Z", y._id);
    expect(await ancestorsOf(z._id)).toEqual([String(x._id), String(y._id)]);

    const toRoot = await move(y._id, { parentId: null });
    expect(toRoot).toMatchObject({ parentId: null, depth: 0 });
    expect(await ancestorsOf(z._id)).toEqual([String(y._id)]);
    expect((await categories.getCategory(orgId, String(z._id))).depth).toBe(1);

    await move(y._id, { parentId: String(w._id) });
    expect(await ancestorsOf(y._id)).toEqual([String(w._id)]);
    expect(await ancestorsOf(z._id)).toEqual([String(w._id), String(y._id)]);

    // W now has a 3-level subtree; nesting W under X would make 4 levels.
    const error = await move(w._id, { parentId: String(x._id) }).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 400, code: "CATEGORY_DEPTH_EXCEEDED" });
    expect(await ancestorsOf(z._id)).toEqual([String(w._id), String(y._id)]); // nothing partial
  });

  it("keeps counts and product paths consistent after a subtree move", async () => {
    const x = await mk("X");
    const w = await mk("W");
    const y = await mk("Y", x._id);
    const z = await mk("Z", y._id);
    const p = await products.createProduct(
      orgId,
      createProductSchema.parse({ name: "Item", type: "service", sales: { sellingPrice: "1.000" }, categoryId: String(z._id) }),
      actor
    );
    await move(y._id, { parentId: String(w._id) });

    expect(await categories.getCategory(orgId, String(x._id))).toMatchObject({ totalProductCount: 0 });
    expect(await categories.getCategory(orgId, String(w._id))).toMatchObject({ totalProductCount: 1, productCount: 0 });
    expect(await categories.getCategory(orgId, String(y._id))).toMatchObject({ totalProductCount: 1 });
    expect((await products.getProduct(orgId, String(p._id))).category!.path).toBe("W › Y › Z");
    expect((await products.listProducts(orgId, { categoryId: String(w._id) })).products).toHaveLength(1);
    expect((await products.listProducts(orgId, { categoryId: String(x._id) })).products).toHaveLength(0);
  });

  it("refuses to move a category under its grandchild", async () => {
    const x = await mk("X");
    const y = await mk("Y", x._id);
    const z = await mk("Z", y._id);
    const error = await move(x._id, { parentId: String(z._id) }).catch((e) => e);
    expect(error.code).toBe("CATEGORY_CYCLE");
  });
});
