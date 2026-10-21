/**
 * Purpose: HTTP tests for /api/v1/categories and /api/v1/products. The rules themselves are
 * covered in catalogServices.test.ts; this file checks the wiring: authentication, who may read
 * and write, validation, status codes, route ordering, tenant isolation, and that every response
 * matches the documented (Swagger) response schema exactly.
 */

import { beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { z } from "zod";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import {
  CategorySchema,
  ProductSchema,
  ProductSummarySchema,
  ProductVariantSchema,
  PaginationSchema,
} from "../../src/validators/responses";
import { singleExample, variantExample, serviceExample } from "../../src/docs/product.openapi";

const CATEGORIES = "/api/v1/categories";
const PRODUCTS = "/api/v1/products";

/** Deep-strict copies of the documented shapes: an undocumented or missing field fails. */
const strictVariant = ProductVariantSchema.strict();
const strictProduct = ProductSchema.extend({ variants: z.array(strictVariant) }).strict();
const strictSummary = ProductSummarySchema.strict();
const strictCategory = CategorySchema.strict();

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
  const role = (slug: string) => roles.find((r) => r.slug === slug)!;
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
  opts: { orgRoleId?: unknown; storeAccess?: { storeId: unknown; roleId: unknown }[] }
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

let admin: string;
let cashier: string;
// An organization role without product:read (the accountant has it since Phase 2, for stock valuation).
let noCatalog: string;
let categoryId: string;

beforeEach(async () => {
  const { org, role, store } = await createOrg("alnoor");
  admin = await tokenFor(org._id, "admin@alnoor.test", { orgRoleId: role("org_admin")._id });
  cashier = await tokenFor(org._id, "cashier@alnoor.test", {
    storeAccess: [{ storeId: store._id, roleId: role("cashier")._id }],
  });
  const reportsOnly = await Role.create({
    organizationId: org._id,
    scope: "organization",
    name: "Reports only",
    slug: "reports_only",
    permissions: ["report:view_org"],
  });
  noCatalog = await tokenFor(org._id, "reports@alnoor.test", { orgRoleId: reportsOnly._id });

  // The Swagger examples reference fixed ids; point them at real records.
  const category = await request.post(CATEGORIES).set(auth(admin)).send({ name: "Beverages", sortOrder: 10 });
  categoryId = category.body.data.category._id;
});

const createFromExample = (example: Record<string, unknown>) =>
  request
    .post(PRODUCTS)
    .set(auth(admin))
    .send({ ...example, categoryId, taxRateId: undefined });

describe("categories over HTTP", () => {
  it("creates, lists, gets, updates and deletes with documented shapes", async () => {
    const list = await request.get(CATEGORIES).set(auth(admin));
    expect(list.status).toBe(200);
    expect(list.body.data.categories).toHaveLength(1);
    strictCategory.parse(list.body.data.categories[0]);

    const got = await request.get(`${CATEGORIES}/${categoryId}`).set(auth(admin));
    expect(got.status).toBe(200);
    expect(strictCategory.parse(got.body.data.category)).toMatchObject({ name: "Beverages", productCount: 0 });

    const updated = await request.patch(`${CATEGORIES}/${categoryId}`).set(auth(admin)).send({ name: "Drinks" });
    expect(updated.status).toBe(200);
    expect(updated.body.data.category.name).toBe("Drinks");

    const removed = await request.delete(`${CATEGORIES}/${categoryId}`).set(auth(admin));
    expect(removed.status).toBe(200);
    expect(removed.body.data).toBeNull();
    expect((await request.get(`${CATEGORIES}/${categoryId}`).set(auth(admin))).body.code).toBe("CATEGORY_NOT_FOUND");
  });

  it("returns 409 CATEGORY_NAME_TAKEN and 400 VALIDATION_FAILED", async () => {
    const dup = await request.post(CATEGORIES).set(auth(admin)).send({ name: "beverages" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("CATEGORY_NAME_TAKEN");

    const bad = await request.post(CATEGORIES).set(auth(admin)).send({ name: "" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("VALIDATION_FAILED");
  });

  it("lets a cashier read but not write; refuses an org role without product:read", async () => {
    expect((await request.get(CATEGORIES).set(auth(cashier))).status).toBe(200);
    expect((await request.post(CATEGORIES).set(auth(cashier)).send({ name: "X" })).status).toBe(403);
    expect((await request.get(CATEGORIES).set(auth(noCatalog))).status).toBe(403);
    expect((await request.get(CATEGORIES)).status).toBe(401);
  });

  it("returns 400 for a malformed id", async () => {
    expect((await request.get(`${CATEGORIES}/abc`).set(auth(admin))).status).toBe(400);
  });
});

describe("products over HTTP", () => {
  it("creates each Swagger example and returns the documented shape", async () => {
    for (const example of [singleExample, variantExample, serviceExample]) {
      const res = await createFromExample(example);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      strictProduct.parse(res.body.data.product);
    }

    const list = await request.get(PRODUCTS).set(auth(admin));
    expect(list.status).toBe(200);
    expect(list.body.data.products).toHaveLength(3);
    list.body.data.products.forEach((row: unknown) => strictSummary.parse(row));
    PaginationSchema.parse(list.body.data.pagination);
  });

  it("serves /lookup ahead of /:productId, for cashiers too", async () => {
    const created = (await createFromExample(singleExample)).body.data.product;

    const res = await request.get(`${PRODUCTS}/lookup`).query({ code: "6291041500213" }).set(auth(cashier));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ matchedOn: "ean", variantId: created.variants[0].id });
    strictProduct.parse(res.body.data.product);

    const missing = await request.get(`${PRODUCTS}/lookup`).set(auth(cashier));
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VALIDATION_FAILED");
  });

  it("parses list query strings leniently", async () => {
    await createFromExample(singleExample);
    const res = await request
      .get(PRODUCTS)
      .query({ search: "arab", type: "goods", isActive: "true", page: "1", limit: "500", categoryId })
      .set(auth(cashier));
    expect(res.status).toBe(200);
    expect(res.body.data.products).toHaveLength(1);
    expect(res.body.data.pagination.limit).toBe(100);

    const ignored = await request.get(PRODUCTS).query({ type: "nonsense", isActive: "maybe" }).set(auth(admin));
    expect(ignored.status).toBe(200);
    expect(ignored.body.data.products).toHaveLength(1);
  });

  it("updates, toggles and deletes a product", async () => {
    const id = (await createFromExample(singleExample)).body.data.product._id;

    const updated = await request.patch(`${PRODUCTS}/${id}`).set(auth(admin)).send({ sales: { sellingPrice: "3.000" } });
    expect(updated.status).toBe(200);
    expect(updated.body.data.product.variants[0].sellingPrice).toBe("3.000");

    const off = await request.patch(`${PRODUCTS}/${id}/deactivate`).set(auth(admin));
    expect(off.status).toBe(200);
    expect(off.body.data.product.isActive).toBe(false);
    expect((await request.patch(`${PRODUCTS}/${id}/activate`).set(auth(admin))).body.data.product.isActive).toBe(true);

    const removed = await request.delete(`${PRODUCTS}/${id}`).set(auth(admin));
    expect(removed.status).toBe(200);
    expect((await request.get(`${PRODUCTS}/${id}`).set(auth(admin))).status).toBe(404);
  });

  it("manages variants and returns the whole product", async () => {
    const product = (await createFromExample(variantExample)).body.data.product;
    const base = `${PRODUCTS}/${product._id}/variants`;

    const added = await request.post(base).set(auth(admin)).send({ attributeValues: { Size: "S", Colour: "Blue" }, sellingPrice: "4.000" });
    expect(added.status).toBe(201);
    strictProduct.parse(added.body.data.product);
    const newId = added.body.data.product.variants[2].id;

    const edited = await request.patch(`${base}/${newId}`).set(auth(admin)).send({ sku: "TSHIRT-BLUE-S" });
    expect(edited.status).toBe(200);
    expect(edited.body.data.product.variants[2].sku).toBe("TSHIRT-BLUE-S");

    expect((await request.patch(`${base}/${newId}/deactivate`).set(auth(admin))).status).toBe(200);
    expect((await request.patch(`${base}/${newId}/activate`).set(auth(admin))).status).toBe(200);
    const removed = await request.delete(`${base}/${newId}`).set(auth(admin));
    expect(removed.status).toBe(200);
    expect(removed.body.data.product.variants).toHaveLength(2);

    const immutable = await request.patch(`${base}/${product.variants[0].id}`).set(auth(admin)).send({ attributeValues: { Size: "L" } });
    expect(immutable.status).toBe(400);
  });

  it("returns the documented error codes", async () => {
    const created = (await createFromExample(singleExample)).body.data.product;

    const taken = await createFromExample({ ...singleExample, barcodes: undefined });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("SKU_TAKEN");
    expect(taken.body.errors[0]).toMatchObject({ field: "sku", meta: { productId: created._id } });

    const decimals = await createFromExample({ ...singleExample, sku: "X", barcodes: undefined, sales: { sellingPrice: "1.2345" } });
    expect(decimals.status).toBe(400);

    const opening = await createFromExample({ ...singleExample, openingStock: 5 });
    expect(opening.status).toBe(400);
    expect(opening.body.code).toBe("VALIDATION_FAILED");

    // Opening stock naming a store outside the organization is refused and nothing is saved.
    const store = new mongoose.Types.ObjectId().toString();
    const contractOpening = await createFromExample({
      ...singleExample,
      sku: "OPEN-1",
      barcodes: undefined,
      inventory: { openingStock: [{ storeId: store, quantity: 2 }] },
    });
    expect(contractOpening.status).toBe(400);
    expect(contractOpening.body.errors[0]).toMatchObject({ field: "inventory.openingStock[0].storeId", code: "STORE_NOT_FOUND" });
    expect((await request.get(`${PRODUCTS}?search=OPEN-1`).set(auth(admin))).body.data.products).toHaveLength(0);

    const variantOnly = await request.post(`${PRODUCTS}/${created._id}/variants`).set(auth(admin)).send({ attributeValues: { Size: "S" }, sellingPrice: "1" });
    expect(variantOnly.status).toBe(400);
    expect(variantOnly.body.code).toBe("PRODUCT_NOT_VARIANT_ITEM");

    expect((await request.get(`${PRODUCTS}/abc`).set(auth(admin))).status).toBe(400);
    expect((await request.get(`${PRODUCTS}/${new mongoose.Types.ObjectId()}`).set(auth(admin))).body.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("lets a cashier read but not write; refuses an org role without product:read", async () => {
    const id = (await createFromExample(singleExample)).body.data.product._id;
    expect((await request.get(PRODUCTS).set(auth(cashier))).status).toBe(200);
    expect((await request.get(`${PRODUCTS}/${id}`).set(auth(cashier))).status).toBe(200);
    expect((await request.post(PRODUCTS).set(auth(cashier)).send(serviceExample)).status).toBe(403);
    expect((await request.patch(`${PRODUCTS}/${id}`).set(auth(cashier)).send({ name: "X" })).status).toBe(403);
    expect((await request.delete(`${PRODUCTS}/${id}`).set(auth(cashier))).status).toBe(403);
    expect((await request.get(PRODUCTS).set(auth(noCatalog))).status).toBe(403);
    expect((await request.get(PRODUCTS)).status).toBe(401);
  });

  it("keeps organizations apart", async () => {
    const id = (await createFromExample(singleExample)).body.data.product._id;
    const other = await createOrg("rival");
    const rival = await tokenFor(other.org._id, "admin@rival.test", { orgRoleId: other.role("org_admin")._id });

    expect((await request.get(`${PRODUCTS}/${id}`).set(auth(rival))).status).toBe(404);
    expect((await request.patch(`${PRODUCTS}/${id}`).set(auth(rival)).send({ name: "Mine" })).status).toBe(404);
    expect((await request.delete(`${PRODUCTS}/${id}`).set(auth(rival))).status).toBe(404);
    expect((await request.get(`${PRODUCTS}/lookup`).query({ code: "6291041500213" }).set(auth(rival))).status).toBe(404);
    expect((await request.get(PRODUCTS).set(auth(rival))).body.data.products).toHaveLength(0);
    // The same SKU and barcode are free in another organization.
    expect((await request.post(PRODUCTS).set(auth(rival)).send({ ...singleExample, categoryId: undefined, taxRateId: undefined })).status).toBe(201);
    // A rival's category cannot be referenced.
    const foreign = await request.post(PRODUCTS).set(auth(rival)).send({ ...serviceExample, categoryId });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe("CATEGORY_NOT_FOUND");
  });
});
