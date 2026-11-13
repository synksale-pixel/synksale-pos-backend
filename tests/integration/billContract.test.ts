/**
 * Purpose: Phase 3d vendor bill and payment wiring that the validator unit tests cannot see: the
 * purchase:bill / purchase:pay role seeding and sync, role scope rules for the new keys, the
 * contract-preview routes and the Swagger document.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { seedDefaultRolesForOrganization, syncSystemRolePermissions } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { billExample, vendorPaymentExample, voidBillExample, voidVendorPaymentExample } from "../../src/docs/bill.openapi";

const BILLS = "/api/v1/bills";
const PAYMENTS = "/api/v1/vendor-payments";
const ROLES = "/api/v1/roles";
const BILL_ID = "665f1c2e8a4b3c0012ab3e00";
const PAYMENT_ID = "665f1c2e8a4b3c0012ab3f00";
const NEW_KEYS = ["purchase:bill", "purchase:pay"];
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
  const roles = await Role.find({ organizationId: org._id });
  const role = (s: string) => roles.find((r) => r.slug === s)!;
  return { org, role };
}

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: string;

beforeEach(async () => {
  ctx = await setup("alnoor");
  const user = await User.create({
    organizationId: ctx.org._id,
    email: "admin@alnoor.test",
    passwordHash: "SecurePassword123",
    firstName: "T",
    lastName: "U",
    isActive: true,
    orgRoleId: ctx.role("org_admin")._id,
    storeAccess: [],
  });
  admin = generateAccessToken({ userId: user._id.toString(), organizationId: String(ctx.org._id), isSuperAdmin: false });
});

describe("purchase:bill and purchase:pay role seeding", () => {
  const permsOf = (slug: string) => ctx.role(slug).permissions as string[];

  it("seeds both keys on org_admin and accountant only", () => {
    for (const slug of ["org_admin", "accountant"]) {
      expect(permsOf(slug), slug).toEqual(expect.arrayContaining(NEW_KEYS));
    }
    for (const slug of ["store_manager", "inventory_clerk", "cashier"]) {
      for (const key of NEW_KEYS) expect(permsOf(slug), slug).not.toContain(key);
    }
  });

  it("sync adds the keys to an organization seeded before Phase 3d, once", async () => {
    const old = await setup("legacy");
    await Role.updateMany({ organizationId: old.org._id }, { $pull: { permissions: { $in: NEW_KEYS } } });

    const results = await syncSystemRolePermissions(old.org._id);
    const added = (slug: string) => [...(results.find((r) => r.slug === slug)?.added ?? [])].sort();
    expect(added("org_admin")).toEqual(NEW_KEYS);
    expect(added("accountant")).toEqual(NEW_KEYS);
    expect(results.map((r) => r.slug).sort()).toEqual(["accountant", "org_admin"]);
    expect(await syncSystemRolePermissions(old.org._id)).toEqual([]);
  });

  it("the permission catalog lists both keys", async () => {
    const res = await request.get(`${ROLES}/permissions`).set(auth(admin));
    expect(res.status).toBe(200);
    const catalog = JSON.stringify(res.body.data);
    for (const key of NEW_KEYS) expect(catalog).toContain(key);
  });

  it("neither key can go on a store-scoped custom role", async () => {
    for (const key of NEW_KEYS) {
      const res = await request
        .post(ROLES)
        .set(auth(admin))
        .send({ name: `Store ${key}`, scope: "store", permissions: ["purchase:read", key] });
      expect(res.status, key).toBe(400);
    }
  });

  it("an organization role can hold either key alone (record bills without paying them)", async () => {
    const billing = await request
      .post(ROLES)
      .set(auth(admin))
      .send({ name: "AP clerk", scope: "organization", permissions: ["purchase:read", "purchase:bill"] });
    expect(billing.status).toBe(201);
    const paying = await request
      .post(ROLES)
      .set(auth(admin))
      .send({ name: "Treasury", scope: "organization", permissions: ["purchase:read", "purchase:pay"] });
    expect(paying.status).toBe(201);
  });
});

describe("contract preview: bill and payment routes are not live yet", () => {
  it("every documented route returns 404", async () => {
    const key = "6c8e4f0e-2a7b-4d3c-9f51-0b2d7a1e9c44";
    const calls = [
      request.get(BILLS),
      request.post(BILLS).set("Idempotency-Key", key).send(billExample),
      request.get(`${BILLS}/${BILL_ID}`),
      request.post(`${BILLS}/${BILL_ID}/void`).set("Idempotency-Key", key).send(voidBillExample),
      request.get(PAYMENTS),
      request.post(PAYMENTS).set("Idempotency-Key", key).send(vendorPaymentExample),
      request.get(`${PAYMENTS}/${PAYMENT_ID}`),
      request.post(`${PAYMENTS}/${PAYMENT_ID}/void`).set("Idempotency-Key", key).send(voidVendorPaymentExample),
    ];
    for (const call of calls) {
      const res = await call.set(auth(admin));
      expect(res.status).toBe(404);
    }
  });
});

describe("OpenAPI document", () => {
  it("lists the bill and payment paths and the contract schemas", async () => {
    const res = await request.get("/api-docs.json");
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    const methods = (suffix: string) => {
      const path = paths.find((x) => x.endsWith(suffix));
      expect(path, suffix).toBeDefined();
      return Object.keys(res.body.paths[path!]).sort();
    };
    // Organization-level: nothing under /stores.
    expect(paths.filter((x) => /\/stores\/.*\/(bills|vendor-payments)/.test(x))).toEqual([]);
    expect(methods("/v1/bills")).toEqual(["get", "post"]);
    // Bills are never edited or deleted: void only.
    expect(methods("/v1/bills/{billId}")).toEqual(["get"]);
    expect(methods("/v1/bills/{billId}/void")).toEqual(["post"]);
    expect(methods("/v1/vendor-payments")).toEqual(["get", "post"]);
    expect(methods("/v1/vendor-payments/{paymentId}")).toEqual(["get"]);
    expect(methods("/v1/vendor-payments/{paymentId}/void")).toEqual(["post"]);

    const schemas = Object.keys(res.body.components.schemas);
    expect(schemas).toEqual(
      expect.arrayContaining([
        "CreateBillInput",
        "BillLineInput",
        "VoidBillInput",
        "Bill",
        "BillLine",
        "BillSummary",
        "BillData",
        "BillListData",
        "CreateVendorPaymentInput",
        "VendorPaymentAllocationInput",
        "VoidVendorPaymentInput",
        "VendorPayment",
        "VendorPaymentSummary",
        "VendorPaymentData",
        "VendorPaymentListData",
      ])
    );
    const tags = res.body.tags.map((t: { name: string }) => t.name);
    expect(tags).toEqual(expect.arrayContaining(["Vendor Bills", "Vendor Payments"]));
  });

  it("documents billedQuantity on receipt lines", async () => {
    const res = await request.get("/api-docs.json");
    expect(res.body.components.schemas.GoodsReceiptLine.properties).toHaveProperty("billedQuantity");
  });
});
