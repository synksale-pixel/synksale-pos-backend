/**
 * Purpose: Phase 3b purchase order wiring that the validator unit tests cannot see: the
 * purchase:order role seeding and sync, role scope rules for the new key, the contract-preview
 * routes and the Swagger document.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { seedDefaultRolesForOrganization, syncSystemRolePermissions } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { purchaseOrderExample } from "../../src/docs/purchaseOrder.openapi";

const POS = "/api/v1/purchase-orders";
const STORE_ID = "665f1c2e8a4b3c0012ab3400";
const STORE_POS = `/api/v1/stores/${STORE_ID}/purchase-orders`;
const ROLES = "/api/v1/roles";
const PO_ID = "665f1c2e8a4b3c0012ab3c00";
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

describe("purchase:order role seeding", () => {
  const permsOf = (slug: string) => ctx.role(slug).permissions as string[];

  it("seeds the key on org_admin and store_manager only", () => {
    expect(permsOf("org_admin")).toContain("purchase:order");
    expect(permsOf("store_manager")).toContain("purchase:order");
    for (const slug of ["accountant", "inventory_clerk", "cashier"]) {
      expect(permsOf(slug), slug).not.toContain("purchase:order");
    }
  });

  it("sync adds the key to an organization seeded before Phase 3b, once", async () => {
    const old = await setup("legacy");
    await Role.updateMany({ organizationId: old.org._id }, { $pull: { permissions: "purchase:order" } });

    const results = await syncSystemRolePermissions(old.org._id);
    const added = (slug: string) => results.find((r) => r.slug === slug)?.added ?? [];
    expect(added("org_admin")).toEqual(["purchase:order"]);
    expect(added("store_manager")).toEqual(["purchase:order"]);
    expect(results.map((r) => r.slug).sort()).toEqual(["org_admin", "store_manager"]);
    expect(await syncSystemRolePermissions(old.org._id)).toEqual([]);
  });

  it("the permission catalog lists the key", async () => {
    const res = await request.get(`${ROLES}/permissions`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.data)).toContain("purchase:order");
  });

  it("purchase:order can go on a store-scoped custom role and on an organization role", async () => {
    const store = await request
      .post(ROLES)
      .set(auth(admin))
      .send({ name: "Store buyer", scope: "store", permissions: ["purchase:read", "purchase:order"] });
    expect(store.status).toBe(201);
    const org = await request
      .post(ROLES)
      .set(auth(admin))
      .send({ name: "Head buyer", scope: "organization", permissions: ["purchase:read", "purchase:order"] });
    expect(org.status).toBe(201);
  });
});

describe("purchase order routes are live (behaviour in purchaseOrders.test.ts)", () => {
  it("the cross-store list answers with an empty page", async () => {
    const res = await request.get(POS).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.purchaseOrders).toEqual([]);
  });

  it("every store route checks the store first: an unknown store is 404 Store not found", async () => {
    const calls = [
      request.get(STORE_POS),
      request.post(STORE_POS).set("Idempotency-Key", "6c8e4f0e-2a7b-4d3c-9f51-0b2d7a1e9c44").send(purchaseOrderExample),
      request.get(`${STORE_POS}/${PO_ID}`),
      request.patch(`${STORE_POS}/${PO_ID}`).send({ version: 1, notes: "x" }),
      request.delete(`${STORE_POS}/${PO_ID}?version=1`),
      request.post(`${STORE_POS}/${PO_ID}/issue`).send({ version: 1 }),
      request.post(`${STORE_POS}/${PO_ID}/cancel`).send({ version: 1 }),
      request.post(`${STORE_POS}/${PO_ID}/close`).send({ version: 1 }),
    ];
    for (const call of calls) {
      const res = await call.set(auth(admin));
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Store not found.");
    }
  });
});

describe("OpenAPI document", () => {
  it("lists the Purchase Orders paths and the contract schemas", async () => {
    const res = await request.get("/api-docs.json");
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    const methods = (suffix: string) => {
      const path = paths.find((x) => x.endsWith(suffix));
      expect(path, suffix).toBeDefined();
      return Object.keys(res.body.paths[path!]).sort();
    };
    // Only the cross-store list is flat; everything that touches one PO is under its store.
    expect(paths.filter((x) => /\/v\d+\/purchase-orders/.test(x))).toHaveLength(1);
    expect(methods("/v1/purchase-orders")).toEqual(["get"]);
    expect(methods("/stores/{storeId}/purchase-orders")).toEqual(["get", "post"]);
    expect(methods("/stores/{storeId}/purchase-orders/{purchaseOrderId}")).toEqual(["delete", "get", "patch"]);
    for (const action of ["issue", "cancel", "close"]) {
      expect(methods(`/stores/{storeId}/purchase-orders/{purchaseOrderId}/${action}`), action).toEqual(["post"]);
    }
    const schemas = Object.keys(res.body.components.schemas);
    expect(schemas).toEqual(
      expect.arrayContaining([
        "CreatePurchaseOrderInput",
        "UpdatePurchaseOrderInput",
        "PurchaseOrderLineInput",
        "PurchaseOrder",
        "PurchaseOrderLine",
        "PurchaseOrderSummary",
        "PurchaseOrderListData",
      ])
    );
    expect(res.body.tags.map((t: { name: string }) => t.name)).toContain("Purchase Orders");
  });
});
