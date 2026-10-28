/**
 * Purpose: Phase 3c goods receipt wiring that the validator unit tests cannot see: the
 * purchase:receive role seeding and sync, role scope rules for the new key, the contract-preview
 * routes and the Swagger document.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { seedDefaultRolesForOrganization, syncSystemRolePermissions } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { goodsReceiptExample } from "../../src/docs/goodsReceipt.openapi";

const GRNS = "/api/v1/goods-receipts";
const STORE_ID = "665f1c2e8a4b3c0012ab3400";
const STORE_GRNS = `/api/v1/stores/${STORE_ID}/goods-receipts`;
const ROLES = "/api/v1/roles";
const GRN_ID = "665f1c2e8a4b3c0012ab3d00";
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

describe("purchase:receive role seeding", () => {
  const permsOf = (slug: string) => ctx.role(slug).permissions as string[];

  it("seeds the key on org_admin, store_manager and inventory_clerk only", () => {
    for (const slug of ["org_admin", "store_manager", "inventory_clerk"]) {
      expect(permsOf(slug), slug).toContain("purchase:receive");
    }
    for (const slug of ["accountant", "cashier"]) {
      expect(permsOf(slug), slug).not.toContain("purchase:receive");
    }
  });

  it("the inventory clerk receives but does not order (cost changes and no-PO receipts need purchase:order)", () => {
    expect(permsOf("inventory_clerk")).not.toContain("purchase:order");
  });

  it("sync adds the key to an organization seeded before Phase 3c, once", async () => {
    const old = await setup("legacy");
    await Role.updateMany({ organizationId: old.org._id }, { $pull: { permissions: "purchase:receive" } });

    const results = await syncSystemRolePermissions(old.org._id);
    const added = (slug: string) => results.find((r) => r.slug === slug)?.added ?? [];
    expect(added("org_admin")).toEqual(["purchase:receive"]);
    expect(added("store_manager")).toEqual(["purchase:receive"]);
    expect(added("inventory_clerk")).toEqual(["purchase:receive"]);
    expect(results.map((r) => r.slug).sort()).toEqual(["inventory_clerk", "org_admin", "store_manager"]);
    expect(await syncSystemRolePermissions(old.org._id)).toEqual([]);
  });

  it("the permission catalog lists the key", async () => {
    const res = await request.get(`${ROLES}/permissions`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.data)).toContain("purchase:receive");
  });

  it("purchase:receive can go on a store-scoped custom role and on an organization role", async () => {
    const store = await request
      .post(ROLES)
      .set(auth(admin))
      .send({ name: "Receiver", scope: "store", permissions: ["purchase:read", "purchase:receive"] });
    expect(store.status).toBe(201);
    const org = await request
      .post(ROLES)
      .set(auth(admin))
      .send({ name: "Central receiving", scope: "organization", permissions: ["purchase:read", "purchase:receive"] });
    expect(org.status).toBe(201);
  });
});

describe("contract preview: goods receipt routes are not live yet", () => {
  it("every documented route returns 404", async () => {
    const calls = [
      request.get(GRNS),
      request.get(STORE_GRNS),
      request.post(STORE_GRNS).set("Idempotency-Key", "6c8e4f0e-2a7b-4d3c-9f51-0b2d7a1e9c44").send(goodsReceiptExample),
      request.get(`${STORE_GRNS}/${GRN_ID}`),
    ];
    for (const call of calls) {
      const res = await call.set(auth(admin));
      expect(res.status).toBe(404);
    }
  });
});

describe("OpenAPI document", () => {
  it("lists the Goods Receipts paths and the contract schemas", async () => {
    const res = await request.get("/api-docs.json");
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    const methods = (suffix: string) => {
      const path = paths.find((x) => x.endsWith(suffix));
      expect(path, suffix).toBeDefined();
      return Object.keys(res.body.paths[path!]).sort();
    };
    // Only the cross-store list is flat; everything that touches one receipt is under its store.
    expect(paths.filter((x) => /\/v\d+\/goods-receipts/.test(x))).toHaveLength(1);
    expect(methods("/v1/goods-receipts")).toEqual(["get"]);
    expect(methods("/stores/{storeId}/goods-receipts")).toEqual(["get", "post"]);
    // Receipts are final: no PATCH or DELETE.
    expect(methods("/stores/{storeId}/goods-receipts/{goodsReceiptId}")).toEqual(["get"]);
    const schemas = Object.keys(res.body.components.schemas);
    expect(schemas).toEqual(
      expect.arrayContaining([
        "CreateGoodsReceiptInput",
        "GoodsReceiptLineInput",
        "GoodsReceipt",
        "GoodsReceiptLine",
        "GoodsReceiptSummary",
        "GoodsReceiptListData",
        "GoodsReceiptData",
      ])
    );
    expect(res.body.tags.map((t: { name: string }) => t.name)).toContain("Goods Receipts");
  });

  it("documents the variant's lastPurchase and the purchase movement type", async () => {
    const res = await request.get("/api-docs.json");
    const schemas = res.body.components.schemas;
    expect(schemas.ProductVariant.properties).toHaveProperty("lastPurchase");
    expect(JSON.stringify(schemas.StockMovement)).toContain("goods_receipt");
  });
});
