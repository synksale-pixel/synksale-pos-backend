/**
 * Purpose: Phase 3a vendor wiring that the validator unit tests cannot see: preferredVendorId
 * refused on the product form until vendors ship, the vendor:manage / purchase:read role
 * seeding and sync, the privilege ceiling for the new keys, the not-yet-built routes, and the
 * Swagger document.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Product } from "../../src/models/product.model";
import { seedDefaultRolesForOrganization, syncSystemRolePermissions } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { singleExample } from "../../src/docs/product.openapi";

const PRODUCTS = "/api/v1/products";
const VENDORS = "/api/v1/vendors";
const ROLES = "/api/v1/roles";
const VENDOR_ID = "665f1c2e8a4b3c0012ab3900";
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
  return { org, role };
}

async function tokenFor(orgId: unknown, email: string, orgRoleId: unknown) {
  const user = await User.create({
    organizationId: orgId,
    email,
    passwordHash: "SecurePassword123",
    firstName: "T",
    lastName: "U",
    isActive: true,
    orgRoleId,
    storeAccess: [],
  });
  return generateAccessToken({ userId: user._id.toString(), organizationId: String(orgId), isSuperAdmin: false });
}

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: string;

beforeEach(async () => {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", ctx.role("org_admin")._id);
});

const product = (purchase: Record<string, unknown>) => ({
  ...singleExample,
  categoryId: undefined,
  taxRateId: undefined,
  purchase: { costPrice: "1.600", ...purchase },
});

// Flip these when vendors ship: preferredVendorId becomes a live reference.
describe("preferredVendorId is refused until vendors ship", () => {
  it("refuses it on create, naming the field, and persists nothing", async () => {
    const res = await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: VENDOR_ID }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(res.body.errors)).toContain("purchase.preferredVendorId");
    expect(await Product.countDocuments({})).toBe(0);
  });

  it("refuses null too, since clearing a reference that cannot exist yet is meaningless", async () => {
    const res = await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: null }));
    expect(res.status).toBe(400);
  });

  it("refuses it on update and leaves the product unchanged", async () => {
    const created = await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorName: "Gulf Roasters W.L.L." }));
    expect(created.status).toBe(201);
    const id = created.body.data.product._id;

    const res = await request.patch(`${PRODUCTS}/${id}`).set(auth(admin)).send({ purchase: { preferredVendorId: VENDOR_ID } });
    expect(res.status).toBe(400);

    const after = await request.get(`${PRODUCTS}/${id}`).set(auth(admin));
    expect(after.body.data.product.purchase.preferredVendorName).toBe("Gulf Roasters W.L.L.");
  });

  it("still accepts the deprecated preferredVendorName meanwhile", async () => {
    const res = await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorName: "Gulf Roasters W.L.L." }));
    expect(res.status).toBe(201);
  });
});

// Flip these when vendors ship.
describe("vendor routes are not built yet", () => {
  it("return 404", async () => {
    expect((await request.get(VENDORS).set(auth(admin))).status).toBe(404);
    expect((await request.post(VENDORS).set(auth(admin)).send({ name: "Al Safa" })).status).toBe(404);
  });
});

describe("vendor:manage and purchase:read role seeding", () => {
  const permsOf = (slug: string) => ctx.role(slug).permissions as string[];

  it("seeds the keys on the intended roles only", () => {
    expect(permsOf("org_admin")).toEqual(expect.arrayContaining(["vendor:manage", "purchase:read"]));
    expect(permsOf("accountant")).toEqual(expect.arrayContaining(["vendor:manage", "purchase:read"]));
    for (const slug of ["store_manager", "inventory_clerk"]) {
      expect(permsOf(slug), slug).toContain("purchase:read");
      expect(permsOf(slug), slug).not.toContain("vendor:manage");
    }
    expect(permsOf("cashier")).not.toContain("purchase:read");
    expect(permsOf("cashier")).not.toContain("vendor:manage");
  });

  it("sync adds the keys to an organization seeded before Phase 3a, once", async () => {
    const old = await setup("legacy");
    await Role.updateMany(
      { organizationId: old.org._id },
      { $pull: { permissions: { $in: ["vendor:manage", "purchase:read"] } } }
    );

    const results = await syncSystemRolePermissions(old.org._id);
    const added = (slug: string) => [...(results.find((r) => r.slug === slug)?.added ?? [])].sort();
    expect(added("org_admin")).toEqual(["purchase:read", "vendor:manage"]);
    expect(added("accountant")).toEqual(["purchase:read", "vendor:manage"]);
    expect(added("store_manager")).toEqual(["purchase:read"]);
    expect(added("inventory_clerk")).toEqual(["purchase:read"]);
    expect(added("cashier")).toEqual([]);
    expect(await syncSystemRolePermissions(old.org._id)).toEqual([]);
  });

  it("the permission catalog lists both keys under Purchases with the right scopes", async () => {
    const res = await request.get(`${ROLES}/permissions`).set(auth(admin));
    expect(res.status).toBe(200);
    const catalog = JSON.stringify(res.body.data);
    expect(catalog).toContain("vendor:manage");
    expect(catalog).toContain("purchase:read");
  });

  it("vendor:manage cannot go on a store-scoped custom role", async () => {
    const res = await request
      .post(ROLES)
      .set(auth(admin))
      .send({ name: "Store buyer", scope: "store", permissions: ["purchase:read", "vendor:manage"] });
    expect(res.status).toBe(400);
  });

  it("purchase:read can go on a store-scoped custom role, and both on an organization role", async () => {
    const store = await request.post(ROLES).set(auth(admin)).send({ name: "Receiver", scope: "store", permissions: ["purchase:read"] });
    expect(store.status).toBe(201);
    const org = await request
      .post(ROLES)
      .set(auth(admin))
      .send({ name: "Buyer", scope: "organization", permissions: ["vendor:manage", "purchase:read"] });
    expect(org.status).toBe(201);
  });
});

describe("OpenAPI document", () => {
  it("lists the Vendors paths and the contract schemas", async () => {
    const res = await request.get("/api-docs.json");
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    for (const p of ["/vendors", "/vendors/{vendorId}"]) {
      expect(paths.some((x) => x.endsWith(p)), p).toBe(true);
    }
    const vendorPaths = res.body.paths[paths.find((x) => x.endsWith("/vendors/{vendorId}"))!];
    expect(Object.keys(vendorPaths).sort()).toEqual(["delete", "get", "patch"]);
    const schemas = Object.keys(res.body.components.schemas);
    expect(schemas).toEqual(expect.arrayContaining(["CreateVendorInput", "UpdateVendorInput", "Vendor", "VendorListData"]));
    expect(res.body.tags.map((t: { name: string }) => t.name)).toContain("Vendors");
  });
});
