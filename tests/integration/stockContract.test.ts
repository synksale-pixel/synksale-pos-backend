/**
 * Purpose: Phase 2 stock wiring that the validator unit tests cannot see: opening stock store
 * checks on add-variant and on variant items, the inventory:read role seeding and sync, the
 * accountant's catalog access, the privilege ceiling for the new key, and the Swagger document.
 */

import { beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Product } from "../../src/models/product.model";
import { seedDefaultRolesForOrganization, syncSystemRolePermissions } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { variantExample } from "../../src/docs/product.openapi";

const PRODUCTS = "/api/v1/products";
const CATEGORIES = "/api/v1/categories";
const ROLES = "/api/v1/roles";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function setup(slug: string) {
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
  orgId: unknown,
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

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: string;
let categoryId: string;

beforeEach(async () => {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
  categoryId = (await request.post(CATEGORIES).set(auth(admin)).send({ name: "Apparel" })).body.data.category._id;
});

const openingFor = () => [{ storeId: new mongoose.Types.ObjectId().toString(), quantity: 2 }];

describe("opening stock referring to an unknown store is refused before anything is written", () => {
  const createVariantItem = (patch?: (variants: Record<string, unknown>[]) => void) => {
    const variants = JSON.parse(JSON.stringify((variantExample as any).variants)) as Record<string, unknown>[];
    patch?.(variants);
    return request.post(PRODUCTS).set(auth(admin)).send({ ...variantExample, categoryId, taxRateId: undefined, variants });
  };

  it("refuses variants[i].openingStock with an unknown store, naming the field, and persists nothing", async () => {
    const res = await createVariantItem((v) => {
      v[1].openingStock = openingFor();
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("STORE_NOT_FOUND");
    expect(res.body.errors[0]).toMatchObject({ field: "variants[1].openingStock[0].storeId", code: "STORE_NOT_FOUND" });
    expect(await Product.countDocuments({})).toBe(0);
  });

  it("refuses add-variant opening stock with an unknown store and leaves the product unchanged", async () => {
    const created = await createVariantItem();
    expect(created.status).toBe(201);
    const product = created.body.data.product;
    const before = product.variants.length;

    const res = await request
      .post(`${PRODUCTS}/${product._id}/variants`)
      .set(auth(admin))
      .send({ attributeValues: { Size: "S", Colour: "Blue" }, sellingPrice: "4.000", openingStock: openingFor() });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({ field: "openingStock[0].storeId", code: "STORE_NOT_FOUND" });

    const after = await request.get(`${PRODUCTS}/${product._id}`).set(auth(admin));
    expect(after.body.data.product.variants).toHaveLength(before);
  });

  it("refuses openingStock on product update", async () => {
    const created = await createVariantItem();
    const res = await request
      .patch(`${PRODUCTS}/${created.body.data.product._id}`)
      .set(auth(admin))
      .send({ inventory: { openingStock: openingFor() } });
    expect(res.status).toBe(400);
  });
});

describe("store stock routes", () => {
  it("return 404 for a store outside the organization without leaking internals", async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const res = await request.get(`/api/v1/stores/${id}/stock`).set(auth(admin));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/\.ts:|stack/);
  });
});

describe("inventory:read role seeding", () => {
  const permsOf = (slug: string) => ctx.role(slug).permissions as string[];

  it("seeds inventory:read on the intended roles only", async () => {
    for (const slug of ["org_admin", "store_manager", "inventory_clerk", "accountant"]) {
      expect(permsOf(slug), slug).toContain("inventory:read");
    }
    expect(permsOf("cashier")).not.toContain("inventory:read");
    expect(permsOf("accountant")).toContain("product:read");
    // The accountant must not gain write access to stock or the catalog.
    for (const key of ["inventory:adjust", "inventory:transfer", "product:create", "product:update", "product:delete"]) {
      expect(permsOf("accountant"), key).not.toContain(key);
    }
  });

  it("sync adds inventory:read and accountant product:read to an org seeded with the old templates", async () => {
    const old = await setup("legacy");
    await Role.updateOne(
      { organizationId: old.org._id, slug: "accountant" },
      { $set: { permissions: ["report:view_org", "report:view_store", "sale:refund", "tax:manage"] } }
    );
    await Role.updateOne({ organizationId: old.org._id, slug: "inventory_clerk" }, { $set: { permissions: ["product:read", "inventory:adjust"] } });
    await Role.updateOne({ organizationId: old.org._id, slug: "store_manager" }, { $pull: { permissions: "inventory:read" } });

    const results = await syncSystemRolePermissions(old.org._id);
    const added = (slug: string) => results.find((r) => r.slug === slug)?.added ?? [];
    // The Phase 3a purchase keys are missing from these pre-Phase 2 roles too, so the sync adds them as well.
    expect([...added("accountant")].sort()).toEqual(["inventory:read", "product:read", "purchase:read", "vendor:manage"]);
    expect([...added("inventory_clerk")].sort()).toEqual(["inventory:read", "purchase:read"]);
    expect(added("store_manager")).toEqual(["inventory:read"]);

    const accountant = await Role.findOne({ organizationId: old.org._id, slug: "accountant" });
    expect(accountant!.permissions).toEqual(expect.arrayContaining(["report:view_org", "tax:manage", "inventory:read", "product:read"]));
    // Idempotent: a second run changes nothing.
    expect(await syncSystemRolePermissions(old.org._id)).toEqual([]);
  });

  it("sync scoped to one organization leaves another untouched", async () => {
    const other = await setup("other");
    await Role.updateOne({ organizationId: other.org._id, slug: "inventory_clerk" }, { $set: { permissions: ["product:read", "inventory:adjust"] } });
    await syncSystemRolePermissions(ctx.org._id);
    const clerk = await Role.findOne({ organizationId: other.org._id, slug: "inventory_clerk" });
    expect(clerk!.permissions).not.toContain("inventory:read");
  });
});

describe("accountant catalog access (behaviour change)", () => {
  it("can now read products and categories but still cannot write", async () => {
    const accountant = await tokenFor(ctx.org._id, "acct@alnoor.test", { orgRoleId: ctx.role("accountant")._id });
    expect((await request.get(PRODUCTS).set(auth(accountant))).status).toBe(200);
    expect((await request.get(CATEGORIES).set(auth(accountant))).status).toBe(200);
    expect((await request.post(PRODUCTS).set(auth(accountant)).send({ name: "X", type: "service", sales: { sellingPrice: "1" } })).status).toBe(403);
    expect((await request.post(CATEGORIES).set(auth(accountant)).send({ name: "X" })).status).toBe(403);
  });

  it("cannot read another organization's products", async () => {
    const created = await request
      .post(PRODUCTS)
      .set(auth(admin))
      .send({ name: "Gift wrap", type: "service", sales: { sellingPrice: "0.500" } });
    expect(created.status).toBe(201);
    const rival = await setup("rival");
    const accountant = await tokenFor(rival.org._id, "acct@rival.test", { orgRoleId: rival.role("accountant")._id });
    const res = await request.get(`${PRODUCTS}/${created.body.data.product._id}`).set(auth(accountant));
    expect(res.status).toBe(404);
    expect((await request.get(PRODUCTS).set(auth(accountant))).body.data.products).toHaveLength(0);
  });
});

describe("inventory:read in custom roles", () => {
  it("fits a store-scoped custom role", async () => {
    const res = await request
      .post(ROLES)
      .set(auth(admin))
      .send({ name: "Stock viewer", scope: "store", permissions: ["product:read", "inventory:read"] });
    expect(res.status).toBe(201);
  });

  it("the privilege ceiling blocks granting inventory:read without holding it", async () => {
    const limited = await Role.create({
      organizationId: ctx.org._id,
      scope: "organization",
      name: "Role admin",
      slug: "role_admin",
      permissions: ["role:manage", "user:read", "product:read"],
    });
    const token = await tokenFor(ctx.org._id, "ra@alnoor.test", { orgRoleId: limited._id });
    const res = await request.post(ROLES).set(auth(token)).send({ name: "Stock viewer", scope: "store", permissions: ["inventory:read"] });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/privilege ceiling/i);
  });
});

describe("OpenAPI document", () => {
  it("is served and lists the Inventory paths with the contract schemas", async () => {
    const res = await request.get("/api-docs.json");
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    for (const p of [
      "/stores/{storeId}/stock",
      "/products/{productId}/stock",
      "/stores/{storeId}/stock-movements",
      "/stores/{storeId}/stock-adjustments",
      "/stores/{storeId}/stock-adjustments/{adjustmentId}",
      "/stock-transfers",
      "/stock-transfers/{transferId}",
    ]) {
      expect(
        paths.some((x) => x.endsWith(p)),
        p
      ).toBe(true);
    }
    const schemas = Object.keys(res.body.components.schemas);
    expect(schemas).toEqual(expect.arrayContaining(["CreateStockAdjustmentInput", "CreateStockTransferInput", "OpeningStockLineInput"]));
  });
});
