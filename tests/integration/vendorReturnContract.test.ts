/**
 * Purpose: Phase 3e vendor return and debit note wiring that the validator unit tests cannot see:
 * the purchase:return role seeding and sync, its scope rules, that the routes are mounted
 * and the Swagger document.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { seedDefaultRolesForOrganization, syncSystemRolePermissions } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";
import {
  applyDebitNoteExample,
  debitNoteExample,
  vendorReturnExample,
  voidDebitNoteExample,
} from "../../src/docs/vendorReturn.openapi";

const ROLES = "/api/v1/roles";
const STORE_ID = "665f1c2e8a4b3c0012ab3400";
const RETURN_ID = "665f1c2e8a4b3c0012ab4000";
const NOTE_ID = "665f1c2e8a4b3c0012ab4100";
const KEY = "purchase:return";
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

describe("purchase:return role seeding", () => {
  const permsOf = (slug: string) => ctx.role(slug).permissions as string[];

  it("seeds the key on org_admin and store_manager only", () => {
    for (const slug of ["org_admin", "store_manager"]) expect(permsOf(slug), slug).toContain(KEY);
    for (const slug of ["inventory_clerk", "cashier", "accountant"]) expect(permsOf(slug), slug).not.toContain(KEY);
  });

  it("sync adds the key to an organization seeded before Phase 3e, once", async () => {
    const old = await setup("legacy");
    await Role.updateMany({ organizationId: old.org._id }, { $pull: { permissions: KEY } });

    const results = await syncSystemRolePermissions(old.org._id);
    expect(results.map((r) => r.slug).sort()).toEqual(["org_admin", "store_manager"]);
    for (const r of results) expect([...r.added]).toEqual([KEY]);
    expect(await syncSystemRolePermissions(old.org._id)).toEqual([]);
  });

  it("the permission catalog lists the key", async () => {
    const res = await request.get(`${ROLES}/permissions`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.data)).toContain(KEY);
  });

  it("a store-scoped custom role can hold it (e.g. clerks who return goods)", async () => {
    const res = await request
      .post(ROLES)
      .set(auth(admin))
      .send({ name: "Returns clerk", scope: "store", permissions: ["purchase:read", "inventory:read", KEY] });
    expect(res.status).toBe(201);
  });
});

describe("return and debit note routes are live", () => {
  it("no documented route returns the router's 404 (only the documented not-found codes)", async () => {
    const key = "6c8e4f0e-2a7b-4d3c-9f51-0b2d7a1e9c44";
    const calls = [
      request.get("/api/v1/vendor-returns"),
      request.get(`/api/v1/stores/${STORE_ID}/vendor-returns`),
      request.get(`/api/v1/stores/${STORE_ID}/vendor-returns/${RETURN_ID}`),
      request.post(`/api/v1/stores/${STORE_ID}/vendor-returns`).set("Idempotency-Key", key).send(vendorReturnExample),
      request.get("/api/v1/debit-notes"),
      request.get(`/api/v1/debit-notes/${NOTE_ID}`),
      request.post("/api/v1/debit-notes").set("Idempotency-Key", key).send(debitNoteExample),
      request.post(`/api/v1/debit-notes/${NOTE_ID}/apply`).set("Idempotency-Key", key).send(applyDebitNoteExample),
      request.post(`/api/v1/debit-notes/${NOTE_ID}/void`).set("Idempotency-Key", key).send(voidDebitNoteExample),
    ];
    for (const call of calls) {
      const res = await call.set(auth(admin));
      // The examples name ids that do not exist here: a coded answer (or the store's), never the router's.
      if (res.status === 404) {
        const known = /^(VENDOR_RETURN|DEBIT_NOTE|BILL|GOODS_RECEIPT)_NOT_FOUND$/.test(res.body.code ?? "") || res.body.message === "Store not found.";
        expect(known, JSON.stringify(res.body)).toBe(true);
      } else {
        expect([200, 400, 403, 409]).toContain(res.status);
      }
    }
  });
});

describe("OpenAPI document", () => {
  it("lists the return and debit note paths and the contract schemas", async () => {
    const res = await request.get("/api-docs.json");
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    const methods = (suffix: string) => {
      const path = paths.find((x) => x.endsWith(suffix));
      expect(path, suffix).toBeDefined();
      return Object.keys(res.body.paths[path!]).sort();
    };
    expect(methods("/v1/vendor-returns")).toEqual(["get"]);
    expect(methods("/stores/{storeId}/vendor-returns")).toEqual(["get", "post"]);
    // Returns are final: no edit, delete or void.
    expect(methods("/stores/{storeId}/vendor-returns/{vendorReturnId}")).toEqual(["get"]);
    expect(paths.filter((x) => x.includes("/vendor-returns/{vendorReturnId}/"))).toEqual([]);
    // Debit notes are organization-level: nothing under /stores.
    expect(paths.filter((x) => /\/stores\/.*\/debit-notes/.test(x))).toEqual([]);
    expect(methods("/v1/debit-notes")).toEqual(["get", "post"]);
    expect(methods("/v1/debit-notes/{debitNoteId}")).toEqual(["get"]);
    expect(methods("/v1/debit-notes/{debitNoteId}/apply")).toEqual(["post"]);
    expect(methods("/v1/debit-notes/{debitNoteId}/void")).toEqual(["post"]);

    const schemas = res.body.components.schemas;
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        "CreateVendorReturnInput",
        "VendorReturnLineInput",
        "VendorReturn",
        "VendorReturnLine",
        "VendorReturnSummary",
        "VendorReturnData",
        "VendorReturnListData",
        "CreateDebitNoteInput",
        "DebitNoteLineInput",
        "ApplyDebitNoteInput",
        "DebitNoteApplicationInput",
        "VoidDebitNoteInput",
        "DebitNote",
        "DebitNoteLine",
        "DebitNoteApplication",
        "DebitNoteSummary",
        "DebitNoteData",
        "DebitNoteListData",
      ])
    );
    const tags = res.body.tags.map((t: { name: string }) => t.name);
    expect(tags).toEqual(expect.arrayContaining(["Vendor Returns", "Debit Notes"]));
  });

  it("documents the new receipt and bill fields as always present", async () => {
    const res = await request.get("/api-docs.json");
    const { GoodsReceiptLine, Bill, BillSummary, BillLine } = res.body.components.schemas;
    expect(GoodsReceiptLine.properties).toHaveProperty("returnedQuantity");
    expect(GoodsReceiptLine.properties).toHaveProperty("billableQuantity");
    expect(Bill.properties).toHaveProperty("credited");
    expect(Bill.properties).toHaveProperty("debitNotes");
    expect(BillSummary.properties).toHaveProperty("credited");
    expect(BillLine.properties).toHaveProperty("credited");
    for (const [schema, field] of [
      [GoodsReceiptLine, "returnedQuantity"],
      [Bill, "credited"],
      [BillLine, "returnedQuantity"],
      [GoodsReceiptLine, "billableQuantity"],
      [BillSummary, "credited"],
      [Bill, "debitNotes"],
      [BillLine, "credited"],
    ] as const) {
      expect(schema.required ?? [], field).toContain(field);
    }
  });
});
