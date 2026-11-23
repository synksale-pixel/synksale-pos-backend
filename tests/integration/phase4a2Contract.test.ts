/**
 * Purpose: Phase 4a-2 contract wiring that the validator unit tests cannot see: the customer
 * permissions' role seeding and sync, and the Swagger document.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { seedDefaultRolesForOrganization, syncSystemRolePermissions } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";

const KEYS = ["customer:read", "customer:create", "customer:manage"];
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
