/**
 * Purpose: Edge-case and hostile-input tests for the Phase 1 catalog that the service and route
 * suites do not cover: concurrent writes (409, never 500), cross-kind barcode conflicts, query
 * parameter injection, malformed ids, authorization corners (no role, store-scoped write roles,
 * platform tokens), mass assignment, soft-deleted parents, audit contents, and guard ordering.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Product } from "../../src/models/product.model";
import { ProductVariant } from "../../src/models/productVariant.model";
import { AuditLog } from "../../src/models/auditLog.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { generateSuperAdminAccessToken } from "../../src/services/platformAuth.service";

const CATEGORIES = "/api/v1/categories";
const PRODUCTS = "/api/v1/products";
const ORG = "/api/v1/organization";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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
  await seedDefaultRolesForOrganization(org._id);
  await seedDefaultTaxRates(org._id, "BHD");
  const roles = await Role.find({ organizationId: org._id });
  const role = (s: string) => roles.find((r) => r.slug === s)!;
  const store = await Store.create({
    organizationId: org._id,
    name: "Main",
    code: `${slug.toUpperCase()}-1`,
    address: { line1: "Road 1", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
    countryCode: "BH",
    timezone: "Asia/Bahrain",
  });
  return { org, role, store };
}

async function tokenFor(
  orgId: mongoose.Types.ObjectId,
  email: string,
  opts: { orgRoleId?: unknown; storeAccess?: { storeId: unknown; roleId: unknown }[] } = {}
) {
  const user = await User.create({
    organizationId: orgId,
    email,
    passwordHash: "SecurePassword123",
    firstName: "T",
    lastName: "U",
    isActive: true,
    orgRoleId: opts.orgRoleId ?? null,
    storeAccess: opts.storeAccess ?? [],
  });
  return generateAccessToken({ userId: user._id.toString(), organizationId: String(orgId), isSuperAdmin: false });
}

const single = (overrides: Record<string, unknown> = {}) => ({
  name: "Coffee",
  type: "goods",
  taxPreference: "exempt",
  sku: "COF-1",
  barcodes: { ean: "6291041500213" },
  sales: { sellingPrice: "2.750" },
  purchase: { costPrice: "1.600" },
  ...overrides,
});

const shirt = (overrides: Record<string, unknown> = {}) => ({
  name: "Tee",
  type: "goods",
  itemType: "variant",
  taxPreference: "exempt",
  attributes: [{ name: "Size", options: ["S", "M", "L"] }],
  variants: [
    { attributeValues: { Size: "S" }, sku: "TEE-S", sellingPrice: "4.000" },
    { attributeValues: { Size: "M" }, sku: "TEE-M", sellingPrice: "4.500" },
  ],
  ...overrides,
});

let ctx: Awaited<ReturnType<typeof createOrg>>;
let admin: string;

const post = (body: unknown, token = admin) => request.post(PRODUCTS).set(auth(token)).send(body as object);

beforeEach(async () => {
  ctx = await createOrg("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
});

describe("concurrent writes", () => {
  it("creating the same SKU concurrently yields exactly one 201 and the rest 409 SKU_TAKEN, never 500", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post(single({ name: `Coffee ${i}`, barcodes: undefined })))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(results.map((r) => r.body.code))).toEqual([201, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe("SKU_TAKEN");
    expect(await ProductVariant.countDocuments({ organizationId: ctx.org._id })).toBe(1);
    // The losers rolled back their product row too.
    expect(await Product.countDocuments({ organizationId: ctx.org._id })).toBe(1);
  });

  it("creating the same barcode concurrently (EAN in one request, ISBN in another) yields 409 BARCODE_TAKEN", async () => {
    const code = "9780306406157";
    const results = await Promise.all([
      post(single({ name: "A", sku: "A-1", barcodes: { ean: code } })),
      post(single({ name: "B", sku: "B-1", barcodes: { isbn: code } })),
      post(single({ name: "C", sku: "C-1", barcodes: { ean: code } })),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([201, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe("BARCODE_TAKEN");
  });

  it("adding the same variant combination concurrently yields one 201 and 409s", async () => {
    const id = (await post(shirt())).body.data.product._id;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request.post(`${PRODUCTS}/${id}/variants`).set(auth(admin)).send({ attributeValues: { Size: "L" }, sellingPrice: "5" })
      )
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([201, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe("VARIANT_COMBINATION_TAKEN");
  });

  it("two variants racing to the same SKU via update give 409, not 500", async () => {
    const product = (await post(shirt())).body.data.product;
    const [s, m] = product.variants.map((v: { id: string }) => v.id);
    const results = await Promise.all([
      request.patch(`${PRODUCTS}/${product._id}/variants/${s}`).set(auth(admin)).send({ sku: "SHARED" }),
      request.patch(`${PRODUCTS}/${product._id}/variants/${m}`).set(auth(admin)).send({ sku: "SHARED" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("SKU_TAKEN");
  });
});

describe("barcode and SKU conflicts", () => {
  it("the same 13 digits as EAN on one product and ISBN on another conflict, on create and update", async () => {
    const first = await post(single({ barcodes: { ean: "9780306406157" } }));
    expect(first.status).toBe(201);

    const create = await post(single({ name: "Book", sku: "BOOK-1", barcodes: { isbn: "978-0-306-40615-7" } }));
    expect(create.status).toBe(409);
    expect(create.body.code).toBe("BARCODE_TAKEN");
    expect(create.body.errors[0]).toMatchObject({
      field: "barcodes.isbn",
      meta: { productId: first.body.data.product._id, productName: "Coffee" },
    });

    const other = await post(single({ name: "Other", sku: "OTHER-1", barcodes: undefined }));
    const update = await request
      .patch(`${PRODUCTS}/${other.body.data.product._id}`)
      .set(auth(admin))
      .send({ barcodes: { upc: null, isbn: "9780306406157" } });
    expect(update.status).toBe(409);
    expect(update.body.code).toBe("BARCODE_TAKEN");
  });

  it("updating a single item to another product's SKU or barcode is refused and changes nothing", async () => {
    await post(single());
    const other = (await post(single({ name: "Other", sku: "OTH-1", barcodes: { ean: "6291041500220" } }))).body.data.product;

    const bySku = await request.patch(`${PRODUCTS}/${other._id}`).set(auth(admin)).send({ name: "Renamed", sku: "cof-1" });
    expect(bySku.status).toBe(409);
    expect(bySku.body.code).toBe("SKU_TAKEN");

    const byBarcode = await request
      .patch(`${PRODUCTS}/${other._id}`)
      .set(auth(admin))
      .send({ name: "Renamed", barcodes: { ean: "6291041500213" } });
    expect(byBarcode.status).toBe(409);
    expect(byBarcode.body.code).toBe("BARCODE_TAKEN");

    const after = (await request.get(`${PRODUCTS}/${other._id}`).set(auth(admin))).body.data.product;
    expect(after.name).toBe("Other");
    expect(after.variants[0]).toMatchObject({ sku: "OTH-1", barcodes: { ean: "6291041500220" } });
  });

  it("a deleted variant's combination, SKU and barcode can be reused", async () => {
    const product = (await post(shirt())).body.data.product;
    const base = `${PRODUCTS}/${product._id}/variants`;
    expect((await request.delete(`${base}/${product.variants[0].id}`).set(auth(admin))).status).toBe(200);
    const again = await request.post(base).set(auth(admin)).send({ attributeValues: { Size: "S" }, sku: "TEE-S", sellingPrice: "4" });
    expect(again.status).toBe(201);
  });
});

describe("lookup", () => {
  it("returns inactive products and variants, but not a deleted variant or a deleted product", async () => {
    const product = (await post(shirt({ variants: [
      { attributeValues: { Size: "S" }, sku: "TEE-S", sellingPrice: "4", barcodes: { ean: "6291041500220" } },
      { attributeValues: { Size: "M" }, sku: "TEE-M", sellingPrice: "4", barcodes: { upc: "012345678905" } },
    ] }))).body.data.product;
    const [s, m] = product.variants.map((v: { id: string }) => v.id);

    await request.patch(`${PRODUCTS}/${product._id}/variants/${s}/deactivate`).set(auth(admin)).expect(200);
    await request.patch(`${PRODUCTS}/${product._id}/deactivate`).set(auth(admin)).expect(200);
    const found = await request.get(`${PRODUCTS}/lookup`).query({ code: "6291041500220" }).set(auth(admin));
    expect(found.status).toBe(200);
    expect(found.body.data.product.isActive).toBe(false);
    expect(found.body.data.variantId).toBe(s);

    await request.patch(`${PRODUCTS}/${product._id}/variants/${s}/activate`).set(auth(admin)).expect(200);
    await request.delete(`${PRODUCTS}/${product._id}/variants/${m}`).set(auth(admin)).expect(200);
    expect((await request.get(`${PRODUCTS}/lookup`).query({ code: "TEE-M" }).set(auth(admin))).status).toBe(404);
    expect((await request.get(`${PRODUCTS}/lookup`).query({ code: "012345678905" }).set(auth(admin))).status).toBe(404);

    await request.delete(`${PRODUCTS}/${product._id}`).set(auth(admin)).expect(200);
    expect((await request.get(`${PRODUCTS}/lookup`).query({ code: "6291041500220" }).set(auth(admin))).status).toBe(404);
  });

  it("ignores array and object query parameters instead of injecting operators", async () => {
    await post(single());
    for (const qs of ["code[]=COF-1", "code[$ne]=x", "code[0]=COF-1&code[1]=y"]) {
      const res = await request.get(`${PRODUCTS}/lookup?${qs}`).set(auth(admin));
      expect(res.status, qs).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("list query hardening", () => {
  beforeEach(async () => {
    await post(single());
    await post(single({ name: "Tea", sku: "TEA-1", barcodes: undefined, reportingTags: ["hot"] }));
  });

  it("treats operator-shaped and array parameters as absent", async () => {
    const qs = [
      "search[$ne]=zzz",
      "search[]=zzz",
      "categoryId[$ne]=x",
      "categoryId[]=x",
      "tag[$ne]=x",
      "type[$ne]=goods",
      "isActive[$ne]=true",
      "page[$gt]=0&limit[$gt]=0",
    ];
    for (const q of qs) {
      const res = await request.get(`${PRODUCTS}?${q}`).set(auth(admin));
      expect(res.status, q).toBe(200);
      expect(res.body.data.products, q).toHaveLength(2);
    }
  });

  it("escapes regex input and returns promptly for catastrophic patterns", async () => {
    for (const search of ["(a+)+$", ".*", "^", "[", "\\", "a{1,}{1,}", "x".repeat(5000)]) {
      const started = Date.now();
      const res = await request.get(PRODUCTS).query({ search }).set(auth(admin));
      expect(res.status, search.slice(0, 20)).toBe(200);
      expect(res.body.data.products).toHaveLength(0);
      expect(Date.now() - started).toBeLessThan(3000);
    }
  });

  it("falls back to defaults for garbage paging and a malformed categoryId matches nothing", async () => {
    const paging = await request.get(PRODUCTS).query({ page: "abc", limit: "-5" }).set(auth(admin));
    expect(paging.status).toBe(200);
    expect(paging.body.data.pagination).toMatchObject({ page: 1, limit: 20, total: 2 });

    const huge = await request.get(PRODUCTS).query({ page: "1e99", limit: "Infinity" }).set(auth(admin));
    expect(huge.status).toBe(200);

    const bad = await request.get(PRODUCTS).query({ categoryId: "not-an-id" }).set(auth(admin));
    expect(bad.status).toBe(200);
    expect(bad.body.data.products).toHaveLength(0);
  });
});

describe("malformed ids", () => {
  it("returns 400 rather than 500 for bad path and body ids", async () => {
    const product = (await post(shirt())).body.data.product;
    const variantId = product.variants[0].id;

    const paths = [
      ["patch", `${PRODUCTS}/abc`],
      ["patch", `${PRODUCTS}/abc/deactivate`],
      ["delete", `${PRODUCTS}/abc`],
      ["post", `${PRODUCTS}/abc/variants`],
      ["patch", `${PRODUCTS}/${product._id}/variants/abc`],
      ["patch", `${PRODUCTS}/${product._id}/variants/abc/deactivate`],
      ["delete", `${PRODUCTS}/${product._id}/variants/abc`],
      ["patch", `${PRODUCTS}/abc/variants/${variantId}/activate`],
    ] as const;
    for (const [method, path] of paths) {
      const res = await request[method](path).set(auth(admin)).send({ sku: "X" });
      expect(res.status, `${method} ${path}`).toBeLessThan(500);
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|CastError|Cast to ObjectId/i);
    }

    for (const body of [
      single({ categoryId: "abc" }),
      single({ categoryId: { $ne: null } }),
      single({ taxPreference: "standard", taxRateId: "abc" }),
      single({ taxPreference: "standard", taxRateId: { $ne: null } }),
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    }
    expect((await request.patch(`${PRODUCTS}/${product._id}`).set(auth(admin)).send({ categoryId: "abc" })).status).toBe(400);
  });
});

describe("authorization corners", () => {
  it("a user with no role at all is refused on every catalog route", async () => {
    const norole = await tokenFor(ctx.org._id, "norole@alnoor.test");
    const id = (await post(single())).body.data.product._id;
    expect((await request.get(PRODUCTS).set(auth(norole))).status).toBe(403);
    expect((await request.get(`${PRODUCTS}/${id}`).set(auth(norole))).status).toBe(403);
    expect((await request.get(`${PRODUCTS}/lookup`).query({ code: "COF-1" }).set(auth(norole))).status).toBe(403);
    expect((await request.get(CATEGORIES).set(auth(norole))).status).toBe(403);
    expect((await post(single({ sku: "N-1" }), norole)).status).toBe(403);
    expect((await request.delete(`${PRODUCTS}/${id}`).set(auth(norole))).status).toBe(403);
  });

  it("the model refuses a store role carrying catalog write permissions, so store staff cannot gain org-wide writes", async () => {
    await expect(
      Role.create({
        organizationId: ctx.org._id,
        scope: "store",
        name: "Store Catalog Writer",
        slug: "store_catalog_writer",
        permissions: ["product:read", "product:create", "product:update", "product:delete"],
      })
    ).rejects.toThrow(/not valid at store scope/);
  });

  it("an org role holding only product:read cannot write; one holding only product:create cannot read", async () => {
    const reader = await Role.create({
      organizationId: ctx.org._id, scope: "organization", name: "Reader", slug: "reader", permissions: ["product:read"],
    });
    const creator = await Role.create({
      organizationId: ctx.org._id, scope: "organization", name: "Creator", slug: "creator", permissions: ["product:create"],
    });
    const readerToken = await tokenFor(ctx.org._id, "reader@alnoor.test", { orgRoleId: reader._id });
    const creatorToken = await tokenFor(ctx.org._id, "creator@alnoor.test", { orgRoleId: creator._id });
    const id = (await post(single())).body.data.product._id;

    expect((await request.get(PRODUCTS).set(auth(readerToken))).status).toBe(200);
    expect((await post(single({ sku: "R-1" }), readerToken)).status).toBe(403);
    expect((await request.patch(`${PRODUCTS}/${id}`).set(auth(readerToken)).send({ name: "X" })).status).toBe(403);
    expect((await request.delete(`${PRODUCTS}/${id}/variants/${new mongoose.Types.ObjectId()}`).set(auth(readerToken))).status).toBe(403);

    expect((await post(single({ sku: "C-1", barcodes: undefined }), creatorToken)).status).toBe(201);
    expect((await request.get(PRODUCTS).set(auth(creatorToken))).status).toBe(403);
    expect((await request.patch(`${PRODUCTS}/${id}`).set(auth(creatorToken)).send({ name: "X" })).status).toBe(403);
    expect((await request.delete(`${PRODUCTS}/${id}`).set(auth(creatorToken))).status).toBe(403);
  });

  it("a store role without product:read, and a store role in a different store than the data, see nothing extra", async () => {
    const limited = await Role.create({
      organizationId: ctx.org._id,
      scope: "store",
      name: "Sales Only",
      slug: "sales_only",
      permissions: ["sale:create"],
    });
    const token = await tokenFor(ctx.org._id, "salesonly@alnoor.test", {
      storeAccess: [{ storeId: ctx.store._id, roleId: limited._id }],
    });
    expect((await request.get(PRODUCTS).set(auth(token))).status).toBe(403);

    // Read permission held in only one of two stores still grants the (org-wide) catalog read.
    const second = await Store.create({
      organizationId: ctx.org._id,
      name: "Second",
      code: "ALNOOR-2",
      address: { line1: "Road 2", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
      countryCode: "BH",
      timezone: "Asia/Bahrain",
    });
    const mixed = await tokenFor(ctx.org._id, "mixed@alnoor.test", {
      storeAccess: [
        { storeId: ctx.store._id, roleId: limited._id },
        { storeId: second._id, roleId: ctx.role("cashier")._id },
      ],
    });
    expect((await request.get(PRODUCTS).set(auth(mixed))).status).toBe(200);
  });

  it("rejects a platform (super admin) token and malformed tokens on catalog routes", async () => {
    const platform = generateSuperAdminAccessToken({ userId: new mongoose.Types.ObjectId().toString() });
    for (const token of [platform, "garbage", ""]) {
      expect((await request.get(PRODUCTS).set(auth(token))).status).toBe(401);
      expect((await request.get(CATEGORIES).set(auth(token))).status).toBe(401);
      expect((await post(single(), token)).status).toBe(401);
    }
  });

  it("ignores client-supplied tenant and bookkeeping fields (mass assignment)", async () => {
    const rival = await createOrg("rival");
    const res = await post({
      ...single(),
      organizationId: String(rival.org._id),
      isDelete: true,
      _id: new mongoose.Types.ObjectId().toString(),
    });
    // Either refused as an unknown field, or accepted and ignored; never honoured.
    if (res.status === 201) {
      expect(res.body.data.product.organizationId).toBe(String(ctx.org._id));
    } else {
      expect(res.status).toBe(400);
    }
    expect(await Product.countDocuments({ organizationId: rival.org._id })).toBe(0);

    const id = (await post(single({ name: "Real", sku: "REAL-1", barcodes: undefined }))).body.data.product._id;
    const patch = await request
      .patch(`${PRODUCTS}/${id}`)
      .set(auth(admin))
      .send({ organizationId: String(rival.org._id), isDelete: true });
    if (patch.status === 200) {
      expect(patch.body.data.product.organizationId).toBe(String(ctx.org._id));
    } else {
      expect(patch.status).toBe(400);
    }
    expect((await request.get(`${PRODUCTS}/${id}`).set(auth(admin))).status).toBe(200);
  });
});

describe("soft-deleted parents", () => {
  it("every variant and product mutation on a deleted product is a 404", async () => {
    const product = (await post(shirt())).body.data.product;
    const v = product.variants[0].id;
    await request.delete(`${PRODUCTS}/${product._id}`).set(auth(admin)).expect(200);

    const base = `${PRODUCTS}/${product._id}`;
    const calls = [
      request.get(base),
      request.patch(base).send({ name: "Zombie" }),
      request.patch(`${base}/activate`),
      request.patch(`${base}/deactivate`),
      request.delete(base),
      request.post(`${base}/variants`).send({ attributeValues: { Size: "L" }, sellingPrice: "1" }),
      request.patch(`${base}/variants/${v}`).send({ sellingPrice: "1" }),
      request.patch(`${base}/variants/${v}/activate`),
      request.delete(`${base}/variants/${v}`),
    ];
    for (const call of calls) {
      const res = await call.set(auth(admin));
      expect(res.status).toBe(404);
    }
    expect((await request.get(PRODUCTS).set(auth(admin))).body.data.products).toHaveLength(0);
  });
});

describe("category counts and deletion", () => {
  it("counts only live products, and a category frees up once its products move or are deleted", async () => {
    const a = (await request.post(CATEGORIES).set(auth(admin)).send({ name: "A" })).body.data.category._id;
    const b = (await request.post(CATEGORIES).set(auth(admin)).send({ name: "B" })).body.data.category._id;
    const p1 = (await post(single({ categoryId: a }))).body.data.product._id;
    const p2 = (await post(single({ name: "Two", sku: "TWO", barcodes: undefined, categoryId: a }))).body.data.product._id;

    const count = async (id: string) => (await request.get(`${CATEGORIES}/${id}`).set(auth(admin))).body.data.category.productCount;
    expect(await count(a)).toBe(2);

    await request.delete(`${PRODUCTS}/${p2}`).set(auth(admin)).expect(200);
    expect(await count(a)).toBe(1);
    expect((await request.delete(`${CATEGORIES}/${a}`).set(auth(admin))).body.code).toBe("CATEGORY_IN_USE");

    await request.patch(`${PRODUCTS}/${p1}`).set(auth(admin)).send({ categoryId: b }).expect(200);
    expect(await count(a)).toBe(0);
    expect(await count(b)).toBe(1);
    expect((await request.delete(`${CATEGORIES}/${a}`).set(auth(admin))).status).toBe(200);
    // A deleted category cannot be assigned any more.
    expect((await request.patch(`${PRODUCTS}/${p1}`).set(auth(admin)).send({ categoryId: a })).body.code).toBe("CATEGORY_NOT_FOUND");
  });

  it("concurrent creation of the same category name gives one 201 and 409s, never 500", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request.post(CATEGORIES).set(auth(admin)).send({ name: "Dup" }))
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
  });
});

describe("price audit", () => {
  it("records before/after prices for the right variant, and only the changed update", async () => {
    const product = (await post(shirt())).body.data.product;
    const s = product.variants[0].id;
    await request.patch(`${PRODUCTS}/${product._id}/variants/${s}`).set(auth(admin)).send({ sellingPrice: "4.250", costPrice: "2" }).expect(200);
    // Same price again, and a non-price change: no further entries.
    await request.patch(`${PRODUCTS}/${product._id}/variants/${s}`).set(auth(admin)).send({ sellingPrice: "4.250" }).expect(200);
    await request.patch(`${PRODUCTS}/${product._id}/variants/${s}`).set(auth(admin)).send({ sku: "TEE-SMALL" }).expect(200);

    const logs = await AuditLog.find({ organizationId: ctx.org._id, action: "product.price_changed" });
    expect(logs).toHaveLength(1);
    expect(logs[0].targetType).toBe("product");
    expect(String(logs[0].targetId)).toBe(product._id);
    expect(logs[0].before).toEqual({ variantId: s, sellingPrice: "4.000", costPrice: null });
    expect(logs[0].after).toEqual({ variantId: s, sellingPrice: "4.250", costPrice: "2.000" });
  });

  it("a single item's top-level price edit is audited with the default variant", async () => {
    const product = (await post(single())).body.data.product;
    await request.patch(`${PRODUCTS}/${product._id}`).set(auth(admin)).send({ purchase: { costPrice: null } }).expect(200);
    const [log] = await AuditLog.find({ organizationId: ctx.org._id, action: "product.price_changed" });
    expect(log.before).toMatchObject({ sellingPrice: "2.750", costPrice: "1.600" });
    expect(log.after).toMatchObject({ sellingPrice: "2.750", costPrice: null });
  });

  it("a failing audit write does not fail the price update", async () => {
    const product = (await post(single())).body.data.product;
    const spy = vi.spyOn(AuditLog, "create").mockRejectedValue(new Error("audit store down") as never);
    try {
      const res = await request.patch(`${PRODUCTS}/${product._id}`).set(auth(admin)).send({ sales: { sellingPrice: "9.000" } });
      expect(res.status).toBe(200);
      expect(res.body.data.product.variants[0].sellingPrice).toBe("9.000");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("guards", () => {
  it("CURRENCY_LOCKED wins over CURRENCY_STORE_MISMATCH once products exist", async () => {
    await post(single());
    // BH store, new currency AED: would also be a store mismatch, but the lock is reported first.
    const res = await request.patch(ORG).set(auth(admin)).send({ settings: { currency: "AED" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CURRENCY_LOCKED");
  });

  it("without products the store mismatch is still reported", async () => {
    const res = await request.patch(ORG).set(auth(admin)).send({ settings: { currency: "AED" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CURRENCY_STORE_MISMATCH");
  });

  it("deleting the last product unlocks the currency rule (deleted products do not count)", async () => {
    const id = (await post(single())).body.data.product._id;
    await request.delete(`${PRODUCTS}/${id}`).set(auth(admin)).expect(200);
    const res = await request.patch(ORG).set(auth(admin)).send({ settings: { currency: "AED" } });
    expect(res.body.code).not.toBe("CURRENCY_LOCKED");
  });
});
