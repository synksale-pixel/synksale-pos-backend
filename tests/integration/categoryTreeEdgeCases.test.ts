/**
 * Purpose: Edge cases for nested categories beyond categoryTree.test.ts: concurrent creates and
 * moves, tenant isolation of the tree helpers, interactions (deletes, renames, moves, ordering),
 * the index migration against existing rows, and HTTP input handling / RBAC for parentId.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Category } from "../../src/models/category.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import * as categories from "../../src/services/category.service";
import * as products from "../../src/services/product.service";
import { createCategorySchema, updateCategorySchema } from "../../src/validators/category.validator";
import { createProductSchema } from "../../src/validators/product.validator";

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

const mk = (name: string, parentId?: unknown, org = orgId) =>
  categories.createCategory(
    org,
    createCategorySchema.parse({ name, ...(parentId ? { parentId: String(parentId) } : {}) }),
    actor
  );
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
  orgId = String((await createOrg("edge-org"))._id);
});

describe("concurrency", () => {
  it("lets exactly one of many concurrent same-name creates win, the rest 409 (never 500)", async () => {
    const mobiles = await mk("Mobiles");
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => mk("Accessories", mobiles._id)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(failed).toHaveLength(7);
    failed.forEach((r) => expect(r.reason).toMatchObject({ statusCode: 409, code: "CATEGORY_NAME_TAKEN" }));
    expect(await Category.countDocuments({ organizationId: orgId, name: "Accessories" })).toBe(1);
  });

  it("lets concurrent creates of one name under different parents all succeed", async () => {
    const parents = await Promise.all(["A", "B", "C", "D"].map((n) => mk(n)));
    const results = await Promise.allSettled(parents.map((p) => mk("Accessories", p._id)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("resolves a concurrent move and a same-name create into one winner and one 409", async () => {
    const mobiles = await mk("Mobiles");
    const loose = await mk("Accessories");
    const results = await Promise.allSettled([move(loose._id, { parentId: String(mobiles._id) }), mk("Accessories", mobiles._id)]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({ statusCode: 409, code: "CATEGORY_NAME_TAKEN" });
    expect(await Category.countDocuments({ organizationId: orgId, parentId: mobiles._id, name: "Accessories" })).toBe(1);
  });
});

describe("tenant isolation of the tree helpers", () => {
  it("never returns or expands another organization's categories", async () => {
    const other = await createOrg("rival-org");
    const theirs = await mk("Theirs", undefined, String(other._id));
    const theirChild = await mk("Their child", theirs._id, String(other._id));
    const mine = await mk("Mine");

    const ids = await categories.categoryWithDescendants(orgId, new mongoose.Types.ObjectId(String(theirs._id)));
    expect(ids.map(String)).toEqual([String(theirs._id)]); // only the id itself; their child is not expanded

    const refs = await categories.categoryRefs(
      orgId,
      [theirs._id, theirChild._id, mine._id].map((id) => new mongoose.Types.ObjectId(String(id)))
    );
    expect([...refs.keys()]).toEqual([String(mine._id)]);

    await product("Mine product", mine._id);
    expect((await products.listProducts(orgId, { categoryId: String(theirs._id) })).products).toEqual([]);
    expect((await failure(categories.getCategory(orgId, String(theirChild._id)))).code).toBe("CATEGORY_NOT_FOUND");
    expect((await failure(move(mine._id, { parentId: String(theirs._id) }))).errors[0].field).toBe("parentId");
    expect((await failure(move(theirs._id, { name: "Hijack" }))).statusCode).toBe(404);
  });
});

describe("tree interactions", () => {
  it("does not count a soft-deleted subcategory as a child, and frees its name", async () => {
    const mobiles = await mk("Mobiles");
    const accessories = await mk("Accessories", mobiles._id);
    await categories.deleteCategory(orgId, String(accessories._id), actor);

    const again = await mk("Accessories", mobiles._id);
    expect(String(again._id)).not.toBe(String(accessories._id));
    await categories.deleteCategory(orgId, String(again._id), actor);
    await expect(categories.deleteCategory(orgId, String(mobiles._id), actor)).resolves.toBeUndefined();
  });

  it("counts only live children in CATEGORY_HAS_CHILDREN meta", async () => {
    const mobiles = await mk("Mobiles");
    await mk("A", mobiles._id);
    await mk("B", mobiles._id);
    const gone = await mk("C", mobiles._id);
    await categories.deleteCategory(orgId, String(gone._id), actor);
    const error = await failure(categories.deleteCategory(orgId, String(mobiles._id), actor));
    expect(error.errors[0].meta).toEqual({ childCount: 2 });
  });

  it("allows a case-only rename of a subcategory", async () => {
    const mobiles = await mk("Mobiles");
    const accessories = await mk("accessories", mobiles._id);
    expect((await move(accessories._id, { name: "Accessories" })).name).toBe("Accessories");
  });

  it("refuses a sibling name clash, with or without the current parent re-sent", async () => {
    const mobiles = await mk("Mobiles");
    await mk("Cases", mobiles._id);
    const accessories = await mk("Accessories", mobiles._id);

    const plain = await failure(move(accessories._id, { name: "CASES" }));
    expect(plain.code).toBe("CATEGORY_NAME_TAKEN");
    const resent = await failure(move(accessories._id, { parentId: String(mobiles._id), name: "cases" }));
    expect(resent.code).toBe("CATEGORY_NAME_TAKEN");
    expect(resent.message).toContain("under 'Mobiles'");
    expect((await categories.getCategory(orgId, String(accessories._id))).name).toBe("Accessories");
  });

  it("keeps counts and the product's category through a move, and reflects a parent rename in list rows", async () => {
    const mobiles = await mk("Mobiles");
    const laptops = await mk("Laptops");
    const accessories = await mk("Accessories", mobiles._id);
    const p = await product("Charger", accessories._id);

    await move(accessories._id, { parentId: String(laptops._id) });
    expect(String((await products.getProduct(orgId, String(p._id))).category!.id)).toBe(String(accessories._id));
    expect(await categories.getCategory(orgId, String(accessories._id))).toMatchObject({ productCount: 1, totalProductCount: 1 });
    expect(await categories.getCategory(orgId, String(laptops._id))).toMatchObject({ productCount: 0, totalProductCount: 1 });
    expect(await categories.getCategory(orgId, String(mobiles._id))).toMatchObject({ productCount: 0, totalProductCount: 0 });

    await move(laptops._id, { name: "Computers" });
    const row = (await products.listProducts(orgId, {})).products[0];
    expect(row.category).toMatchObject({ path: "Computers › Accessories" });
  });

  it("lists the flat tree by sortOrder then name, regardless of level", async () => {
    const zed = await mk("Zed");
    await move(zed._id, { sortOrder: 5 });
    const a = await mk("A");
    await move(a._id, { sortOrder: 5 });
    const sub = await mk("Sub", zed._id);
    await move(sub._id, { sortOrder: 1 });
    await mk("Early", zed._id); // sortOrder 0

    const names = (await categories.listCategories(orgId)).categories.map((c) => c.name);
    expect(names).toEqual(["Early", "Sub", "A", "Zed"]);
  });
});

describe("index migration with existing data", () => {
  it("syncIndexes swaps the old index for the new ones without failing on legacy rows", async () => {
    await Category.collection.createIndex(
      { organizationId: 1, nameKey: 1 },
      { unique: true, partialFilterExpression: { isDelete: false } }
    );
    const base = { organizationId: new mongoose.Types.ObjectId(orgId), sortOrder: 0, isDelete: false };
    await Category.collection.insertMany([
      { ...base, name: "Legacy A", nameKey: "legacy a" },
      { ...base, name: "Legacy B", nameKey: "legacy b" },
    ]);

    await Category.syncIndexes();
    const names = (await Category.collection.indexes()).map((i) => i.name);
    expect(names).not.toContain("organizationId_1_nameKey_1");
    expect(names).toContain("organizationId_1_parentId_1_nameKey_1");
    expect(names).toContain("organizationId_1_ancestors_1");

    // Legacy rows still behave as roots, and the same name may now sit under them.
    const legacy = await Category.findOne({ organizationId: orgId, nameKey: "legacy a" });
    await expect(mk("Legacy A", legacy!._id)).resolves.toMatchObject({ depth: 1 });
    expect((await failure(mk("legacy a"))).code).toBe("CATEGORY_NAME_TAKEN");
  });
});

describe("over HTTP: input handling and RBAC", () => {
  let admin: Record<string, string>;
  let cashier: Record<string, string>;
  let rival: Record<string, string>;

  const bearer = (userId: unknown, organizationId: unknown) => ({
    Authorization: `Bearer ${generateAccessToken({ userId: String(userId), organizationId: String(organizationId), isSuperAdmin: false })}`,
  });

  async function setupOrg(slug: string, withCashier: boolean) {
    const org = await createOrg(slug);
    await seedDefaultRolesForOrganization(org._id);
    const roleOf = async (s: string) => (await Role.findOne({ organizationId: org._id, slug: s }))!;
    const make = (email: string, extra: Record<string, unknown>) =>
      User.create({ organizationId: org._id, email, passwordHash: "SecurePassword123", firstName: "T", lastName: "U", isActive: true, ...extra });

    const adminUser = await make(`admin@${slug}.test`, { orgRoleId: (await roleOf("org_admin"))._id });
    let cashierHeaders: Record<string, string> | undefined;
    if (withCashier) {
      const store = await Store.create({
        organizationId: org._id,
        name: "Main",
        code: `${slug.toUpperCase()}-1`,
        address: { line1: "Road 1", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
        countryCode: "BH",
        timezone: "Asia/Bahrain",
      });
      const cashierUser = await make(`cashier@${slug}.test`, {
        storeAccess: [{ storeId: store._id, roleId: (await roleOf("cashier"))._id }],
      });
      cashierHeaders = bearer(cashierUser._id, org._id);
    }
    return { org, admin: bearer(adminUser._id, org._id), cashier: cashierHeaders! };
  }

  beforeEach(async () => {
    const main = await setupOrg("rbac-org", true);
    admin = main.admin;
    cashier = main.cashier;
    rival = (await setupOrg("rival-http", false)).admin;
  });

  const post = (as: Record<string, string>, body: unknown) => request.post("/api/v1/categories").set(as).send(body as object);

  it("forbids a cashier from creating, moving or deleting with parentId", async () => {
    const root = (await post(admin, { name: "Mobiles" })).body.data.category;
    const loose = (await post(admin, { name: "Loose" })).body.data.category;

    expect((await post(cashier, { name: "Sub", parentId: root._id })).status).toBe(403);
    expect((await request.patch(`/api/v1/categories/${loose._id}`).set(cashier).send({ parentId: root._id })).status).toBe(403);
    expect((await request.delete(`/api/v1/categories/${loose._id}`).set(cashier)).status).toBe(403);
    expect(await Category.countDocuments({ parentId: root._id })).toBe(0);
  });

  it("rejects malformed parentId and operator injection with 400 VALIDATION_FAILED", async () => {
    const root = (await post(admin, { name: "Mobiles" })).body.data.category;
    for (const parentId of ["not-an-id", 123, "", { $ne: null }, { $gt: "" }, [root._id], `${root._id}0`]) {
      const created = await post(admin, { name: "Sub", parentId });
      expect(created.status, JSON.stringify(parentId)).toBe(400);
      expect(created.body.code).toBe("VALIDATION_FAILED");
      const patched = await request.patch(`/api/v1/categories/${root._id}`).set(admin).send({ parentId });
      expect(patched.status, JSON.stringify(parentId)).toBe(400);
      expect(patched.body.code).toBe("VALIDATION_FAILED");
    }
    expect(await Category.countDocuments({ name: "Sub" })).toBe(0);
  });

  it("rejects a foreign parentId and a cycle over HTTP, without leaking internals", async () => {
    const root = (await post(admin, { name: "Mobiles" })).body.data.category;
    const theirs = (await post(rival, { name: "Theirs" })).body.data.category;

    const foreign = await post(admin, { name: "Sub", parentId: theirs._id });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe("CATEGORY_NOT_FOUND");
    const cycle = await request.patch(`/api/v1/categories/${root._id}`).set(admin).send({ parentId: root._id });
    expect(cycle.status).toBe(400);
    expect(cycle.body.code).toBe("CATEGORY_CYCLE");
    expect(JSON.stringify(cycle.body)).not.toMatch(/stack|ancestors/);
    expect((await request.get(`/api/v1/categories/${theirs._id}`).set(admin)).status).toBe(404);
  });

  it("treats any includeSubcategories value other than exactly 'false' as true", async () => {
    const parent = (await post(admin, { name: "Mobiles" })).body.data.category;
    const child = (await post(admin, { name: "Accessories", parentId: parent._id })).body.data.category;
    const made = await request
      .post("/api/v1/products")
      .set(admin)
      .send({ name: "Charger", type: "service", categoryId: child._id, sales: { sellingPrice: "1.000" } });
    expect(made.status).toBe(201);

    const count = async (q: string) => {
      const res = await request.get(`/api/v1/products?categoryId=${parent._id}&${q}`).set(admin);
      return res.status === 200 ? res.body.data.products.length : `HTTP ${res.status}`;
    };
    expect(await count("includeSubcategories=false")).toBe(0);
    for (const q of [
      "includeSubcategories=FALSE",
      "includeSubcategories=0",
      "includeSubcategories=true",
      "includeSubcategories=",
      "includeSubcategories=false&includeSubcategories=false",
      "includeSubcategories[]=false",
    ]) {
      expect(await count(q), q).toBe(1);
    }
  });

  it("returns nothing for a product list filtered on another organization's category", async () => {
    const theirs = (await post(rival, { name: "Theirs" })).body.data.category;
    const sub = (await post(rival, { name: "Sub", parentId: theirs._id })).body.data.category;
    const made = await request
      .post("/api/v1/products")
      .set(rival)
      .send({ name: "Secret", type: "service", categoryId: sub._id, sales: { sellingPrice: "1.000" } });
    expect(made.status).toBe(201);

    for (const id of [theirs._id, sub._id]) {
      const res = await request.get(`/api/v1/products?categoryId=${id}`).set(admin);
      expect(res.status).toBe(200);
      expect(res.body.data.products).toEqual([]);
    }
  });
});
