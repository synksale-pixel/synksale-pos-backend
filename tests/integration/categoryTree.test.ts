/**
 * Purpose: Tests for nested categories (Category → Subcategory): depth limit, cycles, sibling-scoped
 * names, moves, delete guards, product counts, the product list's subcategory filter, the category
 * path on product views, tenant isolation of parentId, legacy flat categories, and the index
 * migration away from the old per-organization name index.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Category } from "../../src/models/category.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import * as categories from "../../src/services/category.service";
import * as products from "../../src/services/product.service";
import { createCategorySchema, updateCategorySchema } from "../../src/validators/category.validator";
import { createProductSchema } from "../../src/validators/product.validator";
import { CategorySchema, ProductSchema, ProductSummarySchema, ProductVariantSchema } from "../../src/validators/responses";
import { z } from "zod";

const actor = new mongoose.Types.ObjectId().toString();
let orgId: string;

async function createOrg(slug: string) {
  const org = await Organization.create({
    name: slug,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency: "BHD", timezone: "Asia/Bahrain" },
  });
  await seedDefaultTaxRates(org._id, "BHD");
  return org;
}

const mk = (name: string, parentId?: string | null, org = orgId) =>
  categories.createCategory(org, createCategorySchema.parse({ name, ...(parentId !== undefined ? { parentId } : {}) }), actor);
const move = (id: unknown, body: Record<string, unknown>) =>
  categories.updateCategory(orgId, String(id), updateCategorySchema.parse(body), actor);
const product = (name: string, categoryId?: unknown) =>
  products.createProduct(
    orgId,
    createProductSchema.parse({
      name,
      type: "service",
      sales: { sellingPrice: "1.000" },
      ...(categoryId ? { categoryId: String(categoryId) } : {}),
    }),
    actor
  );

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode: number; code?: string; message: string; errors: Array<Record<string, unknown>> };
  }
  throw new Error("Expected the call to fail.");
}

beforeAll(async () => {
  await Category.init();
});

beforeEach(async () => {
  orgId = String((await createOrg("tree-org"))._id);
});

describe("creating subcategories", () => {
  it("nests one level and reports parentId and depth", async () => {
    const mobiles = await mk("Mobiles");
    const accessories = await mk("Accessories", String(mobiles._id));

    expect(mobiles).toMatchObject({ parentId: null, depth: 0 });
    expect(String(accessories.parentId)).toBe(String(mobiles._id));
    expect(accessories.depth).toBe(1);
    expect(accessories).not.toHaveProperty("ancestors");
  });

  it("refuses a third level with CATEGORY_DEPTH_EXCEEDED", async () => {
    const mobiles = await mk("Mobiles");
    const accessories = await mk("Accessories", String(mobiles._id));
    const error = await failure(mk("Cases", String(accessories._id)));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("CATEGORY_DEPTH_EXCEEDED");
    expect(error.errors[0]).toMatchObject({ field: "parentId", meta: { maxDepth: 2 } });
  });

  it("refuses an unknown, deleted or foreign parent with 400 CATEGORY_NOT_FOUND", async () => {
    expect((await failure(mk("X", new mongoose.Types.ObjectId().toString()))).code).toBe("CATEGORY_NOT_FOUND");

    const gone = await mk("Gone");
    await categories.deleteCategory(orgId, String(gone._id), actor);
    const deleted = await failure(mk("X", String(gone._id)));
    expect(deleted.statusCode).toBe(400);
    expect(deleted.errors[0].field).toBe("parentId");

    const other = await createOrg("other-org");
    const theirs = await mk("Theirs", null, String(other._id));
    expect((await failure(mk("X", String(theirs._id)))).code).toBe("CATEGORY_NOT_FOUND");
  });
});

describe("names are unique among siblings", () => {
  it("allows the same name under different parents and at another level", async () => {
    const mobiles = await mk("Mobiles");
    const laptops = await mk("Laptops");
    await mk("Accessories", String(mobiles._id));
    await expect(mk("accessories", String(laptops._id))).resolves.toBeTruthy();
    await expect(mk("Accessories")).resolves.toBeTruthy(); // top level is a different sibling set
  });

  it("refuses a duplicate among siblings, naming the parent", async () => {
    const mobiles = await mk("Mobiles");
    await mk("Accessories", String(mobiles._id));
    const error = await failure(mk("ACCESSORIES", String(mobiles._id)));
    expect(error.code).toBe("CATEGORY_NAME_TAKEN");
    expect(error.message).toBe("A category named 'ACCESSORIES' already exists under 'Mobiles'.");
    expect((await failure(mk("mobiles"))).message).toBe("A category named 'mobiles' already exists at the top level.");
  });

  it("refuses a move that would clash with a new sibling", async () => {
    const mobiles = await mk("Mobiles");
    await mk("Accessories", String(mobiles._id));
    const loose = await mk("Accessories");
    expect((await failure(move(loose._id, { parentId: String(mobiles._id) }))).code).toBe("CATEGORY_NAME_TAKEN");
  });
});

describe("moving categories", () => {
  it("moves a subcategory to another parent and to the top level", async () => {
    const mobiles = await mk("Mobiles");
    const laptops = await mk("Laptops");
    const accessories = await mk("Accessories", String(mobiles._id));
    const p = await product("Charger", accessories._id);

    const moved = await move(accessories._id, { parentId: String(laptops._id) });
    expect(String(moved.parentId)).toBe(String(laptops._id));
    expect((await categories.getCategory(orgId, String(laptops._id))).totalProductCount).toBe(1);
    expect((await categories.getCategory(orgId, String(mobiles._id))).totalProductCount).toBe(0);

    const root = await move(accessories._id, { parentId: null });
    expect(root).toMatchObject({ parentId: null, depth: 0 });
    // The product kept its category through both moves.
    expect((await products.getProduct(orgId, String(p._id))).category).toMatchObject({ name: "Accessories", path: "Accessories" });
  });

  it("refuses a category as its own parent or under its own subcategory", async () => {
    const mobiles = await mk("Mobiles");
    const accessories = await mk("Accessories", String(mobiles._id));
    expect((await failure(move(mobiles._id, { parentId: String(mobiles._id) }))).code).toBe("CATEGORY_CYCLE");
    expect((await failure(move(mobiles._id, { parentId: String(accessories._id) }))).code).toBe("CATEGORY_CYCLE");
  });

  it("refuses to nest a category that has subcategories of its own", async () => {
    const mobiles = await mk("Mobiles");
    const laptops = await mk("Laptops");
    await mk("Accessories", String(mobiles._id));
    const error = await failure(move(mobiles._id, { parentId: String(laptops._id) }));
    expect(error.code).toBe("CATEGORY_DEPTH_EXCEEDED");
    expect(error.message).toContain("has subcategories of its own");
  });

  it("treats re-sending the current parent as no move", async () => {
    const mobiles = await mk("Mobiles");
    const accessories = await mk("Accessories", String(mobiles._id));
    const same = await move(accessories._id, { parentId: String(mobiles._id), sortOrder: 3 });
    expect(same.sortOrder).toBe(3);
  });
});

describe("deleting", () => {
  it("refuses a category with subcategories, then allows it once they are gone", async () => {
    const mobiles = await mk("Mobiles");
    const accessories = await mk("Accessories", String(mobiles._id));

    const error = await failure(categories.deleteCategory(orgId, String(mobiles._id), actor));
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("CATEGORY_HAS_CHILDREN");
    expect(error.errors[0].meta).toEqual({ childCount: 1 });

    await categories.deleteCategory(orgId, String(accessories._id), actor);
    await expect(categories.deleteCategory(orgId, String(mobiles._id), actor)).resolves.toBeUndefined();
  });

  it("reports direct products (CATEGORY_IN_USE) before subcategories", async () => {
    const mobiles = await mk("Mobiles");
    await mk("Accessories", String(mobiles._id));
    await product("Phone", mobiles._id);
    expect((await failure(categories.deleteCategory(orgId, String(mobiles._id), actor))).code).toBe("CATEGORY_IN_USE");
  });
});

describe("product counts and the product list", () => {
  it("counts direct and subtree products", async () => {
    const mobiles = await mk("Mobiles");
    const accessories = await mk("Accessories", String(mobiles._id));
    const cases = await mk("Cases", String(mobiles._id));
    await product("Phone", mobiles._id);
    await product("Charger", accessories._id);
    await product("Cable", accessories._id);
    await product("Case", cases._id);
    const deleted = await product("Old case", cases._id);
    await products.deleteProduct(orgId, String(deleted._id), actor);

    const { categories: list } = await categories.listCategories(orgId);
    const byName = (name: string) => list.find((c) => c.name === name)!;
    expect(byName("Mobiles")).toMatchObject({ productCount: 1, totalProductCount: 4 });
    expect(byName("Accessories")).toMatchObject({ productCount: 2, totalProductCount: 2 });
    expect(byName("Cases")).toMatchObject({ productCount: 1, totalProductCount: 1 });
    expect(await categories.getCategory(orgId, String(mobiles._id))).toMatchObject({ productCount: 1, totalProductCount: 4 });
  });

  it("filters by a category including its subcategories unless told otherwise", async () => {
    const mobiles = await mk("Mobiles");
    const accessories = await mk("Accessories", String(mobiles._id));
    await product("Phone", mobiles._id);
    await product("Charger", accessories._id);
    await product("Uncategorised");

    const names = async (input: Parameters<typeof products.listProducts>[1]) =>
      (await products.listProducts(orgId, input)).products.map((p) => p.name).sort();
    expect(await names({ categoryId: String(mobiles._id) })).toEqual(["Charger", "Phone"]);
    expect(await names({ categoryId: String(mobiles._id), includeSubcategories: false })).toEqual(["Phone"]);
    expect(await names({ categoryId: String(accessories._id) })).toEqual(["Charger"]);
    expect(await names({ categoryId: "none" })).toEqual(["Uncategorised"]);
  });

  it("shows the category path on products and list rows", async () => {
    const mobiles = await mk("Mobiles");
    const accessories = await mk("Accessories", String(mobiles._id));
    const p = await product("Charger", accessories._id);
    expect(p.category).toEqual({ id: accessories._id, name: "Accessories", path: "Mobiles › Accessories" });

    const row = (await products.listProducts(orgId, {})).products[0];
    expect(row.category).toMatchObject({ name: "Accessories", path: "Mobiles › Accessories" });

    await move(mobiles._id, { name: "Phones" });
    expect((await products.getProduct(orgId, String(p._id))).category!.path).toBe("Phones › Accessories");
  });
});

describe("legacy flat categories and index migration", () => {
  it("treats a category stored without parentId/ancestors as a top-level category", async () => {
    const { insertedId } = await Category.collection.insertOne({
      organizationId: new mongoose.Types.ObjectId(orgId),
      name: "Legacy",
      nameKey: "legacy",
      sortOrder: 0,
      isDelete: false,
    });
    const legacy = await categories.getCategory(orgId, String(insertedId));
    expect(legacy).toMatchObject({ parentId: null, depth: 0 });

    await expect(mk("Child", String(insertedId))).resolves.toMatchObject({ depth: 1 });
    expect((await failure(mk("legacy"))).code).toBe("CATEGORY_NAME_TAKEN");
    const filtered = await products.listProducts(orgId, { categoryId: String(insertedId) });
    expect(filtered.products).toEqual([]);
  });

  it("plans to drop the old per-organization name index", async () => {
    await Category.collection.createIndex(
      { organizationId: 1, nameKey: 1 },
      { unique: true, partialFilterExpression: { isDelete: false } }
    );
    try {
      const { toDrop } = await Category.diffIndexes();
      expect(toDrop).toContain("organizationId_1_nameKey_1");
    } finally {
      await Category.collection.dropIndex("organizationId_1_nameKey_1");
    }
  });
});

describe("over HTTP", () => {
  const strictCategory = CategorySchema.strict();
  const strictProduct = ProductSchema.extend({ variants: z.array(ProductVariantSchema.strict()) }).strict();

  it("returns the documented shapes and filters by subcategory", async () => {
    const org = await createOrg("http-org");
    await seedDefaultRolesForOrganization(org._id);
    const role = (await Role.findOne({ organizationId: org._id, slug: "org_admin" }))!;
    const user = await User.create({
      organizationId: org._id,
      email: "admin@http.test",
      passwordHash: "SecurePassword123",
      firstName: "T",
      lastName: "U",
      isActive: true,
      orgRoleId: role._id,
    });
    const auth = {
      Authorization: `Bearer ${generateAccessToken({ userId: String(user._id), organizationId: String(org._id), isSuperAdmin: false })}`,
    };

    const parent = (await request.post("/api/v1/categories").set(auth).send({ name: "Mobiles" })).body.data.category;
    const child = await request.post("/api/v1/categories").set(auth).send({ name: "Accessories", parentId: parent._id });
    expect(child.status).toBe(201);
    strictCategory.parse(child.body.data.category);

    const tooDeep = await request.post("/api/v1/categories").set(auth).send({ name: "Cases", parentId: child.body.data.category._id });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.body.code).toBe("CATEGORY_DEPTH_EXCEEDED");

    const created = await request
      .post("/api/v1/products")
      .set(auth)
      .send({ name: "Charger", type: "service", categoryId: child.body.data.category._id, sales: { sellingPrice: "1.000" } });
    expect(created.status).toBe(201);
    strictProduct.parse(created.body.data.product);

    const list = await request.get("/api/v1/products").query({ categoryId: parent._id }).set(auth);
    expect(list.body.data.products).toHaveLength(1);
    list.body.data.products.forEach((row: unknown) => ProductSummarySchema.strict().parse(row));
    const direct = await request.get("/api/v1/products").query({ categoryId: parent._id, includeSubcategories: "false" }).set(auth);
    expect(direct.body.data.products).toHaveLength(0);

    const blocked = await request.delete(`/api/v1/categories/${parent._id}`).set(auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("CATEGORY_HAS_CHILDREN");

    const listed = await request.get("/api/v1/categories").set(auth);
    listed.body.data.categories.forEach((c: unknown) => strictCategory.parse(c));
    expect(listed.body.data.categories.find((c: { name: string }) => c.name === "Mobiles")).toMatchObject({
      productCount: 0,
      totalProductCount: 1,
    });
  });
});

describe("concurrent tree changes", () => {
  /**
   * Pauses the first Category.updateOne (a transaction's first write: claimParent) and runs
   * `meanwhile` to completion before letting it continue. The paused transaction has already
   * read the tree, so it must notice the other change through a write conflict and retry.
   */
  function interleave(meanwhile: () => Promise<unknown>) {
    const original = Category.updateOne.bind(Category);
    let other: Promise<unknown> | undefined;
    const spy = vi.spyOn(Category, "updateOne").mockImplementationOnce(((...args: Parameters<typeof Category.updateOne>) => {
      other = meanwhile();
      return other.then(() => original(...args));
    }) as unknown as typeof Category.updateOne);
    return { spy, done: () => other };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a child added while its parent is moved under another category is refused, not left 3 levels deep", async () => {
    const x = await mk("X");
    const y = await mk("Y");
    const { spy, done } = interleave(() => move(x._id, { parentId: String(y._id) }));

    const error = await failure(mk("Child", String(x._id)));
    await done();
    expect(spy).toHaveBeenCalled();
    expect(error.code).toBe("CATEGORY_DEPTH_EXCEEDED");

    const all = await Category.find({ organizationId: orgId });
    expect(all.every((c) => c.ancestors.length < 2)).toBe(true);
    expect(String((await Category.findById(x._id))!.parentId)).toBe(String(y._id));
  });

  it("a parent moved while a child is added under it is refused once it sees the child", async () => {
    const x = await mk("X");
    const y = await mk("Y");
    const { spy, done } = interleave(() => mk("Child", String(x._id)));

    const error = await failure(move(x._id, { parentId: String(y._id) }));
    await done();
    expect(spy).toHaveBeenCalled();
    expect(error.code).toBe("CATEGORY_DEPTH_EXCEEDED");

    const child = await Category.findOne({ organizationId: orgId, name: "Child" });
    expect(child!.ancestors.map(String)).toEqual([String(x._id)]);
    expect((await Category.findById(x._id))!.parentId).toBeNull();
  });

  it("a child added while its parent is deleted is refused, leaving no orphan", async () => {
    const x = await mk("X");
    const { spy, done } = interleave(() => categories.deleteCategory(orgId, String(x._id), actor));

    const error = await failure(mk("Child", String(x._id)));
    await done();
    expect(spy).toHaveBeenCalled();
    expect(error.code).toBe("CATEGORY_NOT_FOUND");
    expect(await Category.countDocuments({ organizationId: orgId, parentId: x._id })).toBe(0);
  });

  it("does not expose treeVersion", async () => {
    const x = await mk("X");
    await mk("Child", String(x._id));
    expect(await categories.getCategory(orgId, String(x._id))).not.toHaveProperty("treeVersion");
  });
});
