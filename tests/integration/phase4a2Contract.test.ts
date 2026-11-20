/**
 * Purpose: Phase 4a-2 contract wiring that the validator unit tests cannot see: the customer
 * permissions' role seeding and sync, the contract-preview routes (404 until implemented) and the
 * Swagger document.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { seedDefaultRolesForOrganization, syncSystemRolePermissions } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { customerExample, importCustomersExample } from "../../src/docs/customer.openapi";
import { registerExample } from "../../src/docs/register.openapi";

const KEYS = ["customer:read", "customer:create", "customer:manage"];
const CUSTOMER_ID = "665f1c2e8a4b3c0012ab4300";
const REGISTER_ID = "665f1c2e8a4b3c0012ab4200";
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

describe("customer permissions", () => {
  const permsOf = (slug: string) => ctx.role(slug).permissions as string[];

  it("seeds them per role: cashiers look up and add, managers also edit/import/delete", () => {
    for (const key of KEYS) {
      expect(permsOf("org_admin"), key).toContain(key);
      expect(permsOf("store_manager"), key).toContain(key);
    }
    expect(permsOf("cashier")).toEqual(expect.arrayContaining(["customer:read", "customer:create"]));
    expect(permsOf("cashier")).not.toContain("customer:manage");
    expect(permsOf("accountant")).toContain("customer:read");
    expect(permsOf("accountant")).not.toContain("customer:create");
    for (const key of KEYS) expect(permsOf("inventory_clerk"), key).not.toContain(key);
  });

  it("the cashier template does not gain sale:refund (20-Nov decision: refunds stay manager-only)", () => {
    expect(permsOf("cashier")).not.toContain("sale:refund");
  });

  it("sync adds them to an organization seeded before 4a-2, once", async () => {
    const old = await setup("legacy");
    await Role.updateMany({ organizationId: old.org._id }, { $pull: { permissions: { $in: KEYS } } });

    const results = await syncSystemRolePermissions(old.org._id);
    const added = Object.fromEntries(results.map((r) => [r.slug, [...r.added].sort()]));
    expect(added).toEqual({
      org_admin: [...KEYS].sort(),
      store_manager: [...KEYS].sort(),
      cashier: ["customer:create", "customer:read"],
      accountant: ["customer:read"],
    });
    expect(await syncSystemRolePermissions(old.org._id)).toEqual([]);
  });

  it("the permission catalog lists them and a store-scoped custom role can hold them", async () => {
    const catalog = await request.get("/api/v1/roles/permissions").set(auth(admin));
    expect(catalog.status).toBe(200);
    for (const key of KEYS) expect(JSON.stringify(catalog.body.data)).toContain(key);

    const res = await request.post("/api/v1/roles").set(auth(admin)).send({ name: "Front desk", scope: "store", permissions: KEYS });
    expect(res.status).toBe(201);
  });
});

describe("contract preview routes", () => {
  it("answer the router's 404 until implemented", async () => {
    const store = await request
      .post("/api/v1/stores")
      .set(auth(admin))
      .send({
        name: "Seef",
        code: "SEEF-1",
        address: { line1: "Road 2", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "324" },
        countryCode: "BH",
        timezone: "Asia/Bahrain",
      });
    expect(store.status, JSON.stringify(store.body)).toBe(201);
    const storeId = store.body.data.store._id;

    const calls = [
      request.get(`/api/v1/stores/${storeId}/registers`),
      request.post(`/api/v1/stores/${storeId}/registers`).send(registerExample),
      request.get(`/api/v1/stores/${storeId}/registers/${REGISTER_ID}`),
      request.patch(`/api/v1/stores/${storeId}/registers/${REGISTER_ID}`).send(registerExample),
      request.delete(`/api/v1/stores/${storeId}/registers/${REGISTER_ID}`),
      request.get(`/api/v1/stores/${storeId}/till/lookup?code=6291041500213`),
      request.get(`/api/v1/stores/${storeId}/till/items`),
      request.get("/api/v1/customers"),
      request.get("/api/v1/customers/lookup?phone=3600"),
      request.get(`/api/v1/customers/${CUSTOMER_ID}`),
      request.post("/api/v1/customers").send(customerExample),
      request.post("/api/v1/customers/import").send(importCustomersExample),
      request.patch(`/api/v1/customers/${CUSTOMER_ID}`).send({ name: "X" }),
      request.delete(`/api/v1/customers/${CUSTOMER_ID}`),
    ];
    for (const call of calls) {
      const res = await call.set(auth(admin));
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.code).toBeUndefined();
      expect(res.body.message).not.toBe("Store not found.");
    }
  });
});

describe("OpenAPI document", () => {
  it("lists the register, customer and till paths and the contract schemas", async () => {
    const res = await request.get("/api-docs.json");
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    const methods = (suffix: string) => {
      const path = paths.find((x) => x.endsWith(suffix));
      expect(path, suffix).toBeDefined();
      return Object.keys(res.body.paths[path!]).sort();
    };
    expect(methods("/stores/{storeId}/registers")).toEqual(["get", "post"]);
    expect(methods("/stores/{storeId}/registers/{registerId}")).toEqual(["delete", "get", "patch"]);
    expect(methods("/v1/customers")).toEqual(["get", "post"]);
    expect(methods("/v1/customers/lookup")).toEqual(["get"]);
    expect(methods("/v1/customers/import")).toEqual(["post"]);
    expect(methods("/v1/customers/{customerId}")).toEqual(["delete", "get", "patch"]);
    expect(methods("/stores/{storeId}/till/lookup")).toEqual(["get"]);
    expect(methods("/stores/{storeId}/till/items")).toEqual(["get"]);
    // Customers are organization-wide: nothing under /stores.
    expect(paths.filter((x) => /\/stores\/.*\/customers/.test(x))).toEqual([]);

    expect(Object.keys(res.body.components.schemas)).toEqual(
      expect.arrayContaining([
        "CreateRegisterInput",
        "UpdateRegisterInput",
        "Register",
        "RegisterData",
        "RegisterListData",
        "CreateCustomerInput",
        "UpdateCustomerInput",
        "CustomerAddressInput",
        "ImportCustomersInput",
        "Customer",
        "CustomerData",
        "CustomerListData",
        "CustomerLookupData",
        "CustomerImportResult",
        "CustomerImportData",
        "TillItem",
        "TillLookupData",
        "TillItemListData",
      ])
    );
    const tags = res.body.tags.map((t: { name: string }) => t.name);
    expect(tags).toEqual(expect.arrayContaining(["Registers", "Customers", "Till"]));
  });

  it("till items never carry a cost", async () => {
    const res = await request.get("/api-docs.json");
    const props = Object.keys(res.body.components.schemas.TillItem.properties);
    expect(props.filter((p) => /cost/i.test(p))).toEqual([]);
  });
});
