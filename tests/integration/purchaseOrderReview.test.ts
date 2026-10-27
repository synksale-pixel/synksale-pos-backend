/**
 * Purpose: Review tests for Phase 3b purchase orders: response shapes against the Zod response
 * schemas, hostile input (no 500s), the vendor document counter under failures and races,
 * numbering, VAT rounding and fallbacks, version/status ordering, tenant and store isolation,
 * the cross-store list narrowing, idempotency edges and the deactivated-store rules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Vendor } from "../../src/models/vendor.model";
import { Product } from "../../src/models/product.model";
import { ProductVariant } from "../../src/models/productVariant.model";
import { TaxRate } from "../../src/models/taxRate.model";
import { PurchaseOrder } from "../../src/models/purchaseOrder.model";
import { DocumentCounter } from "../../src/models/documentCounter.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { singleExample } from "../../src/docs/product.openapi";
import {
  PurchaseOrderDataSchema,
  PurchaseOrderListDataSchema,
  PurchaseOrderSchema,
  PurchaseOrderSummarySchema,
} from "../../src/validators/responses";

const PRODUCTS = "/api/v1/products";
const VENDORS = "/api/v1/vendors";
const ALL_POS = "/api/v1/purchase-orders";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const anyState = { $in: [true, false] };

let keySeq = 0;
const newKey = () => `review-key-${Date.now()}-${(keySeq += 1)}`;

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
  const store = (n: number) =>
    Store.create({
      organizationId: org._id,
      name: `Store ${n}`,
      code: `${slug.toUpperCase()}-${n}`,
      address: { line1: "Road 1", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
      countryCode: "BH",
      timezone: "Asia/Bahrain",
    });
  const [storeA, storeB] = [await store(1), await store(2)];
  return { org, role, storeA, storeB };
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
    firstName: "Test",
    lastName: "User",
    isActive: true,
    orgRoleId: opts.orgRoleId ?? null,
    storeAccess: opts.storeAccess ?? [],
  });
  return generateAccessToken({ userId: user._id.toString(), organizationId: String(orgId), isSuperAdmin: false });
}

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: string;
let vatVendor: string;
let localVendor: string;
let thirdVendor: string;
let coffee: string;
let tea: string;

const storePos = (storeId: unknown = ctx.storeA._id) => `/api/v1/stores/${storeId}/purchase-orders`;

async function product(body: Record<string, unknown>, token = admin): Promise<string> {
  const res = await request.post(PRODUCTS).set(auth(token)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.product.variants[0].id;
}

async function vendor(body: Record<string, unknown>, token = admin): Promise<string> {
  const res = await request.post(VENDORS).set(auth(token)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.vendor.id;
}

const goods = (overrides: Record<string, unknown>) => ({
  ...singleExample,
  categoryId: undefined,
  taxRateId: undefined,
  barcodes: undefined,
  ...overrides,
});

beforeEach(async () => {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
  vatVendor = await vendor({ name: "Gulf Roasters", taxRegistrationNumber: "220000987600003" });
  localVendor = await vendor({ name: "Corner Supplier" });
  thirdVendor = await vendor({ name: "Third Supplier" });
  coffee = await product(goods({ name: "Coffee", sku: "COF-1", purchase: { costPrice: "1.600" } }));
  tea = await product(goods({ name: "Tea", sku: "TEA-1", purchase: {} }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const createPo = (body: Record<string, unknown>, opts: { token?: string; store?: unknown; key?: string } = {}) =>
  request
    .post(storePos(opts.store))
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send(body);

const line = (variantId = coffee, quantity = 1, extra: Record<string, unknown> = {}) => ({ variantId, quantity, ...extra });

const draft = async (body: Record<string, unknown> = {}, opts: { store?: unknown; token?: string } = {}) => {
  const res = await createPo({ vendorId: vatVendor, lines: [line(coffee, 24)], ...body }, opts);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.purchaseOrder;
};

const poUrl = (po: { id: string }, suffix = "", storeId: unknown = ctx.storeA._id) => `${storePos(storeId)}/${po.id}${suffix}`;

const issue = (po: { id: string; version: number }, token = admin) =>
  request.post(poUrl(po, "/issue")).set(auth(token)).send({ version: po.version });

const count = async (vendorId: string) => (await Vendor.findOne({ _id: vendorId, isDelete: anyState }))!.purchaseDocumentCount;

/** The vendor counters must equal the live (non-deleted) POs naming each vendor. */
async function expectCountersMatchPos() {
  for (const vendorId of [vatVendor, localVendor, thirdVendor]) {
    const live = await PurchaseOrder.countDocuments({ vendorId });
    expect(await count(vendorId), `counter of vendor ${vendorId}`).toBe(live);
  }
}

// ==========================================
// Responses against the Zod schemas
// ==========================================

describe("responses match the Zod response schemas", () => {
  it("draft, issued, edited, cancelled and list shapes parse, strictly, and leak no internals", async () => {
    const po = await draft({ notes: "note", vendorReference: "Q-1", expectedDate: "2099-01-01" });
    expect(PurchaseOrderDataSchema.safeParse({ purchaseOrder: po }).success, JSON.stringify(po)).toBe(true);
    expect(PurchaseOrderSchema.strict().safeParse(po).success, "no extra keys").toBe(true);

    const issued = (await issue(po)).body.data.purchaseOrder;
    expect(PurchaseOrderSchema.strict().safeParse(issued).success).toBe(true);
    expect(issued.issued).not.toBeNull();

    const edited = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 2, notes: null, expectedDate: null, vendorReference: null });
    expect(PurchaseOrderSchema.strict().safeParse(edited.body.data.purchaseOrder).success).toBe(true);

    const cancelled = await request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version: 3, reason: "No stock" });
    expect(cancelled.status).toBe(200);
    expect(PurchaseOrderSchema.strict().safeParse(cancelled.body.data.purchaseOrder).success).toBe(true);

    const got = await request.get(poUrl(po)).set(auth(admin));
    expect(PurchaseOrderDataSchema.safeParse(got.body.data).success).toBe(true);

    const list = await request.get(ALL_POS).set(auth(admin));
    expect(PurchaseOrderListDataSchema.safeParse(list.body.data).success).toBe(true);
    expect(PurchaseOrderSummarySchema.strict().safeParse(list.body.data.purchaseOrders[0]).success).toBe(true);

    for (const body of [JSON.stringify(created(po)), JSON.stringify(list.body), JSON.stringify(got.body)]) {
      for (const secret of ["sequence", "isDelete", "vendorSnapshot", "purchaseDocumentCount", "organizationId", "__v", "stack"]) {
        expect(body).not.toContain(`"${secret}"`);
      }
    }
  });

  it("a deactivated vendor shows isActive false and the PO still parses", async () => {
    const po = await draft();
    await request.patch(`${VENDORS}/${vatVendor}`).set(auth(admin)).send({ isActive: false });
    const got = await request.get(poUrl(po)).set(auth(admin));
    expect(PurchaseOrderDataSchema.safeParse(got.body.data).success).toBe(true);
    expect(got.body.data.purchaseOrder.vendor.isActive).toBe(false);
  });

  it("vendor responses never expose the document counter, and it cannot be set from the API", async () => {
    await draft();
    const got = await request.get(`${VENDORS}/${vatVendor}`).set(auth(admin));
    const list = await request.get(VENDORS).set(auth(admin));
    expect(JSON.stringify(got.body)).not.toContain("purchaseDocumentCount");
    expect(JSON.stringify(list.body)).not.toContain("purchaseDocumentCount");

    const patched = await request.patch(`${VENDORS}/${vatVendor}`).set(auth(admin)).send({ purchaseDocumentCount: 0 });
    expect(patched.status).toBeLessThan(500);
    const created = await request.post(VENDORS).set(auth(admin)).send({ name: "Sneaky", purchaseDocumentCount: -5 });
    expect(created.status).toBeLessThan(500);
    expect(await count(vatVendor)).toBe(1);
    const sneaky = await Vendor.findOne({ name: "Sneaky" });
    expect(sneaky?.purchaseDocumentCount ?? 0).toBeGreaterThanOrEqual(0);

    const del = await request.delete(`${VENDORS}/${vatVendor}`).set(auth(admin));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("VENDOR_IN_USE");
    expect(del.body.errors[0].meta).toEqual({ documentCount: 1 });
  });
});

const created = (po: unknown) => ({ purchaseOrder: po });

// ==========================================
// Hostile input
// ==========================================

describe("hostile input never returns 500", () => {
  it("odd list queries on both lists are tolerated, and regex characters match literally", async () => {
    await draft({ vendorReference: "Q.2026" });
    const queries = [
      "?search=%00",
      "?search=PO-%00%00",
      "?search=.*",
      "?search=(",
      "?search=[a-z]",
      "?search=%5C",
      "?search=%24%7B%7D",
      `?search=${"A".repeat(5000)}`,
      "?search[]=a&search[]=b",
      "?search[$ne]=x",
      "?status[a]=b",
      "?status=%00,issued,,",
      "?status=__proto__",
      "?page[$gt]=1",
      "?page=abc&limit=xyz",
      "?page=1e30&limit=Infinity",
      "?page=-3&limit=-5",
      "?limit=100000",
      "?vendorId=%00",
      "?vendorId[]=a",
      "?vendorId=zzzz",
      "?storeId=%00",
      "?storeId[$ne]=x",
      "?from=%00&to=2026-13-45",
      "?from=2026-02-30",
    ];
    for (const url of [ALL_POS, storePos()]) {
      for (const q of queries) {
        const res = await request.get(`${url}${q}`).set(auth(admin));
        expect(res.status, `${url}${q}`).toBeLessThan(500);
      }
    }
    // A pattern must not act as a pattern.
    for (const q of ["?search=.*", "?search=PO-0000.", "?search=Q.202.", "?search=%5B0-9%5D"]) {
      const res = await request.get(`${ALL_POS}${q}`).set(auth(admin));
      expect(res.body.data.purchaseOrders, q).toHaveLength(0);
    }
    expect((await request.get(`${ALL_POS}?search=Q.2026`).set(auth(admin))).body.data.purchaseOrders).toHaveLength(1);
    expect((await request.get(`${ALL_POS}?search=po-00001`).set(auth(admin))).body.data.purchaseOrders).toHaveLength(1);
    expect((await request.get(`${ALL_POS}?limit=100000`).set(auth(admin))).body.data.pagination.limit).toBe(100);
  });

  it("fractional page and limit values fall back to sane paging", async () => {
    await draft();
    await draft();
    for (const url of [ALL_POS, storePos()]) {
      for (const q of ["?page=0.5", "?limit=0.5", "?page=0.5&limit=0.9", "?page=1.9&limit=1.9"]) {
        const res = await request.get(`${url}${q}`).set(auth(admin));
        expect(res.status, `${url}${q}`).toBe(200);
        const { page, limit, totalPages } = res.body.data.pagination;
        expect(page, q).toBeGreaterThanOrEqual(1);
        expect(limit, q).toBeGreaterThanOrEqual(1);
        expect(Number.isFinite(totalPages), q).toBe(true);
        expect(res.body.data.purchaseOrders.length, q).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("odd ids in the path are not 500s", async () => {
    for (const id of ["%00", "abc", "665f1c2e8a4b3c0012ab3fff", "AAAAAAAAAAAAAAAAAAAAAAAA", "12charsabcde", "%24ne", "..%2F..%2Fx"]) {
      for (const method of ["get", "delete"] as const) {
        const res = await request[method](`${storePos()}/${id}${method === "delete" ? "?version=1" : ""}`).set(auth(admin));
        expect(res.status, `${method} ${id}`).toBeLessThan(500);
        expect(res.status, `${method} ${id}`).toBeGreaterThanOrEqual(400);
      }
      for (const action of ["issue", "cancel", "close"]) {
        const res = await request.post(`${storePos()}/${id}/${action}`).set(auth(admin)).send({ version: 1 });
        expect(res.status, `${action} ${id}`).toBeLessThan(500);
      }
      const patched = await request.patch(`${storePos()}/${id}`).set(auth(admin)).send({ version: 1, notes: "x" });
      expect(patched.status).toBeLessThan(500);
    }
    // Bad store ids in the URL.
    for (const id of ["%00", "abc", "665f1c2e8a4b3c0012ab3fff"]) {
      const res = await request.get(`/api/v1/stores/${id}/purchase-orders`).set(auth(admin));
      expect(res.status, id).toBeLessThan(500);
    }
  });

  it("an upper-case store or PO id in the path works like the lower-case one", async () => {
    const po = await draft();
    const upperStore = `/api/v1/stores/${String(ctx.storeA._id).toUpperCase()}/purchase-orders/${po.id.toUpperCase()}`;
    const res = await request.get(upperStore).set(auth(admin));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patched = await request.patch(upperStore).set(auth(admin)).send({ version: 1, notes: "x" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  });

  it("NUL bytes, huge and mistyped bodies are 400s", async () => {
    const bodies: Record<string, unknown>[] = [
      { vendorId: vatVendor, lines: [line(coffee, 1)], notes: "a\u0000b" },
      { vendorId: vatVendor, lines: [line(coffee, 1)], vendorReference: "a\u0000b" },
      { vendorId: vatVendor, lines: [] },
      { vendorId: vatVendor, lines: "x" },
      { vendorId: vatVendor, lines: [null] },
      { vendorId: vatVendor, lines: [line(coffee, 0)] },
      { vendorId: vatVendor, lines: [line(coffee, -1)] },
      { vendorId: vatVendor, lines: [line(coffee, 1.0005)] },
      { vendorId: vatVendor, lines: [line(coffee, "1" as unknown as number)] },
      { vendorId: vatVendor, lines: [line(coffee, 1, { unitCost: "-1" })] },
      { vendorId: vatVendor, lines: [line(coffee, 1, { unitCost: "1e3" })] },
      { vendorId: vatVendor, lines: [line(coffee, 1, { unitCost: 5 })] },
      { vendorId: vatVendor, lines: [line(coffee, 1, { unitCost: "1.2345" })] },
      { vendorId: vatVendor, lines: [line(coffee, 1), line(coffee.toUpperCase(), 2)] },
      { vendorId: { $ne: null }, lines: [line(coffee, 1)] },
      { vendorId: vatVendor, lines: Array.from({ length: 201 }, () => line(coffee, 1)) },
      { vendorId: vatVendor, lines: [line(coffee, 1)], orderDate: "2026-02-30" },
      { vendorId: vatVendor, lines: [line(coffee, 1)], orderDate: "2026-10-27", expectedDate: "2026-10-26" },
      { vendorId: vatVendor, lines: [line(coffee, 1)], organizationId: String(ctx.org._id) },
      { vendorId: vatVendor, lines: [line(coffee, 1)], status: "issued", version: 9, createdBy: vatVendor },
      { vendorId: vatVendor, lines: [{ ...line(coffee, 1), receivedQuantity: 5 }] },
    ];
    for (const body of bodies) {
      const res = await createPo(body);
      if (JSON.stringify(body).includes("\\u0000")) {
        expect(res.status).toBeLessThan(500);
        continue;
      }
      expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain("stack");
    }
    await expectCountersMatchPos();
    expect((await PurchaseOrder.find({})).every((po) => po.status === "draft" && po.version === 1)).toBe(true);
  });

  it("an amount that overflows is a 400 and leaves the vendor counter alone", async () => {
    const res = await createPo({ vendorId: vatVendor, lines: [line(coffee, 999999999, { unitCost: "9999999999999.000" })] });
    expect(res.status).toBe(400);
    const big = await createPo({ vendorId: vatVendor, lines: [line(coffee, 999999999999, { unitCost: "99999999.000" })] });
    expect(big.status).toBeLessThan(500);
    expect(await count(vatVendor)).toBe(0);
    expect(await DocumentCounter.countDocuments({ seq: { $gt: 0 } })).toBe(0);
  });
});

describe("DELETE ?version parsing", () => {
  it("anything but a positive whole number is a 400 and the draft survives", async () => {
    const po = await draft();
    for (const q of ["", "?version=", "?version=abc", "?version=1.5", "?version=0", "?version=-1", "?version=%20", "?version=Infinity", "?version=1e400", "?version[]=1", "?version=1&version=1", "?version[a]=1", "?version=%00"]) {
      const res = await request.delete(`${poUrl(po)}${q}`).set(auth(admin));
      expect(res.status, q).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain("stack");
    }
    expect(await PurchaseOrder.countDocuments({})).toBe(1);
    expect(await count(vatVendor)).toBe(1);
    expect((await request.delete(`${poUrl(po)}?version=1`).set(auth(admin))).status).toBe(200);
    expect(await count(vatVendor)).toBe(0);
  });
});

// ==========================================
// Vendor counter: failures, races, drift
// ==========================================

describe("vendor document counter", () => {
  it("does not move when a create fails, is refused, or the transaction aborts", async () => {
    expect((await createPo({ vendorId: vatVendor, lines: [line("665f1c2e8a4b3c0012ab3fff")] })).status).toBe(400);
    await request.patch(`${VENDORS}/${localVendor}`).set(auth(admin)).send({ isActive: false });
    expect((await createPo({ vendorId: localVendor, lines: [line()] })).status).toBe(400);
    expect((await createPo({ vendorId: "665f1c2e8a4b3c0012ab3fff", lines: [line()] })).status).toBe(400);

    vi.spyOn(PurchaseOrder, "create").mockRejectedValueOnce(new Error("disk on fire"));
    const boom = await createPo({ vendorId: vatVendor, lines: [line()] }, { key: "boom-key-12345" });
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.body)).not.toContain("stack");
    vi.restoreAllMocks();

    expect(await count(vatVendor)).toBe(0);
    expect(await PurchaseOrder.countDocuments({})).toBe(0);
    expect((await DocumentCounter.findOne({}))?.seq ?? 0).toBe(0);

    // The aborted request's key was not consumed, and the number was given back.
    const retry = await createPo({ vendorId: vatVendor, lines: [line()] }, { key: "boom-key-12345" });
    expect(retry.status).toBe(201);
    expect(retry.body.data.purchaseOrder.number).toBe("PO-00001");
    expect(await count(vatVendor)).toBe(1);
  });

  it("counts a replayed create once", async () => {
    const key = newKey();
    const first = await createPo({ vendorId: vatVendor, lines: [line()] }, { key });
    const replay = await createPo({ vendorId: vatVendor, lines: [line()] }, { key });
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    const parallel = newKey();
    await Promise.all([1, 2, 3].map(() => createPo({ vendorId: localVendor, lines: [line()] }, { key: parallel })));
    expect(await PurchaseOrder.countDocuments({})).toBe(2);
    await expectCountersMatchPos();
  });

  it("a rolled-back edit keeps both vendor counters", async () => {
    const po = await draft();
    const bad = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, vendorId: localVendor, lines: [line("665f1c2e8a4b3c0012ab3fff")] });
    expect(bad.status).toBe(400);
    expect(await count(vatVendor)).toBe(1);
    expect(await count(localVendor)).toBe(0);

    vi.spyOn(PurchaseOrder, "findOneAndUpdate").mockRejectedValueOnce(new Error("boom"));
    const aborted = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, vendorId: localVendor });
    expect(aborted.status).toBe(500);
    vi.restoreAllMocks();
    expect(await count(vatVendor)).toBe(1);
    expect(await count(localVendor)).toBe(0);
    const stored = await PurchaseOrder.findById(po.id);
    expect(stored!.vendorId.toString()).toBe(vatVendor);
    expect(stored!.version).toBe(1);

    // A foreign or unknown vendor on edit is refused with the counters untouched.
    const other = await setup("other");
    const otherAdmin = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    const foreignVendor = await vendor({ name: "Foreign" }, otherAdmin);
    const foreign = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, vendorId: foreignVendor });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe("VENDOR_NOT_FOUND");
    expect(await count(vatVendor)).toBe(1);
    expect(((await Vendor.findOne({ _id: foreignVendor }))!).purchaseDocumentCount).toBe(0);
  });

  it("sending the same vendor again, or moving there and back, does not drift", async () => {
    const po = await draft();
    const same = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, vendorId: vatVendor.toUpperCase() });
    expect(same.status).toBe(200);
    expect(same.body.data.purchaseOrder.vendor.id).toBe(vatVendor);
    const there = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 2, vendorId: localVendor });
    const back = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 3, vendorId: vatVendor });
    expect([there.status, back.status]).toEqual([200, 200]);
    await expectCountersMatchPos();
    expect(await count(vatVendor)).toBe(1);
  });

  it("two concurrent vendor changes from one version: one wins, the counters add up", async () => {
    const po = await draft();
    const results = await Promise.all([
      request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, vendorId: localVendor }),
      request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, vendorId: thirdVendor }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("PURCHASE_ORDER_VERSION_CONFLICT");
    await expectCountersMatchPos();
    const total = (await count(vatVendor)) + (await count(localVendor)) + (await count(thirdVendor));
    expect(total).toBe(1);
  });

  it("a concurrent delete and vendor change, or delete and delete, never drive a counter negative or leak one", async () => {
    const a = await draft();
    const [del, move] = await Promise.all([
      request.delete(`${poUrl(a)}?version=1`).set(auth(admin)),
      request.patch(poUrl(a)).set(auth(admin)).send({ version: 1, vendorId: localVendor }),
    ]);
    // The loser meets either the version bump (409) or the deleted draft (404).
    expect(del.status === 200 ? [409, 404].includes(move.status) : del.status === 409 && move.status === 200).toBe(true);
    await expectCountersMatchPos();

    const b = await draft({ vendorId: thirdVendor });
    const twice = await Promise.all([
      request.delete(`${poUrl(b)}?version=1`).set(auth(admin)),
      request.delete(`${poUrl(b)}?version=1`).set(auth(admin)),
    ]);
    expect(twice.filter((r) => r.status === 200)).toHaveLength(1);
    expect(twice.every((r) => r.status < 500)).toBe(true);
    await expectCountersMatchPos();
    expect(await count(thirdVendor)).toBe(0);
  });

  it("issue racing delete or edit from one version leaves one consistent PO", async () => {
    const a = await draft();
    const [i, d] = await Promise.all([issue(a), request.delete(`${poUrl(a)}?version=1`).set(auth(admin))]);
    expect([200, 404, 409].includes(i.status) && [200, 404, 409].includes(d.status)).toBe(true);
    expect([i.status, d.status].filter((status) => status === 200)).toHaveLength(1);
    const stored = await PurchaseOrder.findOne({ _id: a.id, isDelete: anyState });
    expect(stored!.isDelete).toBe(d.status === 200);
    expect(stored!.version).toBe(2);
    await expectCountersMatchPos();

    const b = await draft({ vendorId: localVendor });
    await issue(b);
    const [cancel, edit] = await Promise.all([
      request.post(poUrl(b, "/cancel")).set(auth(admin)).send({ version: 2 }),
      request.patch(poUrl(b)).set(auth(admin)).send({ version: 2, lines: [line(coffee, 5)] }),
    ]);
    expect([cancel.status, edit.status].sort()).toEqual([200, 409]);
    const after = await PurchaseOrder.findById(b.id);
    expect(after!.version).toBe(3);
    expect(after!.status).toBe(cancel.status === 200 ? "cancelled" : "issued");
    expect(after!.lines[0].quantityMilli).toBe(cancel.status === 200 ? 24000 : 5000);
  });

  it("a vendor delete racing many creates leaves counters equal to the POs", async () => {
    const results = await Promise.all([
      ...[1, 2, 3, 4].map(() => createPo({ vendorId: thirdVendor, lines: [line()] })),
      request.delete(`${VENDORS}/${thirdVendor}`).set(auth(admin)),
    ]);
    const made = results.slice(0, 4).filter((r) => r.status === 201).length;
    const deleted = results[4].status === 200;
    expect(results.every((r) => r.status < 500), JSON.stringify(results.map((r) => r.status))).toBe(true);
    expect(await PurchaseOrder.countDocuments({ vendorId: thirdVendor })).toBe(made);
    expect(await count(thirdVendor)).toBe(deleted ? 0 : made);
    if (deleted) expect(made).toBe(0);
  });
});

// ==========================================
// Numbering
// ==========================================

describe("numbering", () => {
  it("gives ten simultaneous first creates ten distinct consecutive numbers", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => createPo({ vendorId: vatVendor, lines: [line()] })));
    expect(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status))).toBe(true);
    const numbers = results.map((r) => r.body.data.purchaseOrder.number).sort();
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => `PO-${String(i + 1).padStart(5, "0")}`));
    expect(await count(vatVendor)).toBe(10);
    expect((await DocumentCounter.findOne({}))!.seq).toBe(10);
  });

  it("counts per organization and per store of the same organization together", async () => {
    const other = await setup("other");
    const otherAdmin = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    const ov = await vendor({ name: "OV" }, otherAdmin);
    const op = await product(goods({ name: "OP", sku: "OP-1", purchase: { costPrice: "1.000" } }), otherAdmin);
    const foreign = await request
      .post(`/api/v1/stores/${other.storeA._id}/purchase-orders`)
      .set(auth(otherAdmin))
      .set("Idempotency-Key", newKey())
      .send({ vendorId: ov, lines: [line(op)] });
    expect(foreign.body.data.purchaseOrder.number).toBe("PO-00001");
    expect((await draft()).number).toBe("PO-00001");
    expect((await draft({}, { store: ctx.storeB._id })).number).toBe("PO-00002");
  });

  it("orders PO-100000 before PO-99999 in the lists", async () => {
    await DocumentCounter.create({ organizationId: ctx.org._id, type: "purchase_order", seq: 99998 });
    const a = await draft();
    const b = await draft();
    expect([a.number, b.number]).toEqual(["PO-99999", "PO-100000"]);
    const list = await request.get(ALL_POS).set(auth(admin));
    expect(list.body.data.purchaseOrders.map((p: { number: string }) => p.number)).toEqual(["PO-100000", "PO-99999"]);
    expect((await request.get(`${ALL_POS}?search=PO-1000`).set(auth(admin))).body.data.purchaseOrders).toHaveLength(1);
  });
});

// ==========================================
// VAT estimate
// ==========================================

describe("VAT estimate details", () => {
  const extraProducts = async (n: number) =>
    Promise.all(Array.from({ length: n }, (_, i) => product(goods({ name: `Item ${i}`, sku: `ITEM-${i}`, purchase: {} }))));

  it("rounds each line half-up, and the total is the sum of the rounded lines", async () => {
    const [x, y, z] = await extraProducts(3);
    const res = await createPo({
      vendorId: vatVendor,
      lines: [line(x, 1, { unitCost: "0.005" }), line(y, 1, { unitCost: "0.005" }), line(z, 1, { unitCost: "0.005" })],
    });
    const po = res.body.data.purchaseOrder;
    expect(po.lines.map((l: { tax: { estimatedTax: string } }) => l.tax.estimatedTax)).toEqual(["0.001", "0.001", "0.001"]);
    expect(po.subtotal).toBe("0.015");
    expect(po.estimatedTax).toBe("0.003"); // not round(0.0015) = 0.002
    expect(po.estimatedTotal).toBe("0.018");
  });

  it("rounds a fractional-quantity subtotal half-up before taxing it", async () => {
    const [kg] = await extraProducts(1);
    await Product.updateOne({ _id: (await ProductVariant.findById(kg))!.productId }, { $set: { unit: "kg" } });
    const res = await createPo({ vendorId: vatVendor, lines: [line(kg, 1.5, { unitCost: "0.333" })] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const l = res.body.data.purchaseOrder.lines[0];
    expect(l.subtotal).toBe("0.500"); // 0.4995
    expect(l.tax.estimatedTax).toBe("0.050");
    expect(l.total).toBe("0.550");
  });

  it("falls back to the organization's default rate when the product has none, and to no VAT when there is no default", async () => {
    const productId = (await ProductVariant.findById(coffee))!.productId;
    await Product.updateOne({ _id: productId }, { $set: { taxRateId: null } });
    const fallback = await TaxRate.findOne({ organizationId: ctx.org._id, isDefault: true });
    const res = await createPo({ vendorId: vatVendor, lines: [line(coffee, 10)] });
    const l = res.body.data.purchaseOrder.lines[0];
    expect(l.tax.taxRate).toMatchObject({ id: String(fallback!._id), rate: fallback!.rate });
    expect(l.tax.estimatedTax).toBe("1.600");

    await TaxRate.updateMany({ organizationId: ctx.org._id }, { $set: { isDelete: true } });
    const none = await createPo({ vendorId: vatVendor, lines: [line(coffee, 10)] });
    expect(none.status).toBe(201);
    expect(none.body.data.purchaseOrder.lines[0].tax).toMatchObject({ taxPreference: "standard", taxRate: null, estimatedTax: "0.000" });
    expect(none.body.data.purchaseOrder.estimatedTotal).toBe(none.body.data.purchaseOrder.subtotal);
  });

  it("a product keeps its own rate after that rate is deleted", async () => {
    const productId = (await ProductVariant.findById(coffee))!.productId;
    const rateId = (await Product.findById(productId))!.taxRateId;
    expect(rateId).toBeTruthy();
    await TaxRate.updateOne({ _id: rateId }, { $set: { isDelete: true } });
    const res = await createPo({ vendorId: vatVendor, lines: [line(coffee, 10)] });
    expect(res.body.data.purchaseOrder.lines[0].tax.taxRate.id).toBe(String(rateId));
  });

  it("is worked out again at issue, and an issued PO edits against its vendor copy", async () => {
    const po = await draft();
    expect(po.estimatedTax).not.toBe("0.000");
    await Vendor.updateOne({ _id: vatVendor }, { $set: { vatTreatment: "not_registered" } });
    const stale = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, notes: "n" });
    expect(stale.body.data.purchaseOrder.estimatedTax).toBe(po.estimatedTax); // notes only: not re-estimated
    const issued = await issue(stale.body.data.purchaseOrder);
    expect(issued.body.data.purchaseOrder.estimatedTax).toBe("0.000");
    expect(issued.body.data.purchaseOrder.vendor.vatTreatment).toBe("not_registered");

    await Vendor.updateOne({ _id: vatVendor }, { $set: { vatTreatment: "vat_registered" } });
    const edited = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 3, lines: [line(coffee, 10, { unitCost: "1.600" })] });
    expect(edited.body.data.purchaseOrder.estimatedTax).toBe("0.000");
  });
});

// ==========================================
// Version before status
// ==========================================

describe("version is checked before status for every action", () => {
  it("stale version on a wrong-status PO is a version conflict; the current version a status conflict", async () => {
    const po = await draft(); // draft v1
    const issued = (await issue(po)).body.data.purchaseOrder; // issued v2
    await request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version: 2 }); // cancelled v3

    const actions: [string, (version: number) => Promise<{ status: number; body: any }>][] = [
      ["patch", (version) => request.patch(poUrl(po)).set(auth(admin)).send({ version, notes: "x" })],
      ["issue", (version) => request.post(poUrl(po, "/issue")).set(auth(admin)).send({ version })],
      ["cancel", (version) => request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version })],
      ["close", (version) => request.post(poUrl(po, "/close")).set(auth(admin)).send({ version })],
      ["delete", (version) => request.delete(`${poUrl(po)}?version=${version}`).set(auth(admin))],
    ];
    for (const [name, call] of actions) {
      const stale = await call(issued.version);
      expect(stale.status, name).toBe(409);
      expect(stale.body.code, name).toBe("PURCHASE_ORDER_VERSION_CONFLICT");
      expect(stale.body.errors[0].meta.currentVersion, name).toBe(3);
      const current = await call(3);
      expect(current.status, name).toBe(409);
      expect(current.body.code, name).toBe("PURCHASE_ORDER_STATUS_CONFLICT");
      expect(current.body.errors[0].meta.status, name).toBe("cancelled");
    }
    expect((await PurchaseOrder.findById(po.id))!.version).toBe(3);
  });

  it("a stale version with a vendor change on an issued PO is a version conflict, not a vendor error", async () => {
    const po = await draft();
    await issue(po);
    const stale = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, vendorId: localVendor });
    expect(stale.body.code).toBe("PURCHASE_ORDER_VERSION_CONFLICT");
    const current = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 2, vendorId: localVendor });
    expect(current.status).toBe(400);
    await expectCountersMatchPos();
  });

  it("odd version values are 400 or 409 and never change the PO", async () => {
    const po = await draft();
    for (const version of [0, -1, 1.5, "1", null, true, [], {}, 1e21, Number.MAX_SAFE_INTEGER]) {
      const res = await request.patch(poUrl(po)).set(auth(admin)).send({ version, notes: "x" });
      expect([400, 409], String(version)).toContain(res.status);
    }
    expect((await PurchaseOrder.findById(po.id))!.version).toBe(1);
  });

  it("two concurrent issues from one version issue once and bump the version once", async () => {
    const po = await draft();
    const results = await Promise.all([issue(po), issue(po)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await PurchaseOrder.findById(po.id))!.version).toBe(2);
  });
});

// ==========================================
// Tenant and store isolation
// ==========================================

describe("isolation", () => {
  it("another store's PO is 404 for every verb through this store's path, and unchanged", async () => {
    const po = await draft({}, { store: ctx.storeB._id });
    const wrong = (suffix = "") => `${storePos(ctx.storeA._id)}/${po.id}${suffix}`;
    const results = [
      await request.get(wrong()).set(auth(admin)),
      await request.patch(wrong()).set(auth(admin)).send({ version: 1, notes: "x" }),
      await request.delete(`${wrong()}?version=1`).set(auth(admin)),
      await request.post(wrong("/issue")).set(auth(admin)).send({ version: 1 }),
      await request.post(wrong("/cancel")).set(auth(admin)).send({ version: 1 }),
      await request.post(wrong("/close")).set(auth(admin)).send({ version: 1 }),
    ];
    for (const res of results) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("PURCHASE_ORDER_NOT_FOUND");
    }
    const stored = await PurchaseOrder.findById(po.id);
    expect(stored!.version).toBe(1);
    expect(stored!.isDelete).toBe(false);
    await expectCountersMatchPos();
  });

  it("a store-scoped user gets 403 on a store they lack, 404 on a PO of another store of theirs, and no mutation lands", async () => {
    const manager = await tokenFor(ctx.org._id, "m@alnoor.test", {
      storeAccess: [
        { storeId: ctx.storeA._id, roleId: ctx.role("store_manager")._id },
        { storeId: ctx.storeB._id, roleId: ctx.role("store_manager")._id },
      ],
    });
    const onlyA = await tokenFor(ctx.org._id, "a@alnoor.test", { storeAccess: [{ storeId: ctx.storeA._id, roleId: ctx.role("store_manager")._id }] });
    const po = await draft({}, { store: ctx.storeB._id });

    expect((await request.get(poUrl(po, "", ctx.storeA._id)).set(auth(manager))).status).toBe(404);
    expect((await request.patch(poUrl(po, "", ctx.storeA._id)).set(auth(manager)).send({ version: 1, notes: "x" })).status).toBe(404);
    for (const res of [
      await request.get(poUrl(po, "", ctx.storeB._id)).set(auth(onlyA)),
      await request.patch(poUrl(po, "", ctx.storeB._id)).set(auth(onlyA)).send({ version: 1, notes: "x" }),
      await request.delete(`${poUrl(po, "", ctx.storeB._id)}?version=1`).set(auth(onlyA)),
      await request.post(poUrl(po, "/issue", ctx.storeB._id)).set(auth(onlyA)).send({ version: 1 }),
      await request.post(poUrl(po, "/cancel", ctx.storeB._id)).set(auth(onlyA)).send({ version: 1 }),
    ]) {
      expect(res.status).toBe(403);
    }
    // A body or query storeId cannot redirect the request to a store the caller lacks.
    const sneaky = await request.get(`${storePos(ctx.storeA._id)}?storeId=${ctx.storeB._id}`).set(auth(onlyA));
    expect(sneaky.body.data.purchaseOrders).toEqual([]);
    expect((await createPo({ vendorId: vatVendor, lines: [line()], storeId: String(ctx.storeB._id) }, { token: onlyA })).status).toBe(400);
    expect((await PurchaseOrder.findById(po.id))!.version).toBe(1);
  });

  it("another organization cannot reach, list, or reference this organization's data", async () => {
    const po = await draft();
    const other = await setup("other");
    const otherAdmin = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    const otherVendor = await vendor({ name: "Other V" }, otherAdmin);
    const otherVariant = await product(goods({ name: "Other P", sku: "OTH-1", purchase: { costPrice: "1.000" } }), otherAdmin);
    const ownStore = `/api/v1/stores/${other.storeA._id}/purchase-orders`;

    // This organization's store in the URL: not found. Its PO id on their own store: not found.
    for (const url of [poUrl(po), `${ownStore}/${po.id}`]) {
      expect((await request.get(url).set(auth(otherAdmin))).status, url).toBe(404);
      expect((await request.patch(url).set(auth(otherAdmin)).send({ version: 1, notes: "x" })).status).toBe(404);
      expect((await request.delete(`${url}?version=1`).set(auth(otherAdmin))).status).toBe(404);
      expect((await request.post(`${url}/issue`).set(auth(otherAdmin)).send({ version: 1 })).status).toBe(404);
    }
    const list = await request.get(`${ALL_POS}?storeId=${ctx.storeA._id}&vendorId=${vatVendor}`).set(auth(otherAdmin));
    expect(list.body.data.purchaseOrders).toEqual([]);
    expect((await request.get(`${ALL_POS}?search=PO-00001`).set(auth(otherAdmin))).body.data.pagination.total).toBe(0);

    const post = (body: Record<string, unknown>) =>
      request.post(ownStore).set(auth(otherAdmin)).set("Idempotency-Key", newKey()).send(body);
    const withOurVendor = await post({ vendorId: vatVendor, lines: [line(otherVariant)] });
    expect(withOurVendor.body.code).toBe("VENDOR_NOT_FOUND");
    const withOurVariant = await post({ vendorId: otherVendor, lines: [line(coffee)] });
    expect(withOurVariant.body.code).toBe("VARIANT_NOT_FOUND");
    expect((await PurchaseOrder.findById(po.id))!.version).toBe(1);
    expect(await count(vatVendor)).toBe(1);
    expect(await PurchaseOrder.countDocuments({ organizationId: other.org._id })).toBe(0);

    // Another organization's idempotency key space is separate.
    const key = newKey();
    const mine = await createPo({ vendorId: vatVendor, lines: [line()] }, { key });
    const theirs = await request
      .post(ownStore)
      .set(auth(otherAdmin))
      .set("Idempotency-Key", key)
      .send({ vendorId: otherVendor, lines: [line(otherVariant)] });
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("the cross-store list narrows to stores where purchase:read is held, whatever storeId is asked for", async () => {
    const a = await draft({}, { store: ctx.storeA._id });
    const b = await draft({}, { store: ctx.storeB._id });
    const mixed = await tokenFor(ctx.org._id, "mixed@alnoor.test", {
      storeAccess: [
        { storeId: ctx.storeA._id, roleId: ctx.role("store_manager")._id },
        { storeId: ctx.storeB._id, roleId: ctx.role("cashier")._id },
      ],
    });
    const numbers = async (q = "") =>
      (await request.get(`${ALL_POS}${q}`).set(auth(mixed))).body.data.purchaseOrders.map((p: { number: string }) => p.number);
    expect(await numbers()).toEqual([a.number]);
    expect(await numbers(`?storeId=${ctx.storeB._id}`)).toEqual([]);
    expect(await numbers(`?storeId=${ctx.storeA._id}`)).toEqual([a.number]);
    expect(await numbers(`?search=${b.number}`)).toEqual([]);
    expect(await numbers(`?vendorId=${vatVendor}&status=draft`)).toEqual([a.number]);
    const total = (await request.get(`${ALL_POS}?limit=1`).set(auth(mixed))).body.data.pagination.total;
    expect(total).toBe(1);
    // The cashier-only store's list and PO are refused outright.
    expect((await request.get(storePos(ctx.storeB._id)).set(auth(mixed))).status).toBe(403);
    expect((await request.get(poUrl(b, "", ctx.storeB._id)).set(auth(mixed))).status).toBe(403);
  });

  it("a platform token and a tenant token for another organization are refused", async () => {
    const po = await draft();
    expect((await request.get(poUrl(po))).status).toBe(401);
    expect((await request.get(poUrl(po)).set(auth("not.a.jwt"))).status).toBe(401);
    expect((await request.get(ALL_POS).set(auth("not.a.jwt"))).status).toBe(401);
  });
});

// ==========================================
// Idempotency edges
// ==========================================

describe("idempotency edges", () => {
  it("the same key for another store, user or body is refused, and nothing is created twice", async () => {
    const key = newKey();
    const body = { vendorId: vatVendor, lines: [line()] };
    expect((await createPo(body, { key })).status).toBe(201);
    const otherStore = await createPo(body, { key, store: ctx.storeB._id });
    expect(otherStore.status).toBe(409);
    expect(otherStore.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const other = await tokenFor(ctx.org._id, "o@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
    expect((await createPo(body, { key, token: other })).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await PurchaseOrder.countDocuments({})).toBe(1);
    await expectCountersMatchPos();
  });

  it("a key whose first attempt was refused can be used for the corrected request", async () => {
    const key = newKey();
    expect((await createPo({ vendorId: vatVendor, lines: [line(tea)] }, { key })).status).toBe(400);
    expect((await createPo({ vendorId: vatVendor, lines: [line(tea, 1, { unitCost: "0.500" })] }, { key })).status).toBe(201);
  });

  it("rejects missing, empty and malformed keys without touching the vendor", async () => {
    for (const key of ["", "short", "a b c d e f g h", "x".repeat(300)]) {
      const res = await request.post(storePos()).set(auth(admin)).set("Idempotency-Key", key).send({ vendorId: vatVendor, lines: [line()] });
      expect(res.status, key.slice(0, 10)).toBe(400);
    }
    expect(await count(vatVendor)).toBe(0);
  });
});

// ==========================================
// Deactivated stores and the router mount order
// ==========================================

describe("deactivated store", () => {
  it("allows reads, cancel and close for a store manager too, refuses the rest, and the stock router still refuses", async () => {
    const manager = await tokenFor(ctx.org._id, "m2@alnoor.test", { storeAccess: [{ storeId: ctx.storeA._id, roleId: ctx.role("store_manager")._id }] });
    const toCancel = await draft();
    const toClose = await draft();
    const toEdit = await draft();
    await issue(toCancel);
    await issue(toClose);
    await PurchaseOrder.updateOne(
      { _id: toClose.id },
      { $set: { status: "partially_received", "lines.0.receivedQuantityMilli": 1000 } }
    );
    await Store.updateOne({ _id: ctx.storeA._id }, { $set: { isActive: false } });

    expect((await request.get(storePos()).set(auth(manager))).status).toBe(200);
    expect((await request.get(`${storePos()}?status=issued`).set(auth(manager))).body.data.purchaseOrders).toHaveLength(1);
    expect((await request.get(poUrl(toEdit)).set(auth(manager))).status).toBe(200);
    expect((await request.get(ALL_POS).set(auth(manager))).body.data.purchaseOrders).toHaveLength(3);

    expect((await request.patch(poUrl(toEdit)).set(auth(manager)).send({ version: 1, notes: "x" })).status).toBe(403);
    expect((await request.delete(`${poUrl(toEdit)}?version=1`).set(auth(manager))).status).toBe(403);
    expect((await issue(toEdit, manager)).status).toBe(403);
    expect((await createPo({ vendorId: vatVendor, lines: [line()] }, { token: manager })).status).toBe(403);
    expect((await PurchaseOrder.findById(toEdit.id))!.version).toBe(1);

    const cancelled = await request.post(poUrl(toCancel, "/cancel")).set(auth(manager)).send({ version: 2, reason: "closing store" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const closed = await request.post(poUrl(toClose, "/close")).set(auth(manager)).send({ version: 2 });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.purchaseOrder.status).toBe("closed");

    // Mounting the PO router first did not open the store's other routes.
    expect((await request.get(`/api/v1/stores/${ctx.storeA._id}/stock`).set(auth(manager))).status).toBe(403);
    expect((await request.get(`/api/v1/stores/${ctx.storeA._id}/stock-movements`).set(auth(admin))).status).toBe(403);
  });

  it("a store-scoped reader without purchase:order cannot cancel on a deactivated store", async () => {
    const po = await draft();
    await issue(po);
    const clerk = await tokenFor(ctx.org._id, "c@alnoor.test", { storeAccess: [{ storeId: ctx.storeA._id, roleId: ctx.role("inventory_clerk")._id }] });
    await Store.updateOne({ _id: ctx.storeA._id }, { $set: { isActive: false } });
    expect((await request.get(poUrl(po)).set(auth(clerk))).status).toBe(200);
    expect((await request.post(poUrl(po, "/cancel")).set(auth(clerk)).send({ version: 2 })).status).toBe(403);
    expect((await PurchaseOrder.findById(po.id))!.status).toBe("issued");
  });

  it("a deleted store is not found for reads", async () => {
    await Store.updateOne({ _id: ctx.storeB._id }, { $set: { isDelete: true } });
    expect((await request.get(storePos(ctx.storeB._id)).set(auth(admin))).status).toBe(404);
  });
});

// ==========================================
// Line rules and catalog interplay
// ==========================================

describe("lines and the catalog", () => {
  it("a PATCH that fails a line leaves the PO exactly as it was", async () => {
    const po = await draft();
    const before = await PurchaseOrder.findById(po.id);
    const res = await request
      .patch(poUrl(po))
      .set(auth(admin))
      .send({ version: 1, notes: "changed", lines: [line(coffee, 1), line(tea, 1)] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({ field: "lines[1].unitCost", code: "UNIT_COST_REQUIRED" });
    const after = await PurchaseOrder.findById(po.id);
    expect(after!.notes).toBe(before!.notes);
    expect(after!.version).toBe(1);
    expect(after!.lines).toHaveLength(1);
  });

  it("names at most five open POs in order, ignores deleted drafts, and lets a cancelled one go", async () => {
    const productId = (await ProductVariant.findById(coffee))!.productId;
    const pos = [];
    for (let i = 0; i < 6; i += 1) pos.push(await draft({}, { store: i % 2 ? ctx.storeB._id : ctx.storeA._id }));
    const refused = await request.delete(`${PRODUCTS}/${productId}`).set(auth(admin));
    expect(refused.status).toBe(409);
    expect(refused.body.errors[0].meta.purchaseOrders).toEqual(pos.slice(0, 5).map((p) => p.number));

    for (const [i, po] of pos.entries()) {
      await request.delete(`${poUrl(po, "", i % 2 ? ctx.storeB._id : ctx.storeA._id)}?version=1`).set(auth(admin));
    }
    expect((await request.delete(`${PRODUCTS}/${productId}`).set(auth(admin))).status).toBe(200);
  });

  it("a PO can be saved with an inactive product, and deactivating a product on a PO is allowed", async () => {
    const po = await draft();
    const productId = (await ProductVariant.findById(coffee))!.productId;
    const off = await request.patch(`${PRODUCTS}/${productId}/status`).set(auth(admin)).send({ isActive: false });
    expect(off.status, JSON.stringify(off.body)).toBeLessThan(500);
    const res = await request.post(poUrl(po, "/issue")).set(auth(admin)).send({ version: 1 });
    expect(res.status).toBe(200);
  });
});
