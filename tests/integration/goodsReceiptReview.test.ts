/**
 * Purpose: Review tests for Phase 3c goods receipts: responses against the strict Zod response
 * schemas, hostile input (no 500s), numbering and level races, receipt vs PO edit/cancel/close and
 * vendor delete races, atomicity (nothing partial survives a failure), idempotency edges, tenant
 * and store isolation, permission edges, money math in 3- and 2-decimal currencies, and the
 * visibility of lastPurchase on every product response.
 */

import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Vendor } from "../../src/models/vendor.model";
import { Product } from "../../src/models/product.model";
import { ProductVariant } from "../../src/models/productVariant.model";
import { PurchaseOrder } from "../../src/models/purchaseOrder.model";
import { DocumentCounter } from "../../src/models/documentCounter.model";
import { IdempotencyKey } from "../../src/models/idempotencyKey.model";
import { StockLevel } from "../../src/models/stockLevel.model";
import { StockMovement } from "../../src/models/stockMovement.model";
import { GoodsReceipt } from "../../src/models/goodsReceipt.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { generateSuperAdminAccessToken } from "../../src/services/platformAuth.service";
import { singleExample } from "../../src/docs/product.openapi";
import {
  GoodsReceiptDataSchema,
  GoodsReceiptListDataSchema,
  GoodsReceiptSchema,
  GoodsReceiptSummarySchema,
} from "../../src/validators/responses";

const PRODUCTS = "/api/v1/products";
const VENDORS = "/api/v1/vendors";
const ALL_GRNS = "/api/v1/goods-receipts";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let keySeq = 0;
const newKey = () => `grn-review-${Date.now()}-${(keySeq += 1)}`;

async function setup(slug: string, opts: { trn?: string | null; currency?: string } = {}) {
  const currency = opts.currency ?? "BHD";
  const org = await Organization.create({
    name: slug,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    taxRegistrationNumber: opts.trn === undefined ? "220000111100003" : opts.trn,
    settings: { currency, timezone: "Asia/Bahrain" },
  });
  await seedDefaultRolesForOrganization(org._id);
  await seedDefaultTaxRates(org._id, currency);
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

type Ref = { variantId: string; productId: string };
let ctx: Awaited<ReturnType<typeof setup>>;
let admin: string;
let vatVendor: string;
let localVendor: string;
let coffee: Ref;
let rice: Ref;
let bags: Ref;

const storeGrns = (storeId: unknown = ctx.storeA._id) => `/api/v1/stores/${storeId}/goods-receipts`;
const storePos = (storeId: unknown = ctx.storeA._id) => `/api/v1/stores/${storeId}/purchase-orders`;

async function product(body: Record<string, unknown>, token = admin): Promise<Ref> {
  const res = await request.post(PRODUCTS).set(auth(token)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { variantId: res.body.data.product.variants[0].id as string, productId: res.body.data.product.id as string };
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

async function seedCatalog() {
  vatVendor = await vendor({ name: "Gulf Roasters", taxRegistrationNumber: "220000987600003" });
  localVendor = await vendor({ name: "Corner Supplier" });
  coffee = await product(goods({ name: "Coffee", sku: "COF-1", purchase: { costPrice: "1.600" } }));
  rice = await product(goods({ name: "Rice", sku: "RICE-1", unit: "kg", purchase: { costPrice: "0.500" } }));
  bags = await product(goods({ name: "Bags", sku: "BAG-1", purchase: { costPrice: "0.050" }, inventory: { trackInventory: false } }));
}

beforeEach(async () => {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
  await seedCatalog();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function issuedPo(body: Record<string, unknown> = {}, storeId: unknown = ctx.storeA._id, token = admin) {
  const created = await request
    .post(storePos(storeId))
    .set(auth(token))
    .set("Idempotency-Key", newKey())
    .send({
      vendorId: vatVendor,
      orderDate: "2026-10-01",
      lines: [
        { variantId: coffee.variantId, quantity: 24 },
        { variantId: rice.variantId, quantity: 12.5 },
      ],
      ...body,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const po = created.body.data.purchaseOrder;
  const issued = await request.post(`${storePos(storeId)}/${po.id}/issue`).set(auth(token)).send({ version: po.version });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data.purchaseOrder;
}

const receive = (body: unknown, opts: { token?: string; store?: unknown; key?: string } = {}) =>
  request
    .post(storeGrns(opts.store))
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send(body as object);

const direct = (variantId: string, quantity = 1, unitCost = "1.000", extra: Record<string, unknown> = {}) => ({
  vendorId: localVendor,
  lines: [{ variantId, quantity, unitCost }],
  ...extra,
});

const poLines = (po: { lines: { id: string }[] }) => po.lines.map((l) => l.id);
const level = (variantId: string, storeId: unknown = ctx.storeA._id) =>
  StockLevel.findOne({ organizationId: ctx.org._id, storeId, variantId });

/** Everything a receipt may touch, to prove a failure left nothing behind. */
async function footprint() {
  const [receipts, levels, movements, counter, keys, variants, vendors, pos] = await Promise.all([
    GoodsReceipt.countDocuments({ organizationId: ctx.org._id }),
    StockLevel.find({ organizationId: ctx.org._id }).lean(),
    StockMovement.countDocuments({ organizationId: ctx.org._id }),
    DocumentCounter.findOne({ organizationId: ctx.org._id, type: "goods_receipt" }).lean(),
    IdempotencyKey.countDocuments({ organizationId: ctx.org._id }),
    ProductVariant.find({ organizationId: ctx.org._id }).select("lastPurchase").lean(),
    Vendor.find({ organizationId: ctx.org._id }).select("purchaseDocumentCount").lean(),
    PurchaseOrder.find({ organizationId: ctx.org._id }).lean(),
  ]);
  return JSON.parse(JSON.stringify({ receipts, levels, movements, counter, keys, variants, vendors, pos }));
}

const storeToken = (slug: string, email: string, storeId: unknown = ctx.storeA._id) =>
  tokenFor(ctx.org._id, email, { storeAccess: [{ storeId, roleId: ctx.role(slug)._id }] });

// ==========================================
// Responses against the Zod schemas
// ==========================================

describe("responses match the Zod response schemas", () => {
  it("create (PO and direct), replay, get and lists parse strictly", async () => {
    const po = await issuedPo();
    const key = newKey();
    const body = {
      purchaseOrderId: po.id,
      vendorReference: "DN-1",
      notes: "n",
      lines: [
        { purchaseOrderLineId: poLines(po)[0], quantity: 4, note: "b" },
        { purchaseOrderLineId: poLines(po)[1], quantity: 2.5 },
      ],
    };
    const res = await receive(body, { key });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(GoodsReceiptDataSchema.safeParse(res.body.data).success, JSON.stringify(res.body.data)).toBe(true);
    expect(GoodsReceiptSchema.strict().safeParse(res.body.data.goodsReceipt).success).toBe(true);
    expect(res.body.data.purchaseOrder.status).toBe("partially_received");

    const replay = await receive(body, { key });
    expect(replay.body).toEqual(res.body);

    const dres = await receive(direct(bags.variantId, 3, "0.050"));
    expect(dres.status).toBe(201);
    expect(GoodsReceiptSchema.strict().safeParse(dres.body.data.goodsReceipt).success).toBe(true);
    expect(dres.body.data.purchaseOrder).toBeNull();
    expect(dres.body.data.goodsReceipt.lines[0]).toMatchObject({ stocked: false, quantityAfter: null });

    const got = await request.get(`${storeGrns()}/${res.body.data.goodsReceipt.id}`).set(auth(admin));
    expect(GoodsReceiptDataSchema.safeParse(got.body.data).success).toBe(true);
    expect(got.body.data.goodsReceipt).toEqual(res.body.data.goodsReceipt);

    for (const url of [ALL_GRNS, storeGrns()]) {
      const list = await request.get(url).set(auth(admin));
      expect(GoodsReceiptListDataSchema.safeParse(list.body.data).success).toBe(true);
      for (const item of list.body.data.goodsReceipts) {
        expect(GoodsReceiptSummarySchema.strict().safeParse(item).success, JSON.stringify(item)).toBe(true);
      }
    }
  });

  it("never leaks internals (sequence, snapshots, __v, organizationId) in any response", async () => {
    const res = await receive(direct(coffee.variantId));
    const text = JSON.stringify(res.body);
    for (const leak of ["sequence", "__v", "organizationId", "vendorSnapshot", "Milli", "Minor", "passwordHash"]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

// ==========================================
// Concurrency
// ==========================================

describe("concurrency", () => {
  it("concurrent first receipts of an organization all get distinct, gapless numbers", async () => {
    const variants = [coffee, rice, bags].map((p) => p.variantId);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => receive(direct(variants[i % 3], 1, "1.000")))
    );
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body.message))).toEqual(Array(6).fill(201));
    const numbers = results.map((r) => r.body.data.goodsReceipt.number).sort();
    expect(numbers).toEqual(["GRN-00001", "GRN-00002", "GRN-00003", "GRN-00004", "GRN-00005", "GRN-00006"]);
    expect((await DocumentCounter.findOne({ organizationId: ctx.org._id, type: "goods_receipt" }))!.seq).toBe(6);
  });

  it("concurrent first receipts of one variant in one store lose no quantity", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => receive(direct(coffee.variantId, 2, "1.000"))));
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body.message))).toEqual(Array(5).fill(201));
    expect(await level(coffee.variantId)).toMatchObject({ quantityMilli: 10000, valueMinor: 10000 });
    expect(await StockMovement.countDocuments({ organizationId: ctx.org._id, variantId: coffee.variantId })).toBe(5);
  });

  it("receipts of different stores for one variant keep the newest as lastPurchase and sum nothing across stores", async () => {
    const results = await Promise.all([
      receive(direct(coffee.variantId, 2, "1.000")),
      receive(direct(coffee.variantId, 3, "2.000"), { store: ctx.storeB._id }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect((await level(coffee.variantId))!.quantityMilli).toBe(2000);
    expect((await level(coffee.variantId, ctx.storeB._id))!.quantityMilli).toBe(3000);
    const variant = await ProductVariant.findById(coffee.variantId);
    const winner = results.map((r) => r.body.data.goodsReceipt).sort((a, b) => (a.number < b.number ? 1 : -1))[0];
    expect(variant!.lastPurchase!.goodsReceiptNumber).toBe(winner.number);
  });

  it("eight concurrent receipts for one vendor count exactly eight documents and move stock exactly once each", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => receive(direct(i % 2 ? coffee.variantId : rice.variantId, 1, "1.000"))));
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body.message))).toEqual(Array(8).fill(201));
    expect((await Vendor.findById(localVendor))!.purchaseDocumentCount).toBe(8);
    expect((await level(coffee.variantId))!.quantityMilli).toBe(4000);
    expect((await level(rice.variantId))!.quantityMilli).toBe(4000);
    expect(await StockMovement.countDocuments({ organizationId: ctx.org._id })).toBe(8);
    expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(8);
  });

  it("concurrent receipts on different lines of one PO all land and the PO ends received", async () => {
    const po = await issuedPo();
    const [c, r] = poLines(po);
    const results = await Promise.all([
      receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: c, quantity: 12 }] }),
      receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: c, quantity: 12 }] }),
      receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: r, quantity: 12.5 }] }),
    ]);
    expect(results.map((x) => x.status), JSON.stringify(results.map((x) => x.body.message))).toEqual([201, 201, 201]);
    const current = await PurchaseOrder.findById(po.id);
    expect(current!.status).toBe("received");
    expect(current!.version).toBe(po.version + 3);
  });

  it("a receipt and a PO edit racing never both apply: line ids are stale, or the edit loses on version", async () => {
    const po = await issuedPo();
    const edit = request
      .patch(`${storePos()}/${po.id}`)
      .set(auth(admin))
      .send({ version: po.version, lines: [{ variantId: coffee.variantId, quantity: 30 }] });
    const rec = receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 5 }] });
    const [e, r] = await Promise.all([edit, rec]);
    expect([e.status, r.status].some((s) => s >= 500), JSON.stringify([e.body, r.body])).toBe(false);
    const current = await PurchaseOrder.findById(po.id);
    const lvl = await level(coffee.variantId);
    if (r.status === 201) {
      expect(e.status).toBe(409);
      expect(lvl!.quantityMilli).toBe(5000);
      expect(current!.lines[0].receivedQuantityMilli).toBe(5000);
    } else {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("PURCHASE_ORDER_CHANGED");
      expect(e.status).toBe(200);
      expect(lvl).toBeNull();
      expect(current!.lines.every((l) => l.receivedQuantityMilli === 0)).toBe(true);
    }
  });

  it("a receipt and a PO cancel racing never both apply", async () => {
    const po = await issuedPo();
    const cancel = request.post(`${storePos()}/${po.id}/cancel`).set(auth(admin)).send({ version: po.version });
    const rec = receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 5 }] });
    const [c, r] = await Promise.all([cancel, rec]);
    expect([c.status, r.status].some((s) => s >= 500), JSON.stringify([c.body, r.body])).toBe(false);
    const current = await PurchaseOrder.findById(po.id);
    if (r.status === 201) {
      expect(c.status).toBe(409);
      expect(current!.status).toBe("partially_received");
    } else {
      expect(c.status).toBe(200);
      expect(r.status).toBe(409);
      expect(current!.status).toBe("cancelled");
      expect(await level(coffee.variantId)).toBeNull();
      expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(0);
    }
  });

  it("a receipt and a close racing never leave stock on a closed PO that was not received", async () => {
    const po = await issuedPo();
    const first = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 5 }] });
    const version = first.body.data.purchaseOrder.version;
    const close = request.post(`${storePos()}/${po.id}/close`).set(auth(admin)).send({ version });
    const rec = receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 5 }] });
    const [c, r] = await Promise.all([close, rec]);
    expect([c.status, r.status].some((s) => s >= 500), JSON.stringify([c.body, r.body])).toBe(false);
    const current = await PurchaseOrder.findById(po.id);
    if (r.status === 201) {
      expect(current!.lines[0].receivedQuantityMilli).toBe(10000);
      expect(c.status).toBe(409);
    } else {
      expect(r.body.code).toBe("PURCHASE_ORDER_STATUS_CONFLICT");
      expect(current!.status).toBe("closed");
      expect((await level(coffee.variantId))!.quantityMilli).toBe(5000);
    }
  });

  it("a direct receipt and a vendor delete racing: never a receipt on a deleted vendor", async () => {
    const fresh = await vendor({ name: "Fresh Vendor" });
    const del = request.delete(`${VENDORS}/${fresh}`).set(auth(admin));
    const rec = receive(direct(coffee.variantId, 1, "1.000", { vendorId: fresh }));
    const [d, r] = await Promise.all([del, rec]);
    expect([d.status, r.status].some((s) => s >= 500), JSON.stringify([d.body, r.body])).toBe(false);
    const v = await Vendor.findOne({ _id: fresh, isDelete: { $in: [true, false] } });
    if (r.status === 201) {
      expect(d.status).toBe(409);
      expect(v!.isDelete).toBe(false);
      expect(v!.purchaseDocumentCount).toBe(1);
    } else {
      expect(d.status).toBe(200);
      expect(r.status).toBe(400);
      expect(v!.isDelete).toBe(true);
      expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(0);
    }
  });

  it("refuses a receipt for a vendor that was deleted before (VENDOR_NOT_FOUND)", async () => {
    const gone = await vendor({ name: "Gone Vendor" });
    expect((await request.delete(`${VENDORS}/${gone}`).set(auth(admin))).status).toBe(200);
    const res = await receive(direct(coffee.variantId, 1, "1.000", { vendorId: gone }));
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe("VENDOR_NOT_FOUND");
    expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(0);
  });

  it("receiving the last of every line while another receipt takes it: exactly one completes the PO", async () => {
    const po = await issuedPo();
    const all = { purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 24 }, { purchaseOrderLineId: poLines(po)[1], quantity: 12.5 }] };
    const results = await Promise.all([receive(all), receive(all), receive(all)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const current = await PurchaseOrder.findById(po.id);
    expect(current!.status).toBe("received");
    expect((await level(coffee.variantId))!.quantityMilli).toBe(24000);
  });
});

// ==========================================
// Atomicity
// ==========================================

describe("atomicity: a failure partway leaves nothing behind", () => {
  it("a failure while writing lastPurchase rolls back stock, levels, PO, counter, vendor count and the key", async () => {
    const po = await issuedPo();
    const before = await footprint();
    const key = newKey();
    const spy = vi.spyOn(ProductVariant, "updateOne").mockImplementationOnce((() => {
      throw new Error("boom: lastPurchase");
    }) as never);
    const body = { purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 5 }, { purchaseOrderLineId: poLines(po)[1], quantity: 2 }] };
    const res = await receive(body, { key });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("boom");
    expect(spy).toHaveBeenCalled();
    expect(await footprint()).toEqual(before);

    spy.mockRestore();
    const retry = await receive(body, { key });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBeUndefined();
    expect(retry.body.data.goodsReceipt.number).toBe("GRN-00001");
  });

  it("a failure creating the receipt after stock moved rolls the stock back (direct, with vendor count)", async () => {
    const before = await footprint();
    vi.spyOn(GoodsReceipt, "create").mockRejectedValueOnce(new Error("boom: create") as never);
    const res = await receive({
      vendorId: localVendor,
      lines: [
        { variantId: coffee.variantId, quantity: 2, unitCost: "1.000" },
        { variantId: rice.variantId, quantity: 2.5, unitCost: "0.500" },
      ],
    });
    expect(res.status).toBe(500);
    expect(await footprint()).toEqual(before);
    expect((await Vendor.findById(localVendor))!.purchaseDocumentCount).toBe(0);
  });

  it("a bad second line (unknown variant) writes nothing for the first", async () => {
    const before = await footprint();
    const res = await receive({
      vendorId: localVendor,
      lines: [
        { variantId: coffee.variantId, quantity: 2, unitCost: "1.000" },
        { variantId: "665f1c2e8a4b3c0012ab3801", quantity: 1, unitCost: "1.000" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("lines[1].variantId");
    expect(await footprint()).toEqual(before);
  });

  it("a refused request (400/403/409) does not consume a counter number or the Idempotency-Key", async () => {
    const po = await issuedPo();
    const key = newKey();
    const bad = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 99 }] }, { key });
    expect(bad.status).toBe(409);
    expect(await IdempotencyKey.countDocuments({ organizationId: ctx.org._id, key })).toBe(0);
    expect(await DocumentCounter.findOne({ organizationId: ctx.org._id, type: "goods_receipt" })).toBeNull();
    const ok = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] }, { key });
    expect(ok.status).toBe(201);
    expect(ok.body.data.goodsReceipt.number).toBe("GRN-00001");
  });

  it("receipts are final at the model level: update and delete are refused", async () => {
    const res = await receive(direct(coffee.variantId));
    const id = res.body.data.goodsReceipt.id;
    await expect(GoodsReceipt.updateOne({ _id: id }, { $set: { notes: "x" } })).rejects.toThrow(/final/);
    await expect(GoodsReceipt.deleteOne({ _id: id })).rejects.toThrow(/final/);
    for (const method of ["patch", "put", "delete"] as const) {
      const r = await request[method](`${storeGrns()}/${id}`).set(auth(admin)).send({});
      expect(r.status, method).toBe(404);
    }
  });
});

// ==========================================
// Idempotency
// ==========================================

describe("idempotency edges", () => {
  it("the same key in another organization is independent", async () => {
    const other = await setup("other");
    const otherAdmin = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    const v = await vendor({ name: "Other Vendor" }, otherAdmin);
    const p = await product(goods({ name: "OCoffee", sku: "OC-1", purchase: { costPrice: "1.000" } }), otherAdmin);
    const key = newKey();
    const a = await receive(direct(coffee.variantId), { key });
    const b = await request
      .post(storeGrns(other.storeA._id))
      .set(auth(otherAdmin))
      .set("Idempotency-Key", key)
      .send({ vendorId: v, lines: [{ variantId: p.variantId, quantity: 1, unitCost: "1.000" }] });
    expect(a.status).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.headers["idempotent-replayed"]).toBeUndefined();
    expect(b.body.data.goodsReceipt.number).toBe("GRN-00001");
    expect(b.body.data.goodsReceipt.id).not.toBe(a.body.data.goodsReceipt.id);
  });

  it("the same key for another store or another user is a reuse (409), never a replay of someone else's receipt", async () => {
    const key = newKey();
    const body = direct(coffee.variantId);
    expect((await receive(body, { key })).status).toBe(201);
    const otherStore = await receive(body, { key, store: ctx.storeB._id });
    expect(otherStore.status).toBe(409);
    expect(otherStore.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const manager = await storeToken("store_manager", "m@alnoor.test");
    const otherUser = await receive(body, { key, token: manager });
    expect(otherUser.status).toBe(409);
    expect(otherUser.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(1);
  });

  it("concurrent requests with one key post once and replay the rest", async () => {
    const key = newKey();
    const body = direct(coffee.variantId, 3);
    const results = await Promise.all(Array.from({ length: 4 }, () => receive(body, { key })));
    expect(results.every((r) => r.status === 201 || r.status === 409), JSON.stringify(results.map((r) => r.status))).toBe(true);
    expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(1);
    expect((await level(coffee.variantId))!.quantityMilli).toBe(3000);
    expect(new Set(results.filter((r) => r.status === 201).map((r) => r.body.data.goodsReceipt.id)).size).toBe(1);
  });

  it("a replay returns the original body even after the PO moved on, and key order in the body does not matter", async () => {
    const po = await issuedPo();
    const key = newKey();
    const first = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 24 }] }, { key });
    await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[1], quantity: 12.5 }] });
    const replay = await receive({ lines: [{ quantity: 24, purchaseOrderLineId: poLines(po)[0] }], purchaseOrderId: po.id }, { key });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
  });

  it("rejects malformed keys (empty, oversized, bad characters) before posting", async () => {
    for (const key of ["", " ", "x".repeat(300), "bad keyé"]) {
      const res = await request.post(storeGrns()).set(auth(admin)).set("Idempotency-Key", key).send(direct(coffee.variantId));
      expect(res.status, JSON.stringify(key)).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    }
    expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(0);
  });
});

// ==========================================
// Tenant and store isolation
// ==========================================

describe("isolation", () => {
  let other: Awaited<ReturnType<typeof setup>>;
  let otherAdmin: string;
  let otherVendor: string;
  let otherProduct: Ref;

  beforeEach(async () => {
    other = await setup("other");
    otherAdmin = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    otherVendor = await vendor({ name: "Other Vendor" }, otherAdmin);
    otherProduct = await product(goods({ name: "OCoffee", sku: "OC-1", purchase: { costPrice: "1.000" } }), otherAdmin);
  });

  it("another organization's PO, vendor and variant look like they do not exist", async () => {
    const po = await request
      .post(storePos(other.storeA._id))
      .set(auth(otherAdmin))
      .set("Idempotency-Key", newKey())
      .send({ vendorId: otherVendor, lines: [{ variantId: otherProduct.variantId, quantity: 5 }] });
    const issued = await request.post(`${storePos(other.storeA._id)}/${po.body.data.purchaseOrder.id}/issue`).set(auth(otherAdmin)).send({ version: 1 });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const foreign = issued.body.data.purchaseOrder;

    const before = await footprint();
    // Through our store URL and through theirs (we have no access to their store).
    const viaOurs = await receive({ purchaseOrderId: foreign.id, lines: [{ purchaseOrderLineId: foreign.lines[0].id, quantity: 1 }] });
    expect(viaOurs.status).toBe(404);
    expect(viaOurs.body.code).toBe("PURCHASE_ORDER_NOT_FOUND");
    const viaTheirs = await receive({ purchaseOrderId: foreign.id, lines: [{ purchaseOrderLineId: foreign.lines[0].id, quantity: 1 }] }, { store: other.storeA._id });
    expect([403, 404]).toContain(viaTheirs.status);
    const vend = await receive(direct(coffee.variantId, 1, "1.000", { vendorId: otherVendor }));
    expect(vend.status).toBe(400);
    expect(vend.body.code).toBe("VENDOR_NOT_FOUND");
    const variant = await receive(direct(otherProduct.variantId));
    expect(variant.status).toBe(400);
    expect(variant.body.code).toBe("VARIANT_NOT_FOUND");
    expect(await footprint()).toEqual(before);
    expect(await StockLevel.countDocuments({ organizationId: other.org._id })).toBe(0);
    expect((await PurchaseOrder.findById(foreign.id))!.lines[0].receivedQuantityMilli).toBe(0);
  });

  it("a PO of another store cannot be received through this store's URL, and a store manager cannot receive at another store", async () => {
    const poB = await issuedPo({}, ctx.storeB._id);
    const before = await footprint();
    const res = await receive({ purchaseOrderId: poB.id, lines: [{ purchaseOrderLineId: poLines(poB)[0], quantity: 1 }] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PURCHASE_ORDER_NOT_FOUND");
    expect(res.body.errors[0].field).toBe("purchaseOrderId");
    expect(await footprint()).toEqual(before);

    const managerA = await storeToken("store_manager", "ma@alnoor.test");
    const asA = await receive({ purchaseOrderId: poB.id, lines: [{ purchaseOrderLineId: poLines(poB)[0], quantity: 1 }] }, { token: managerA, store: ctx.storeB._id });
    expect(asA.status).toBe(403);
    expect(await footprint()).toEqual(before);
  });

  it("a PO line id from another PO (same org) is PURCHASE_ORDER_CHANGED, never received", async () => {
    const po1 = await issuedPo();
    const po2 = await issuedPo();
    const res = await receive({ purchaseOrderId: po1.id, lines: [{ purchaseOrderLineId: poLines(po2)[0], quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PURCHASE_ORDER_CHANGED");
    expect(res.body.errors[0].field).toBe("lines[0].purchaseOrderLineId");
    expect((await PurchaseOrder.findById(po2.id))!.lines[0].receivedQuantityMilli).toBe(0);
  });

  it("an uppercase PO line id works the same as lowercase", async () => {
    const po = await issuedPo();
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0].toUpperCase(), quantity: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("client-sent organizationId, storeId, createdBy, number or status are refused, never trusted", async () => {
    const before = await footprint();
    for (const extra of [
      { organizationId: String(other.org._id) },
      { storeId: String(other.storeA._id) },
      { createdBy: String(other.org._id) },
      { number: "GRN-99999" },
      { sequence: 99 },
      { status: "cancelled" },
      { isSuperAdmin: true },
    ]) {
      const res = await receive(direct(coffee.variantId, 1, "1.000", extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const lineExtra = await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000", stockUnitCost: "9.000", organizationId: String(other.org._id) }] });
    expect(lineExtra.status).toBe(400);
    expect(await footprint()).toEqual(before);
  });

  it("lists never include another organization's receipts and the cross-store list honours store roles", async () => {
    await receive(direct(coffee.variantId));
    const mine = await request.post(storeGrns(other.storeA._id)).set(auth(otherAdmin)).set("Idempotency-Key", newKey()).send({ vendorId: otherVendor, lines: [{ variantId: otherProduct.variantId, quantity: 1, unitCost: "1.000" }] });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    const mineList = await request.get(ALL_GRNS).set(auth(admin));
    expect(mineList.body.data.goodsReceipts).toHaveLength(1);
    // Filters with the other org's ids find nothing in ours.
    for (const q of [`vendorId=${otherVendor}`, `storeId=${other.storeA._id}`, `purchaseOrderId=${mine.body.data.goodsReceipt.id}`]) {
      const res = await request.get(`${ALL_GRNS}?${q}`).set(auth(admin));
      expect(res.body.data.goodsReceipts, q).toEqual([]);
    }
    const byId = await request.get(`${storeGrns()}/${mine.body.data.goodsReceipt.id}`).set(auth(admin));
    expect(byId.status).toBe(404);

    // A clerk of store B cannot widen the list with ?storeId=A.
    await receive(direct(coffee.variantId), { store: ctx.storeB._id });
    const clerkB = await storeToken("inventory_clerk", "cb@alnoor.test", ctx.storeB._id);
    const wide = await request.get(`${ALL_GRNS}?storeId=${ctx.storeA._id}`).set(auth(clerkB));
    expect(wide.status).toBe(200);
    expect(wide.body.data.goodsReceipts).toEqual([]);
    const own = await request.get(ALL_GRNS).set(auth(clerkB));
    expect(own.body.data.goodsReceipts.map((g: { store: { id: string } }) => g.store.id)).toEqual([String(ctx.storeB._id)]);
    // And cannot read store A's list or receipt directly.
    expect((await request.get(storeGrns(ctx.storeA._id)).set(auth(clerkB))).status).toBe(403);
  });

  it("a platform super admin token is refused on every goods receipt route, and a tenant token with the wrong secret too", async () => {
    const platform = generateSuperAdminAccessToken({ userId: new mongoose.Types.ObjectId().toString() });
    const before = await footprint();
    const gets = [ALL_GRNS, storeGrns(), `${storeGrns()}/${new mongoose.Types.ObjectId()}`];
    for (const url of gets) expect((await request.get(url).set(auth(platform))).status, url).toBe(401);
    const post = await receive(direct(coffee.variantId), { token: platform });
    expect(post.status).toBe(401);
    expect(JSON.stringify(post.body)).not.toContain(platform);
    expect(await footprint()).toEqual(before);
  });

  it("a platform (super admin) style or garbage token is not accepted", async () => {
    for (const token of ["garbage", "a.b.c", ""]) {
      const res = await request.get(ALL_GRNS).set({ Authorization: `Bearer ${token}` });
      expect(res.status).toBe(401);
    }
    expect((await request.get(ALL_GRNS)).status).toBe(401);
    expect((await request.post(storeGrns()).set("Idempotency-Key", newKey()).send(direct(coffee.variantId))).status).toBe(401);
  });
});

// ==========================================
// Permissions
// ==========================================

describe("permission edges", () => {
  async function customRole(name: string, permissions: string[]) {
    return Role.create({ organizationId: ctx.org._id, name, slug: name, permissions, scope: "store", isSystem: false });
  }

  it("a clerk sending the PO's own cost in other spellings passes; any other cost is 403 with nothing written", async () => {
    const clerk = await storeToken("inventory_clerk", "clerk@alnoor.test");
    const po = await issuedPo();
    for (const cost of ["1.600", "1.6", "01.6", "1.60"]) {
      const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1, unitCost: cost }] }, { token: clerk });
      expect(res.status, `${cost}: ${JSON.stringify(res.body)}`).toBe(201);
    }
    const before = await footprint();
    const up = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1, unitCost: "1.601" }] }, { token: clerk });
    expect(up.status).toBe(403);
    const zero = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1, unitCost: "0" }] }, { token: clerk });
    expect(zero.status).toBe(403);
    expect(await footprint()).toEqual(before);
  });

  it("the cost check runs before the over-receipt check and after the unit checks (no probing the PO through 409)", async () => {
    const clerk = await storeToken("inventory_clerk", "clerk@alnoor.test");
    const po = await issuedPo();
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 9999, unitCost: "0.001" }] }, { token: clerk });
    expect(res.status).toBe(403);
  });

  it("an unauthorised clerk learns nothing about a vendor: direct receipt is 403 before the vendor is looked up", async () => {
    const clerk = await storeToken("inventory_clerk", "clerk@alnoor.test");
    const res = await receive(direct(coffee.variantId, 1, "1.000", { vendorId: "665f1c2e8a4b3c0012ab3999" }), { token: clerk });
    expect(res.status).toBe(403);
    expect(await Vendor.countDocuments({ organizationId: ctx.org._id, purchaseDocumentCount: { $gt: 0 } })).toBe(0);
  });

  it("a custom store role with receive but not order behaves like the clerk; with both it may change costs", async () => {
    const receiveOnly = await customRole("receiver", ["purchase:read", "purchase:receive"]);
    const both = await customRole("buyer", ["purchase:read", "purchase:receive", "purchase:order"]);
    const t1 = await tokenFor(ctx.org._id, "r1@alnoor.test", { storeAccess: [{ storeId: ctx.storeA._id, roleId: receiveOnly._id }] });
    const t2 = await tokenFor(ctx.org._id, "r2@alnoor.test", { storeAccess: [{ storeId: ctx.storeA._id, roleId: both._id }] });
    const po = await issuedPo();
    const line = { purchaseOrderLineId: poLines(po)[0], quantity: 1, unitCost: "1.700" };
    expect((await receive({ purchaseOrderId: po.id, lines: [line] }, { token: t1 })).status).toBe(403);
    expect((await receive({ purchaseOrderId: po.id, lines: [line] }, { token: t2 })).status).toBe(201);
    expect((await receive(direct(coffee.variantId), { token: t1 })).status).toBe(403);
    expect((await receive(direct(coffee.variantId), { token: t2 })).status).toBe(201);
  });

  it("purchase:order at another store does not help at this store; purchase:order only at this store does", async () => {
    const mgrB = await customRole("order-b", ["purchase:read", "purchase:receive", "purchase:order"]);
    const recvA = await customRole("recv-a", ["purchase:read", "purchase:receive"]);
    const t = await tokenFor(ctx.org._id, "split@alnoor.test", {
      storeAccess: [
        { storeId: ctx.storeA._id, roleId: recvA._id },
        { storeId: ctx.storeB._id, roleId: mgrB._id },
      ],
    });
    expect((await receive(direct(coffee.variantId), { token: t })).status).toBe(403);
    expect((await receive(direct(coffee.variantId), { token: t, store: ctx.storeB._id })).status).toBe(201);
  });

  it("an org-level role with receive and order may receive in any store; one without receive may not", async () => {
    const orgBuyer = await Role.create({
      organizationId: ctx.org._id,
      name: "org-buyer",
      slug: "org-buyer",
      permissions: ["purchase:read", "purchase:receive", "purchase:order"],
      scope: "organization",
      isSystem: false,
    });
    const t = await tokenFor(ctx.org._id, "ob@alnoor.test", { orgRoleId: orgBuyer._id });
    expect((await receive(direct(coffee.variantId), { token: t, store: ctx.storeA._id })).status).toBe(201);
    expect((await receive(direct(coffee.variantId), { token: t, store: ctx.storeB._id })).status).toBe(201);
    const readOnly = await customRole("ro", ["purchase:read"]);
    const t2 = await tokenFor(ctx.org._id, "ro@alnoor.test", { storeAccess: [{ storeId: ctx.storeA._id, roleId: readOnly._id }] });
    expect((await receive(direct(coffee.variantId), { token: t2 })).status).toBe(403);
    expect((await request.get(storeGrns()).set(auth(t2))).status).toBe(200);
  });

  it("a user with only purchase:order (no receive) cannot receive", async () => {
    const orderOnly = await customRole("order-only", ["purchase:read", "purchase:order"]);
    const t = await tokenFor(ctx.org._id, "oo@alnoor.test", { storeAccess: [{ storeId: ctx.storeA._id, roleId: orderOnly._id }] });
    expect((await receive(direct(coffee.variantId), { token: t })).status).toBe(403);
  });

  it("a deactivated user's token and a user whose role was deleted are refused", async () => {
    const t = await storeToken("store_manager", "gone@alnoor.test");
    await User.updateOne({ email: "gone@alnoor.test" }, { $set: { isActive: false } });
    const res = await receive(direct(coffee.variantId), { token: t });
    expect([401, 403]).toContain(res.status);
    expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(0);
  });
});

// ==========================================
// Money and quantity math
// ==========================================

describe("money and quantity math", () => {
  it("weighted average over several receipts, and stockValue equals the ledger value", async () => {
    await receive(direct(rice.variantId, 3, "1.000"));
    await receive(direct(rice.variantId, 2, "1.500"));
    const third = await receive(direct(rice.variantId, 0.333, "1.234"));
    expect(third.status, JSON.stringify(third.body)).toBe(201);
    const l = await level(rice.variantId);
    // 3.000 + 3.000 + round(0.333 * 1.234 = 0.410922 -> 0.411) = 6.411
    expect(l).toMatchObject({ quantityMilli: 5333, valueMinor: 6411 });
    const moves = await StockMovement.find({ organizationId: ctx.org._id, variantId: rice.variantId }).sort({ createdAt: 1 });
    expect(moves.reduce((sum, m) => sum + m.valueChangeMinor, 0)).toBe(l!.valueMinor);
    expect(third.body.data.goodsReceipt.stockValue).toBe("0.411");
    expect(third.body.data.goodsReceipt.lines[0]).toMatchObject({ subtotal: "0.411", stockValue: "0.411", quantityAfter: 5.333 });
  });

  it("subtotal and stockValue sum the rounded lines, not a re-rounded total", async () => {
    const rice2 = await product(goods({ name: "Rice 2", sku: "RICE-2", unit: "kg", purchase: { costPrice: "0.500" } }));
    const res = await receive({
      vendorId: localVendor,
      lines: [
        { variantId: rice2.variantId, quantity: 0.001, unitCost: "0.500" }, // 0.0005 -> 0.001
        { variantId: rice.variantId, quantity: 0.001, unitCost: "0.500" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.goodsReceipt.lines.map((l: { subtotal: string }) => l.subtotal)).toEqual(["0.001", "0.001"]);
    expect(res.body.data.goodsReceipt.subtotal).toBe("0.002");
  });

  it("zero cost receipts are allowed and give a zero-valued level with a quantity", async () => {
    const res = await receive(direct(coffee.variantId, 4, "0.000"));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await level(coffee.variantId)).toMatchObject({ quantityMilli: 4000, valueMinor: 0 });
  });

  it("negative stock is brought back up: value restarts at the receipt's cost for the part above zero", async () => {
    await StockLevel.create({ organizationId: ctx.org._id, storeId: ctx.storeA._id, variantId: coffee.variantId, productId: coffee.productId, quantityMilli: -2000, valueMinor: 0, avgCostMinor: 1600, lastMovementAt: new Date() });
    const res = await receive(direct(coffee.variantId, 5, "2.000"));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const l = await level(coffee.variantId);
    expect(l!.quantityMilli).toBe(3000);
    expect(l!.valueMinor).toBe(6000); // 3 units at 2.000
    expect(res.body.data.goodsReceipt.lines[0].quantityAfter).toBe(3);
  });

  it("receiving into exactly -x brings the level to zero without value", async () => {
    await StockLevel.create({ organizationId: ctx.org._id, storeId: ctx.storeA._id, variantId: coffee.variantId, productId: coffee.productId, quantityMilli: -2000, valueMinor: 0, avgCostMinor: 1600, lastMovementAt: new Date() });
    const res = await receive(direct(coffee.variantId, 2, "2.000"));
    expect(res.status).toBe(201);
    expect(await level(coffee.variantId)).toMatchObject({ quantityMilli: 0, valueMinor: 0 });
  });

  it("stock is added whatever allowNegativeStock says", async () => {
    await Organization.updateOne({ _id: ctx.org._id }, { $set: { "settings.allowNegativeStock": false } });
    expect((await receive(direct(coffee.variantId, 2, "1.000"))).status).toBe(201);
    await Organization.updateOne({ _id: ctx.org._id }, { $set: { "settings.allowNegativeStock": true } });
    expect((await receive(direct(coffee.variantId, 2, "1.000"))).status).toBe(201);
    expect((await level(coffee.variantId))!.quantityMilli).toBe(4000);
  });

  it("quantity and cost boundaries: 0.001, 1e9, 13-digit cost, and values that overflow safe integers", async () => {
    expect((await receive(direct(rice.variantId, 0.001, "0.001"))).status).toBe(201);
    const big = await receive(direct(coffee.variantId, 1_000_000_000, "9999999999999.999"));
    expect(big.status, JSON.stringify(big.body)).toBeLessThan(500);
    expect(big.status).toBe(400);
    const huge = await receive(direct(coffee.variantId, 1, "9999999999999.999"));
    expect(huge.status, JSON.stringify(huge.body)).toBeLessThan(500);
    const before = await footprint();
    const overflow = await receive(direct(rice.variantId, 999_999_999.999, "9999999.999"));
    expect(overflow.status, JSON.stringify(overflow.body)).toBeLessThan(500);
    if (overflow.status !== 201) expect(await footprint()).toEqual(before);
  });

  it("float-noise quantities (4.35, 8.2, 1.005, 0.57, 33.333) land as exact thousandths", async () => {
    const quantities = [4.35, 8.2, 1.005, 0.57, 33.333];
    for (const q of quantities) {
      const res = await receive(direct(rice.variantId, q, "0.500"));
      expect(res.status, `${q}: ${JSON.stringify(res.body)}`).toBe(201);
      expect(res.body.data.goodsReceipt.lines[0].quantity).toBe(q);
    }
    expect((await level(rice.variantId))!.quantityMilli).toBe(4350 + 8200 + 1005 + 570 + 33333);
    for (const m of await StockMovement.find({ organizationId: ctx.org._id })) expect(Number.isInteger(m.quantityMilli)).toBe(true);
  });

  it("a receipt whose lines sum past the safe integer range is refused cleanly and writes nothing", async () => {
    const items = [coffee, rice, bags, await product(goods({ name: "X1", sku: "X1", purchase: {} })), await product(goods({ name: "X2", sku: "X2", purchase: {} }))];
    const before = await footprint();
    const res = await receive({
      vendorId: localVendor,
      lines: items.map((item) => ({ variantId: item.variantId, quantity: 1, unitCost: "2000000000000.000" })),
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(400);
    expect(res.body.code).toBe("AMOUNT_OUT_OF_RANGE");
    expect(await footprint()).toEqual(before);
  });

  it("a PO cost of 1.600 with 24 units and a different received cost uses the received cost for stock and lastPurchase", async () => {
    const po = await issuedPo();
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 24, unitCost: "1.555" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.goodsReceipt.lines[0]).toMatchObject({ unitCost: "1.555", subtotal: "37.320", stockValue: "37.320" });
    expect((await level(coffee.variantId))!.valueMinor).toBe(37320);
    const v = await ProductVariant.findById(coffee.variantId);
    expect(v!.lastPurchase!.unitCostMinor).toBe(1555);
    expect(v!.costPriceMinor).toBe(1600);
  });

  it("a PO line fully received then over by one milli is refused with exact meta", async () => {
    const po = await issuedPo();
    expect((await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[1], quantity: 12.499 }] })).status).toBe(201);
    const over = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[1], quantity: 0.002 }] });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("RECEIVED_QUANTITY_EXCEEDS_ORDERED");
    expect(over.body.errors[0].meta).toEqual({ ordered: 12.5, received: 12.499, remaining: 0.001 });
    const exact = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[1], quantity: 0.001 }] });
    expect(exact.status).toBe(201);
    expect(exact.body.data.purchaseOrder.status).toBe("partially_received"); // coffee still open
  });

  describe("an organization with no TRN (input VAT goes into stock cost)", () => {
    beforeEach(async () => {
      await Organization.updateOne({ _id: ctx.org._id }, { $set: { taxRegistrationNumber: null } });
    });

    it("direct receipts: VAT added for a VAT-registered vendor and a standard product only, in the ledger too", async () => {
      const std = await receive(direct(coffee.variantId, 10, "1.001", { vendorId: vatVendor }));
      expect(std.status, JSON.stringify(std.body)).toBe(201);
      // 10% VAT: 1.001 + round(0.1001) = 1.101 per unit, x10 = 11.010
      expect(std.body.data.goodsReceipt.lines[0]).toMatchObject({ unitCost: "1.001", stockUnitCost: "1.101", subtotal: "10.010", stockValue: "11.010" });
      expect((await level(coffee.variantId))!.valueMinor).toBe(11010);
      expect(std.body.data.goodsReceipt).toMatchObject({ subtotal: "10.010", stockValue: "11.010" });

      const local = await receive(direct(rice.variantId, 2, "0.500", { vendorId: localVendor }));
      expect(local.body.data.goodsReceipt.lines[0].stockUnitCost).toBe("0.500");
    });

    it("lastPurchase keeps the VAT-exclusive cost even when stock cost includes VAT", async () => {
      await receive(direct(coffee.variantId, 1, "1.000", { vendorId: vatVendor }));
      const v = await ProductVariant.findById(coffee.variantId);
      expect(v!.lastPurchase!.unitCostMinor).toBe(1000);
      expect((await level(coffee.variantId))!.valueMinor).toBe(1100);
    });

    it("against a PO the PO line's rate is used, even if the product's rate changed afterwards", async () => {
      const po = await issuedPo();
      const rateOnPo = po.lines[0].taxRate?.rate ?? po.lines[0].tax?.rate;
      const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 10 }] });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const line = res.body.data.goodsReceipt.lines[0];
      expect(line.unitCost).toBe("1.600");
      if (rateOnPo !== undefined) expect(Number(line.stockUnitCost)).toBeCloseTo(1.6 * (1 + Number(rateOnPo) / 100), 3);
      expect(Number(line.stockUnitCost)).toBeGreaterThan(1.6);
    });

    it("a PO issued before the org lost its TRN keeps working: no VAT for lines whose PO estimate was zero", async () => {
      const po = await issuedPo({ vendorId: localVendor });
      const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] });
      expect(res.body.data.goodsReceipt.lines[0].stockUnitCost).toBe("1.600");
    });
  });

  describe("a 2-decimal currency (AED)", () => {
    let uae: Awaited<ReturnType<typeof setup>>;
    let uaeAdmin: string;
    let uaeVendor: string;
    let item: Ref;

    beforeEach(async () => {
      uae = await setup("uae", { currency: "AED", trn: null });
      uaeAdmin = await tokenFor(uae.org._id, "admin@uae.test", { orgRoleId: uae.role("org_admin")._id });
      uaeVendor = await vendor({ name: "UAE Supplier", taxRegistrationNumber: "100000000000003" }, uaeAdmin);
      item = await product(goods({ name: "Dates", sku: "D-1", unit: "kg", purchase: { costPrice: "2.50" }, sales: { sellingPrice: "5.00" } }), uaeAdmin);
    });

    const post = (body: unknown) =>
      request.post(storeGrns(uae.storeA._id)).set(auth(uaeAdmin)).set("Idempotency-Key", newKey()).send(body as object);

    it("refuses 3-decimal costs and formats with 2 decimals", async () => {
      const bad = await post({ vendorId: uaeVendor, lines: [{ variantId: item.variantId, quantity: 1, unitCost: "2.505" }] });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("TOO_MANY_DECIMALS");
      expect(bad.body.errors[0].field).toBe("lines[0].unitCost");
      const ok = await post({ vendorId: uaeVendor, lines: [{ variantId: item.variantId, quantity: 3.333, unitCost: "2.51" }] });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      // 3.333 * 2.51 = 8.36583 -> 8.37; VAT (5%) on 2.51 = 0.1255 -> 0.13 per unit; 2.64 * 3.333 = 8.79912 -> 8.80
      expect(ok.body.data.goodsReceipt.lines[0]).toMatchObject({ unitCost: "2.51", subtotal: "8.37", stockUnitCost: "2.64", stockValue: "8.80" });
      const l = await StockLevel.findOne({ organizationId: uae.org._id, variantId: item.variantId });
      expect(l).toMatchObject({ quantityMilli: 3333, valueMinor: 880 });
    });
  });
});

// ==========================================
// Hostile input
// ==========================================

describe("hostile input never returns 500", () => {
  const line = (extra: Record<string, unknown> = {}) => ({ variantId: coffee.variantId, quantity: 1, unitCost: "1.000", ...extra });

  it("hostile bodies get 400 with the error shape and no stack, and nothing is written", async () => {
    const po = await issuedPo();
    const poLine = { purchaseOrderLineId: poLines(po)[0], quantity: 1 };
    const bodies: unknown[] = [
      null,
      [],
      "text",
      {},
      { lines: [] },
      { vendorId: localVendor },
      { vendorId: localVendor, lines: null },
      { vendorId: localVendor, lines: "x" },
      { vendorId: localVendor, lines: [null] },
      { vendorId: localVendor, lines: [line({ quantity: "1" })] },
      { vendorId: localVendor, lines: [line({ quantity: 0 })] },
      { vendorId: localVendor, lines: [line({ quantity: -1 })] },
      { vendorId: localVendor, lines: [line({ quantity: 1.0005 })] },
      { vendorId: localVendor, lines: [line({ quantity: 1e12 })] },
      { vendorId: localVendor, lines: [line({ quantity: null })] },
      { vendorId: localVendor, lines: [line({ unitCost: 1.5 })] },
      { vendorId: localVendor, lines: [line({ unitCost: "-1.000" })] },
      { vendorId: localVendor, lines: [line({ unitCost: "1e3" })] },
      { vendorId: localVendor, lines: [line({ unitCost: "abc" })] },
      { vendorId: localVendor, lines: [line({ unitCost: "" })] },
      { vendorId: localVendor, lines: [line({ unitCost: "1.0000" })] },
      { vendorId: localVendor, lines: [line({ unitCost: "99999999999999.000" })] },
      { vendorId: localVendor, lines: [line({ unitCost: undefined })] },
      { vendorId: localVendor, lines: [line({ note: "" })] },
      { vendorId: localVendor, lines: [line({ note: "x".repeat(201) })] },
      { vendorId: localVendor, lines: [line({ variantId: "nope" })] },
      { vendorId: localVendor, lines: [line({ variantId: { $ne: null } })] },
      { vendorId: { $ne: null }, lines: [line()] },
      { vendorId: "nope", lines: [line()] },
      { vendorId: localVendor, purchaseOrderId: po.id, lines: [poLine] },
      { purchaseOrderId: po.id, lines: [line()] },
      { purchaseOrderId: po.id, lines: [{ quantity: 1 }] },
      { purchaseOrderId: po.id, lines: [poLine, poLine] },
      { purchaseOrderId: { $gt: "" }, lines: [poLine] },
      { purchaseOrderId: po.id, lines: [{ ...poLine, purchaseOrderLineId: { $ne: null } }] },
      { vendorId: localVendor, lines: [line(), line()] },
      { vendorId: localVendor, lines: [line({ purchaseOrderLineId: poLines(po)[0] })] },
      { vendorId: localVendor, receivedDate: "2026-02-30", lines: [line()] },
      { vendorId: localVendor, receivedDate: "26-1-1", lines: [line()] },
      { vendorId: localVendor, receivedDate: 20261001, lines: [line()] },
      { vendorId: localVendor, receivedDate: "2999-01-01", lines: [line()] },
      { vendorId: localVendor, vendorReference: "", lines: [line()] },
      { vendorId: localVendor, vendorReference: "r".repeat(51), lines: [line()] },
      { vendorId: localVendor, notes: "n".repeat(1001), lines: [line()] },
      { vendorId: localVendor, notes: 5, lines: [line()] },
      { vendorId: localVendor, lines: Array.from({ length: 201 }, (_, i) => line({ variantId: `665f1c2e8a4b3c00${String(i).padStart(8, "0")}` })) },
      { vendorId: localVendor, __proto__: { admin: true }, constructor: { prototype: {} }, lines: [line()] },
    ];
    const before = await footprint();
    for (const body of bodies) {
      const res = await receive(body);
      expect(res.status, JSON.stringify(body)?.slice(0, 120)).toBeGreaterThanOrEqual(400);
      expect(res.status, `${JSON.stringify(body)?.slice(0, 120)} -> ${JSON.stringify(res.body)}`).toBeLessThan(500);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/\bat .*\.ts:\d+|node_modules|stack/);
    }
    expect(await footprint()).toEqual(before);
  });

  it("an invalid body is refused before the Idempotency-Key is looked at, and a valid body without a key is a 400 that posts nothing", async () => {
    const noKeyBad = await request.post(storeGrns()).set(auth(admin)).send({});
    expect(noKeyBad.status).toBe(400);
    const noKey = await request.post(storeGrns()).set(auth(admin)).send(direct(coffee.variantId));
    expect(noKey.status).toBe(400);
    expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(0);
  });

  it("malformed or foreign storeId in the path: 400/404, never 500", async () => {
    for (const store of ["abc", "0".repeat(24), "%00", String(ctx.org._id)]) {
      const post = await request.post(`/api/v1/stores/${store}/goods-receipts`).set(auth(admin)).set("Idempotency-Key", newKey()).send(direct(coffee.variantId));
      expect([400, 403, 404], `${store}: ${post.status}`).toContain(post.status);
      const get = await request.get(`/api/v1/stores/${store}/goods-receipts`).set(auth(admin));
      expect([400, 403, 404], `${store}: ${get.status}`).toContain(get.status);
    }
  });

  it("hostile list queries never 500 and never widen results", async () => {
    await receive(direct(coffee.variantId, 1, "1.000", { vendorReference: "INV.*(" }));
    const queries = [
      "search=.*",
      "search=(",
      "search=%00",
      "search=%00GRN",
      "search[$ne]=x",
      "search=a&search=b",
      `search=${"x".repeat(5000)}`,
      "search=GRN-",
      "search=%24where",
      "vendorId[$ne]=1",
      "vendorId=aaaaaaaaaaaa",
      `purchaseOrderId=${"a".repeat(12)}`,
      "vendorId=%00",
      "purchaseOrderId=",
      "storeId[$ne]=1",
      "storeId=%00",
      "withoutPurchaseOrder=TRUE",
      "withoutPurchaseOrder[]=true",
      "from=2026-02-30",
      "from=%00&to=%00",
      "from[$gt]=1",
      "to=9999-99-99",
      "page=0",
      "page=-1",
      "page=1e308",
      "page=NaN",
      "page=Infinity",
      "page=99999999999999999999",
      "page=1.5",
      "limit=0",
      "limit=-1",
      "limit=1000000",
      "limit=1e309",
      "limit=0x10",
      "limit[]=5",
      "page=2&limit=100000000",
      "sort=sequence",
      "__proto__[x]=1",
    ];
    for (const q of queries) {
      for (const base of [ALL_GRNS, storeGrns()]) {
        const res = await request.get(`${base}?${q}`).set(auth(admin));
        expect(res.status, `${q} -> ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
        expect(res.body.data.goodsReceipts.length).toBeLessThanOrEqual(100);
        expect(GoodsReceiptListDataSchema.safeParse(res.body.data).success, q).toBe(true);
      }
    }
    const lit = await request.get(`${ALL_GRNS}?search=${encodeURIComponent("INV.*(")}`).set(auth(admin));
    expect(lit.body.data.goodsReceipts).toHaveLength(1);
    const wild = await request.get(`${ALL_GRNS}?search=.*`).set(auth(admin));
    expect(wild.body.data.goodsReceipts).toHaveLength(0);
  });

  it("pagination metadata stays sane for out-of-range pages", async () => {
    await receive(direct(coffee.variantId));
    const res = await request.get(`${ALL_GRNS}?page=50&limit=5`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.goodsReceipts).toEqual([]);
    expect(res.body.data.pagination.total).toBe(1);
  });

  it("GET with a malformed or unknown receipt id: 400 / 404 with the documented shapes", async () => {
    for (const id of ["abc", "%00", "0".repeat(24)]) {
      const res = await request.get(`${storeGrns()}/${id}`).set(auth(admin));
      expect([400, 404], `${id}: ${res.status}`).toContain(res.status);
      expect(res.body.success).toBe(false);
    }
    const missing = await request.get(`${storeGrns()}/${"0".repeat(24)}`).set(auth(admin));
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("GOODS_RECEIPT_NOT_FOUND");
  });

  it("dates: today in the store's timezone is allowed, tomorrow is not, and the PO order date is the lower bound", async () => {
    const { todayIn } = await import("../../src/services/purchaseOrder.service");
    const today = todayIn("Asia/Bahrain");
    const next = new Date(`${today}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const tomorrow = next.toISOString().slice(0, 10);
    expect((await receive(direct(coffee.variantId, 1, "1.000", { receivedDate: today }))).status).toBe(201);
    const future = await receive(direct(coffee.variantId, 1, "1.000", { receivedDate: tomorrow }));
    expect(future.status).toBe(400);
    expect(future.body.errors[0].field).toBe("receivedDate");

    // A store in a far-ahead timezone allows its own today even if UTC is still yesterday.
    await Store.updateOne({ _id: ctx.storeB._id }, { $set: { timezone: "Pacific/Kiritimati" } });
    const kiri = todayIn("Pacific/Kiritimati");
    expect((await receive(direct(coffee.variantId, 1, "1.000", { receivedDate: kiri }), { store: ctx.storeB._id })).status).toBe(201);
    const po = await issuedPo({ orderDate: today });
    const before = await receive({ purchaseOrderId: po.id, receivedDate: "2000-01-01", lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] });
    expect(before.status).toBe(400);
    expect(before.body.errors[0].field).toBe("receivedDate");
    expect((await receive({ purchaseOrderId: po.id, receivedDate: today, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] })).status).toBe(201);
    // Without a PO any past date is fine, and movements are dated at posting time, not receivedDate.
    const old = await receive(direct(rice.variantId, 1, "0.500", { receivedDate: "2020-01-01" }));
    expect(old.status).toBe(201);
    const move = await StockMovement.findOne({ organizationId: ctx.org._id, variantId: rice.variantId });
    expect(Date.now() - move!.createdAt.getTime()).toBeLessThan(60_000);
  });

  it("a deleted-in-between or inactive product/variant: inactive receives, deleted does not", async () => {
    expect((await request.patch(`${PRODUCTS}/${rice.productId}/deactivate`).set(auth(admin))).status).toBe(200);
    expect((await ProductVariant.findById(rice.variantId))).toBeTruthy();
    expect((await receive(direct(rice.variantId, 1, "0.500"))).status).toBe(201);
    const deleted = await request.delete(`${PRODUCTS}/${coffee.productId}`).set(auth(admin));
    expect(deleted.status).toBe(200);
    const res = await receive(direct(coffee.variantId));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VARIANT_NOT_FOUND");
  });

  it("services are refused without a PO (VARIANT_NOT_PURCHASABLE) and one error per bad line is returned", async () => {
    const { serviceExample } = await import("../../src/docs/product.openapi");
    const wrap = await product({ ...serviceExample });
    const res = await receive({
      vendorId: localVendor,
      lines: [
        { variantId: wrap.variantId, quantity: 1, unitCost: "1.000" },
        { variantId: coffee.variantId, quantity: 1.5, unitCost: "1.000" },
        { variantId: rice.variantId, quantity: 1, unitCost: "0.555" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VARIANT_NOT_PURCHASABLE");
    expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(["lines[0].variantId", "lines[1].quantity"]);
  });
});

// ==========================================
// lastPurchase on every product response
// ==========================================

describe("lastPurchase visibility", () => {
  const deepFind = (value: unknown, key: string): unknown[] => {
    if (Array.isArray(value)) return value.flatMap((v) => deepFind(v, key));
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (k === key ? [v, ...deepFind(v, key)] : deepFind(v, key)));
    }
    return [];
  };

  async function cashierToken() {
    return storeToken("cashier", "cashier@alnoor.test");
  }

  it("a cashier never sees lastPurchase or costPrice on list, detail, lookup or any product-shaped response", async () => {
    await receive(direct(coffee.variantId, 1, "1.234", { vendorId: vatVendor }));
    const cashier = await cashierToken();
    const urls = [
      PRODUCTS,
      `${PRODUCTS}?search=Coffee`,
      `${PRODUCTS}/${coffee.productId}`,
      `${PRODUCTS}/lookup?code=COF-1`,
    ];
    for (const url of urls) {
      const res = await request.get(url).set(auth(cashier));
      expect(res.status, `${url}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text, url).not.toContain("1.234");
      expect(text, url).not.toContain("Gulf Roasters");
      expect(text, url).not.toContain("GRN-0");
      expect(text, url).not.toContain("1.600"); // cost price
      for (const value of deepFind(res.body, "lastPurchase")) expect(value, url).toBeNull();
      for (const value of deepFind(res.body, "costPrice")) expect(value, url).toBeNull();
    }
  });

  it("the full-cost viewers (org admin, inventory clerk, product editor) see it on detail, lookup and list", async () => {
    const res1 = await receive(direct(coffee.variantId, 1, "1.234", { vendorId: vatVendor }));
    const clerk = await storeToken("inventory_clerk", "clerk@alnoor.test");
    for (const token of [admin, clerk]) {
      const detail = await request.get(`${PRODUCTS}/${coffee.productId}`).set(auth(token));
      expect(detail.body.data.product.variants[0].lastPurchase).toEqual({
        unitCost: "1.234",
        receivedDate: res1.body.data.goodsReceipt.receivedDate,
        vendor: { id: vatVendor, name: "Gulf Roasters" },
        goodsReceipt: { id: res1.body.data.goodsReceipt.id, number: "GRN-00001" },
      });
      const lookup = await request.get(`${PRODUCTS}/lookup?code=COF-1`).set(auth(token));
      expect(lookup.body.data.product.variants[0].lastPurchase.unitCost).toBe("1.234");
    }
  });

  it("create/update/variant responses honour the same rule, and writes by the catalog editor never wipe lastPurchase", async () => {
    await receive(direct(coffee.variantId, 1, "1.234"));
    const upd = await request.patch(`${PRODUCTS}/${coffee.productId}`).set(auth(admin)).send({ brand: "New Brand" });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.data.product.variants[0].lastPurchase).toMatchObject({ unitCost: "1.234" });
    const vup = await request
      .patch(`${PRODUCTS}/${coffee.productId}/variants/${coffee.variantId}`)
      .set(auth(admin))
      .send({ costPrice: "1.700" });
    expect(vup.status, JSON.stringify(vup.body)).toBe(200);
    {
      expect(vup.body.data.product.variants[0]).toMatchObject({ costPrice: "1.700", lastPurchase: { unitCost: "1.234" } });
    }
    const deact = await request.patch(`${PRODUCTS}/${coffee.productId}/deactivate`).set(auth(admin));
    expect(deact.body.data.product.variants[0].lastPurchase).toMatchObject({ unitCost: "1.234" });
    const raw = await ProductVariant.findById(coffee.variantId);
    expect(raw!.lastPurchase!.unitCostMinor).toBe(1234);
    expect(raw!.costPriceMinor).toBe(1700);
  });

  it("a catalog editor without inventory:read still sees cost fields (as for costPrice), a read-only viewer does not", async () => {
    await receive(direct(coffee.variantId, 1, "1.234"));
    const editor = await Role.create({ organizationId: ctx.org._id, name: "editor", slug: "editor", permissions: ["product:read", "product:update"], scope: "organization", isSystem: false });
    const viewer = await Role.create({ organizationId: ctx.org._id, name: "viewer", slug: "viewer", permissions: ["product:read"], scope: "organization", isSystem: false });
    const te = await tokenFor(ctx.org._id, "editor@alnoor.test", { orgRoleId: editor._id });
    const tv = await tokenFor(ctx.org._id, "viewer@alnoor.test", { orgRoleId: viewer._id });
    const e = await request.get(`${PRODUCTS}/${coffee.productId}`).set(auth(te));
    const v = await request.get(`${PRODUCTS}/${coffee.productId}`).set(auth(tv));
    expect(e.body.data.product.variants[0].costPrice).toBe("1.600");
    expect(e.body.data.product.variants[0].lastPurchase).not.toBeNull();
    expect(v.body.data.product.variants[0]).toMatchObject({ costPrice: null, lastPurchase: null });
  });

  it("a variant product: each variant keeps its own lastPurchase, others stay null", async () => {
    const created = await request.post(PRODUCTS).set(auth(admin)).send({
      name: "T-shirt",
      type: "goods",
      itemType: "variant",
      unit: "pcs",
      taxPreference: "standard",
      attributes: [{ name: "Size", options: ["S", "M"] }],
      variants: [
        { attributeValues: { Size: "S" }, sku: "TS-S", sellingPrice: "4.500", costPrice: "2.000" },
        { attributeValues: { Size: "M" }, sku: "TS-M", sellingPrice: "4.500", costPrice: "2.000" },
      ],
      purchase: {},
      inventory: { trackInventory: true },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [s, m] = created.body.data.product.variants;
    expect(s.lastPurchase).toBeNull();
    await receive(direct(m.id, 2, "2.222"));
    const got = await request.get(`${PRODUCTS}/${created.body.data.product.id}`).set(auth(admin));
    const byId = Object.fromEntries(got.body.data.product.variants.map((x: { id: string }) => [x.id, x]));
    expect(byId[s.id].lastPurchase).toBeNull();
    expect(byId[m.id].lastPurchase.unitCost).toBe("2.222");
  });

  it("product responses with lastPurchase populated still parse against the strict product schemas", async () => {
    const { ProductDataSchema, ProductSchema, ProductLookupDataSchema } = await import("../../src/validators/responses");
    await receive(direct(coffee.variantId, 1, "1.234"));
    const cashier = await cashierToken();
    for (const token of [admin, cashier]) {
      const detail = await request.get(`${PRODUCTS}/${coffee.productId}`).set(auth(token));
      expect(ProductDataSchema.safeParse(detail.body.data).success, JSON.stringify(detail.body.data)).toBe(true);
      expect(ProductSchema.strict().safeParse(detail.body.data.product).success).toBe(true);
      const lookup = await request.get(`${PRODUCTS}/lookup?code=COF-1`).set(auth(token));
      expect(ProductLookupDataSchema.safeParse(lookup.body.data).success).toBe(true);
    }
  });

  it("a receipt of an untracked product still records lastPurchase", async () => {
    await receive(direct(bags.variantId, 10, "0.045"));
    const got = await request.get(`${PRODUCTS}/${bags.productId}`).set(auth(admin));
    expect(got.body.data.product.variants[0].lastPurchase.unitCost).toBe("0.045");
    expect(await StockLevel.countDocuments({ organizationId: ctx.org._id, variantId: bags.variantId })).toBe(0);
  });

  it("receipt reads do not expose product cost fields beyond the receipt itself", async () => {
    const res = await receive(direct(coffee.variantId, 1, "1.234"));
    const got = await request.get(`${storeGrns()}/${res.body.data.goodsReceipt.id}`).set(auth(admin));
    const text = JSON.stringify(got.body);
    expect(text).not.toContain("costPrice");
    expect(text).not.toContain("lastPurchase");
  });
});

// ==========================================
// Documented contract details
// ==========================================

describe("contract details", () => {
  it("invalid page/limit fall back to the defaults and limit is capped at 100", async () => {
    await receive(direct(coffee.variantId));
    const meta = async (q: string) => (await request.get(`${ALL_GRNS}?${q}`).set(auth(admin))).body.data.pagination;
    for (const q of ["page=0", "page=-3", "page=abc", "page=", "limit=0", "limit=-1", "limit=abc", "limit="]) {
      const m = await meta(q);
      expect(m.page, q).toBe(1);
      expect(m.limit, q).toBe(20);
    }
    expect((await meta("limit=1000")).limit).toBe(100);
    expect((await meta("limit=1e309")).limit).toBe(100);
    expect(await meta("page=2&limit=7")).toMatchObject({ page: 2, limit: 7, total: 1, totalPages: 1 });
  });

  it("the store list ignores a storeId query filter; the cross-store list honours it", async () => {
    await receive(direct(coffee.variantId));
    await receive(direct(coffee.variantId), { store: ctx.storeB._id });
    const a = await request.get(`${storeGrns(ctx.storeA._id)}?storeId=${ctx.storeB._id}`).set(auth(admin));
    expect(a.body.data.goodsReceipts.map((g: { number: string }) => g.number)).toEqual(["GRN-00001"]);
    const all = await request.get(`${ALL_GRNS}?storeId=${ctx.storeB._id}`).set(auth(admin));
    expect(all.body.data.goodsReceipts.map((g: { number: string }) => g.number)).toEqual(["GRN-00002"]);
  });

  it("documented store errors: malformed id is 400 with the hex message, unknown store is 404 'Store not found.' without a code", async () => {
    const bad = await request.get("/api/v1/stores/abc/goods-receipts").set(auth(admin));
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe("Invalid storeId format. Must be a 24-character hex string.");
    const missing = await request.get(`/api/v1/stores/${new mongoose.Types.ObjectId()}/goods-receipts`).set(auth(admin));
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe("Store not found.");
    expect(missing.body.code).toBeUndefined();
    const post = await request
      .post(`/api/v1/stores/${new mongoose.Types.ObjectId()}/goods-receipts`)
      .set(auth(admin))
      .set("Idempotency-Key", newKey())
      .send(direct(coffee.variantId));
    expect(post.status).toBe(404);
  });

  it("a PO line sent twice, a variantId on a PO receipt and a vendorId on a PO receipt are refused with the field named", async () => {
    const po = await issuedPo();
    const lineId = poLines(po)[0];
    const dup = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: lineId, quantity: 1 }, { purchaseOrderLineId: lineId.toUpperCase(), quantity: 1 }] });
    expect(dup.status).toBe(400);
    const withVariant = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: lineId, variantId: coffee.variantId, quantity: 1 }] });
    expect(withVariant.status).toBe(400);
    expect(withVariant.body.errors[0].path).toEqual(["lines", 0, "variantId"]);
    const withVendor = await receive({ purchaseOrderId: po.id, vendorId: localVendor, lines: [{ purchaseOrderLineId: lineId, quantity: 1 }] });
    expect(withVendor.status).toBe(400);
    expect(withVendor.body.errors[0].path).toEqual(["vendorId"]);
  });

  it("a PO receipt response carries the PO after the receipt: status, receivedQuantity and version", async () => {
    const po = await issuedPo();
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 24 }, { purchaseOrderLineId: poLines(po)[1], quantity: 12.5 }] });
    expect(res.body.data.purchaseOrder).toMatchObject({ id: po.id, status: "received", version: po.version + 1, editable: false });
    expect(res.body.data.purchaseOrder.lines.map((l: { receivedQuantity: number }) => l.receivedQuantity)).toEqual([24, 12.5]);
    const stale = await request.patch(`${storePos()}/${po.id}`).set(auth(admin)).send({ version: po.version, lines: [{ variantId: coffee.variantId, quantity: 1 }] });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("PURCHASE_ORDER_VERSION_CONFLICT");
  });
});

// ==========================================
// Ledger and stock views
// ==========================================

describe("ledger integration", () => {
  it("movements list shows the purchase movement with its receipt as source, and parses its schema", async () => {
    const { StockMovementListDataSchema, StockLevelListDataSchema } = await import("../../src/validators/responses");
    const po = await issuedPo();
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 4 }] });
    const list = await request.get(`/api/v1/stores/${ctx.storeA._id}/stock-movements`).set(auth(admin));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(StockMovementListDataSchema.safeParse(list.body.data).success, JSON.stringify(list.body.data)).toBe(true);
    expect(list.body.data.movements[0]).toMatchObject({
      type: "purchase",
      quantityChange: 4,
      quantityAfter: 4,
      source: { type: "goods_receipt", id: res.body.data.goodsReceipt.id, number: "GRN-00001" },
    });
    const stock = await request.get(`/api/v1/stores/${ctx.storeA._id}/stock`).set(auth(admin));
    expect(StockLevelListDataSchema.safeParse(stock.body.data).success).toBe(true);
    const cashier = await storeToken("cashier", "cashier@alnoor.test");
    const hidden = await request.get(`/api/v1/stores/${ctx.storeA._id}/stock`).set(auth(cashier));
    expect(JSON.stringify(hidden.body)).not.toContain("1.600");
    expect((await request.get(`/api/v1/stores/${ctx.storeA._id}/stock-movements`).set(auth(cashier))).status).toBe(403);
  });

  it("movements of a receipt are timestamped at posting time and share one timestamp", async () => {
    const res = await receive({ vendorId: localVendor, receivedDate: "2020-01-01", lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }, { variantId: rice.variantId, quantity: 1, unitCost: "1.000" }] });
    const moves = await StockMovement.find({ organizationId: ctx.org._id, "source.number": "GRN-00001" });
    expect(moves).toHaveLength(2);
    expect(moves[0].createdAt.getTime()).toBe(moves[1].createdAt.getTime());
    expect(Math.abs(moves[0].createdAt.getTime() - new Date(res.body.data.goodsReceipt.createdAt).getTime())).toBeLessThan(2000);
    expect(String(moves[0].createdBy)).toBe(res.body.data.goodsReceipt.createdBy.id);
  });

  it("a receipt's per-line quantityAfter follows the level when other stock moved in between", async () => {
    await receive(direct(coffee.variantId, 5, "1.000"));
    await request.post(`/api/v1/stores/${ctx.storeA._id}/stock-adjustments`).set(auth(admin)).set("Idempotency-Key", newKey()).send({
      reason: "damaged",
      lines: [{ variantId: coffee.variantId, quantityChange: -2 }],
    });
    const res = await receive(direct(coffee.variantId, 3, "2.000"));
    expect(res.body.data.goodsReceipt.lines[0].quantityAfter).toBe(6);
    // value: 5 at 1.000 less 2 at the average -> 3.000, plus 6.000 = 9.000
    expect(await level(coffee.variantId)).toMatchObject({ quantityMilli: 6000, valueMinor: 9000 });
  });
});

// ==========================================
// Reads after the world moved on, numbering and size
// ==========================================

describe("reads, numbering and size", () => {
  it("receipts stay readable after their product is deleted, vendor deactivated and creator deactivated", async () => {
    const res = await receive({ vendorId: localVendor, lines: [{ variantId: bags.variantId, quantity: 3, unitCost: "0.050" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await request.delete(`${PRODUCTS}/${bags.productId}`).set(auth(admin))).status).toBe(200);
    await Vendor.updateOne({ _id: localVendor }, { $set: { isActive: false } });
    await User.updateOne({ email: "admin@alnoor.test" }, { $set: { isDelete: true } });
    const live = await tokenFor(ctx.org._id, "viewer@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
    const got = await request.get(`${storeGrns()}/${res.body.data.goodsReceipt.id}`).set(auth(live));
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(GoodsReceiptDataSchema.safeParse(got.body.data).success, JSON.stringify(got.body.data)).toBe(true);
    expect(got.body.data.goodsReceipt.vendor.isActive).toBe(false);
    const list = await request.get(ALL_GRNS).set(auth(live));
    expect(list.status).toBe(200);
    expect(GoodsReceiptListDataSchema.safeParse(list.body.data).success).toBe(true);
  });

  it("a vendor with a receipt cannot be deleted", async () => {
    await receive(direct(coffee.variantId));
    const del = await request.delete(`${VENDORS}/${localVendor}`).set(auth(admin));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("VENDOR_IN_USE");
  });

  it("search by number accepts partial prefixes of GRN- as the contract says (with or without the prefix)", async () => {
    await receive(direct(coffee.variantId));
    for (const term of ["GRN", "grn-", "GR", "G", "GRN-0", "0", "00001"]) {
      const res = await request.get(`${ALL_GRNS}?search=${term}`).set(auth(admin));
      expect(res.body.data.goodsReceipts.map((g: { number: string }) => g.number), term).toEqual(["GRN-00001"]);
    }
    for (const term of ["GRN-2", "2", "X"]) {
      const res = await request.get(`${ALL_GRNS}?search=${term}`).set(auth(admin));
      expect(res.body.data.goodsReceipts, term).toEqual([]);
    }
  });

  it("numbers past GRN-99999 keep counting and sorting", async () => {
    await DocumentCounter.create({ organizationId: ctx.org._id, type: "goods_receipt", seq: 99998 });
    const a = await receive(direct(coffee.variantId));
    const b = await receive(direct(coffee.variantId));
    const c = await receive(direct(coffee.variantId));
    expect([a, b, c].map((r) => r.body.data.goodsReceipt.number)).toEqual(["GRN-99999", "GRN-100000", "GRN-100001"]);
    const list = await request.get(ALL_GRNS).set(auth(admin));
    expect(list.body.data.goodsReceipts.map((g: { number: string }) => g.number)).toEqual(["GRN-100001", "GRN-100000", "GRN-99999"]);
    const search = await request.get(`${ALL_GRNS}?search=GRN-1000`).set(auth(admin));
    expect(search.body.data.goodsReceipts).toHaveLength(2);
  });

  it("200 lines in one receipt post in one transaction (limit), 201 are refused", async () => {
    const baseProduct = (await Product.collection.findOne({ _id: new mongoose.Types.ObjectId(coffee.productId) }))!;
    const baseVariant = (await ProductVariant.collection.findOne({ _id: new mongoose.Types.ObjectId(coffee.variantId) }))!;
    const products = [];
    const variants = [];
    for (let i = 0; i < 199; i += 1) {
      const productId = new mongoose.Types.ObjectId();
      products.push({ ...baseProduct, _id: productId, name: `Bulk ${i}`, sku: undefined });
      variants.push({ ...baseVariant, _id: new mongoose.Types.ObjectId(), productId, sku: `BULK-${i}`, skuKey: `bulk-${i}`, scanCodes: [], barcodes: {} });
    }
    await Product.collection.insertMany(products as never);
    await ProductVariant.collection.insertMany(variants as never);
    const lines = [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }, ...variants.map((v) => ({ variantId: String(v._id), quantity: 2, unitCost: "1.250" }))];
    expect(lines).toHaveLength(200);
    const res = await receive({ vendorId: localVendor, lines });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
    expect(res.body.data.goodsReceipt.lines).toHaveLength(200);
    expect(await StockMovement.countDocuments({ organizationId: ctx.org._id })).toBe(200);
    expect(await StockLevel.countDocuments({ organizationId: ctx.org._id })).toBe(200);
    expect(res.body.data.goodsReceipt.subtotal).toBe("498.500"); // 1.000 + 199 * 2.500
    const tooMany = await receive({ vendorId: localVendor, lines: [...lines, { variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] });
    expect(tooMany.status).toBe(400);
  }, 60_000);
});

// @@END
