/**
 * Purpose: Phase 3c goods receipts over HTTP: receiving against a PO (partial, complete, over-
 * receipt, a PO edited since it was loaded), receipts without a PO, stock and average cost, input
 * VAT in the cost for an organization with no TRN, untracked goods, the last purchase cost,
 * idempotency, concurrent receipts, dates, permissions (purchase:receive vs purchase:order), a
 * deactivated store, the lists and their filters, and the PO / vendor rules receiving changes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Vendor } from "../../src/models/vendor.model";
import { StockLevel } from "../../src/models/stockLevel.model";
import { StockMovement } from "../../src/models/stockMovement.model";
import { GoodsReceipt } from "../../src/models/goodsReceipt.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { todayIn } from "../../src/services/purchaseOrder.service";
import { singleExample, serviceExample } from "../../src/docs/product.openapi";

const PRODUCTS = "/api/v1/products";
const VENDORS = "/api/v1/vendors";
const ALL_GRNS = "/api/v1/goods-receipts";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let keySeq = 0;
const newKey = () => `grn-key-${Date.now()}-${(keySeq += 1)}`;

async function setup(slug: string, trn: string | null = "220000111100003") {
  const org = await Organization.create({
    name: slug,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    taxRegistrationNumber: trn,
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
let coffee: { variantId: string; productId: string }; // standard-rated, cost price 1.600, tracked
let rice: { variantId: string; productId: string }; // kg, decimals allowed, cost 0.500
let bags: { variantId: string; productId: string }; // untracked goods, cost 0.050
let wrap: { variantId: string; productId: string }; // a service

const storeGrns = (storeId: unknown = ctx.storeA._id) => `/api/v1/stores/${storeId}/goods-receipts`;
const storePos = (storeId: unknown = ctx.storeA._id) => `/api/v1/stores/${storeId}/purchase-orders`;

async function product(body: Record<string, unknown>) {
  const res = await request.post(PRODUCTS).set(auth(admin)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { variantId: res.body.data.product.variants[0].id as string, productId: res.body.data.product.id as string };
}

async function vendor(body: Record<string, unknown>): Promise<string> {
  const res = await request.post(VENDORS).set(auth(admin)).send(body);
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
  bags = await product(
    goods({ name: "Bags", sku: "BAG-1", purchase: { costPrice: "0.050" }, inventory: { trackInventory: false } })
  );
  wrap = await product({ ...serviceExample });
}

beforeEach(async () => {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
  await seedCatalog();
});

/** An issued PO in store A: 24 coffee and 12.5 kg rice from the VAT-registered vendor. */
async function issuedPo(body: Record<string, unknown> = {}, storeId: unknown = ctx.storeA._id) {
  const created = await request
    .post(storePos(storeId))
    .set(auth(admin))
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
  const issued = await request.post(`${storePos(storeId)}/${po.id}/issue`).set(auth(admin)).send({ version: po.version });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data.purchaseOrder;
}

const receive = (body: Record<string, unknown>, opts: { token?: string; store?: unknown; key?: string } = {}) =>
  request
    .post(storeGrns(opts.store))
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send(body);

const poLines = (po: { lines: { id: string }[] }) => po.lines.map((line) => line.id);

async function level(variantId: string, storeId: unknown = ctx.storeA._id) {
  return StockLevel.findOne({ organizationId: ctx.org._id, storeId, variantId });
}

// ==========================================
// Against a purchase order
// ==========================================

describe("receive against a purchase order", () => {
  it("receives part of a PO: stock, movements, PO progress and the response", async () => {
    const po = await issuedPo();
    const [coffeeLine, riceLine] = poLines(po);
    const res = await receive({
      purchaseOrderId: po.id,
      receivedDate: "2026-10-05",
      vendorReference: "DN-55120",
      notes: "Two cartons crushed",
      lines: [
        { purchaseOrderLineId: coffeeLine, quantity: 24 },
        { purchaseOrderLineId: riceLine, quantity: 6.25, note: "Rest next week" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.message).toBe("Goods received successfully.");
    const grn = res.body.data.goodsReceipt;
    expect(grn).toMatchObject({
      number: "GRN-00001",
      receivedDate: "2026-10-05",
      vendorReference: "DN-55120",
      notes: "Two cartons crushed",
      purchaseOrder: { id: po.id, number: po.number },
      subtotal: "41.525",
      stockValue: "41.525",
    });
    expect(grn.vendor).toMatchObject({ id: vatVendor, name: "Gulf Roasters", vatTreatment: "vat_registered", isActive: true });
    expect(grn.store).toMatchObject({ name: "Store 1" });
    expect(grn.lines).toHaveLength(2);
    expect(grn.lines[0]).toMatchObject({
      purchaseOrderLineId: coffeeLine,
      quantity: 24,
      unitCost: "1.600",
      subtotal: "38.400",
      stockUnitCost: "1.600",
      stockValue: "38.400",
      stocked: true,
      quantityAfter: 24,
      note: null,
    });
    expect(grn.lines[0].variant).toMatchObject({ id: coffee.variantId, name: "Coffee" });
    expect(grn.lines[1]).toMatchObject({ quantity: 6.25, unitCost: "0.500", subtotal: "3.125", quantityAfter: 6.25, note: "Rest next week" });

    const updatedPo = res.body.data.purchaseOrder;
    expect(updatedPo).toMatchObject({ id: po.id, status: "partially_received", version: po.version + 1, editable: false });
    expect(updatedPo.lines.map((line: { receivedQuantity: number }) => line.receivedQuantity)).toEqual([24, 6.25]);
    expect(poLines(updatedPo)).toEqual(poLines(po));

    expect(await level(coffee.variantId)).toMatchObject({ quantityMilli: 24000, valueMinor: 38400, avgCostMinor: 1600 });
    const movements = await StockMovement.find({ organizationId: ctx.org._id, "source.type": "goods_receipt" });
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({ type: "purchase", source: { number: "GRN-00001" } });
  });

  it("defaults receivedDate to today in the store's timezone", async () => {
    const po = await issuedPo();
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.goodsReceipt.receivedDate).toBe(todayIn("Asia/Bahrain"));
  });

  it("completes the PO over several receipts, then refuses another", async () => {
    const po = await issuedPo();
    const [coffeeLine, riceLine] = poLines(po);
    expect((await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: coffeeLine, quantity: 24 }] })).status).toBe(201);
    const second = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: riceLine, quantity: 12.5 }] });
    expect(second.status).toBe(201);
    expect(second.body.data.goodsReceipt.number).toBe("GRN-00002");
    expect(second.body.data.purchaseOrder.status).toBe("received");

    const third = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: riceLine, quantity: 1 }] });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe("PURCHASE_ORDER_STATUS_CONFLICT");
    expect(third.body.errors[0].meta).toEqual({ status: "received", allowed: ["issued", "partially_received"] });
  });

  it("refuses more than was ordered, one error per line, and writes nothing", async () => {
    const po = await issuedPo();
    const [coffeeLine, riceLine] = poLines(po);
    await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: riceLine, quantity: 6.25 }] });
    const res = await receive({
      purchaseOrderId: po.id,
      lines: [
        { purchaseOrderLineId: coffeeLine, quantity: 25 },
        { purchaseOrderLineId: riceLine, quantity: 6.5 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RECEIVED_QUANTITY_EXCEEDS_ORDERED");
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors[1]).toMatchObject({
      field: "lines[1].quantity",
      code: "RECEIVED_QUANTITY_EXCEEDS_ORDERED",
      meta: { ordered: 12.5, received: 6.25, remaining: 6.25 },
    });
    expect(await level(coffee.variantId)).toBeNull();
    expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(1);
  });

  it("refuses a PO line id that is no longer on the PO (edited since loaded)", async () => {
    const po = await issuedPo();
    const edited = await request
      .patch(`${storePos()}/${po.id}`)
      .set(auth(admin))
      .send({ version: po.version, lines: [{ variantId: coffee.variantId, quantity: 30 }] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);

    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PURCHASE_ORDER_CHANGED");
    expect(res.body.errors[0].field).toBe("lines[0].purchaseOrderLineId");
  });

  it("locks the PO after the first receipt: edit and cancel are refused, close works", async () => {
    const po = await issuedPo();
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] });
    const after = res.body.data.purchaseOrder;

    const edit = await request.patch(`${storePos()}/${po.id}`).set(auth(admin)).send({ version: after.version, notes: "x" });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("PURCHASE_ORDER_STATUS_CONFLICT");
    const stale = await request.patch(`${storePos()}/${po.id}`).set(auth(admin)).send({ version: po.version, notes: "x" });
    expect(stale.body.code).toBe("PURCHASE_ORDER_VERSION_CONFLICT");
    const cancel = await request.post(`${storePos()}/${po.id}/cancel`).set(auth(admin)).send({ version: after.version });
    expect(cancel.status).toBe(409);
    const close = await request.post(`${storePos()}/${po.id}/close`).set(auth(admin)).send({ version: after.version, reason: "Rest unavailable" });
    expect(close.status, JSON.stringify(close.body)).toBe(200);

    const closed = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] });
    expect(closed.body.code).toBe("PURCHASE_ORDER_STATUS_CONFLICT");
  });

  it("refuses a draft, a cancelled PO, and a PO of another store or organization", async () => {
    const draft = (
      await request
        .post(storePos())
        .set(auth(admin))
        .set("Idempotency-Key", newKey())
        .send({ vendorId: vatVendor, lines: [{ variantId: coffee.variantId, quantity: 1 }] })
    ).body.data.purchaseOrder;
    const res = await receive({ purchaseOrderId: draft.id, lines: [{ purchaseOrderLineId: poLines(draft)[0], quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.errors[0].meta.status).toBe("draft");

    const po = await issuedPo();
    await request.post(`${storePos()}/${po.id}/cancel`).set(auth(admin)).send({ version: po.version });
    const cancelled = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] });
    expect(cancelled.body.errors[0].meta.status).toBe("cancelled");

    const other = await issuedPo({}, ctx.storeB._id);
    const wrongStore = await receive({ purchaseOrderId: other.id, lines: [{ purchaseOrderLineId: poLines(other)[0], quantity: 1 }] });
    expect(wrongStore.status).toBe(404);
    expect(wrongStore.body.code).toBe("PURCHASE_ORDER_NOT_FOUND");
    expect(wrongStore.body.errors[0].field).toBe("purchaseOrderId");
  });

  it("receives an issued PO whose vendor was deactivated since", async () => {
    const po = await issuedPo();
    await request.patch(`${VENDORS}/${vatVendor}`).set(auth(admin)).send({ isActive: false });
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.goodsReceipt.vendor).toMatchObject({ name: "Gulf Roasters", isActive: false });
  });

  it("uses a different unit cost when sent, and the average cost follows it", async () => {
    const po = await issuedPo();
    await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 12 }] });
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 12, unitCost: "1.800" }] });
    expect(res.status).toBe(201);
    expect(res.body.data.goodsReceipt.lines[0]).toMatchObject({ unitCost: "1.800", subtotal: "21.600", quantityAfter: 24 });
    expect(await level(coffee.variantId)).toMatchObject({ quantityMilli: 24000, valueMinor: 40800, avgCostMinor: 1700 });
  });

  it("checks whole units again: a unit changed to pcs after the PO was issued needs whole quantities", async () => {
    const po = await issuedPo();
    const changed = await request.patch(`${PRODUCTS}/${rice.productId}`).set(auth(admin)).send({ unit: "pcs" });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[1], quantity: 2.5 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors[0].field).toBe("lines[0].quantity");
  });

  it("refuses dates in the future or before the PO's order date", async () => {
    const po = await issuedPo();
    const line = [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }];
    const future = await receive({ purchaseOrderId: po.id, receivedDate: "2999-01-01", lines: line });
    expect(future.status).toBe(400);
    expect(future.body.errors[0].field).toBe("receivedDate");
    const early = await receive({ purchaseOrderId: po.id, receivedDate: "2026-09-30", lines: line });
    expect(early.status).toBe(400);
    expect(early.body.errors[0].field).toBe("receivedDate");
  });
});

// ==========================================
// Without a purchase order
// ==========================================

describe("receive without a purchase order", () => {
  it("receives goods from an active vendor and counts the document on the vendor", async () => {
    const res = await receive({
      vendorId: localVendor,
      vendorReference: "INV-88231",
      lines: [
        { variantId: coffee.variantId, quantity: 12, unitCost: "1.550" },
        { variantId: rice.variantId, quantity: 0.75, unitCost: "0.480" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.purchaseOrder).toBeNull();
    const grn = res.body.data.goodsReceipt;
    expect(grn).toMatchObject({ purchaseOrder: null, vendorReference: "INV-88231", subtotal: "18.960" });
    expect(grn.vendor).toMatchObject({ id: localVendor, name: "Corner Supplier", vatTreatment: "not_registered" });
    expect(grn.lines[0]).toMatchObject({ purchaseOrderLineId: null, unitCost: "1.550", subtotal: "18.600", quantityAfter: 12 });
    expect(grn.lines[1]).toMatchObject({ quantity: 0.75, subtotal: "0.360" });
    expect((await Vendor.findById(localVendor))!.purchaseDocumentCount).toBe(1);

    const del = await request.delete(`${VENDORS}/${localVendor}`).set(auth(admin));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("VENDOR_IN_USE");
  });

  it("refuses an unknown or deactivated vendor", async () => {
    const lines = [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }];
    const unknown = await receive({ vendorId: "665f1c2e8a4b3c0012ab3999", lines });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("VENDOR_NOT_FOUND");
    await request.patch(`${VENDORS}/${localVendor}`).set(auth(admin)).send({ isActive: false });
    const inactive = await receive({ vendorId: localVendor, lines });
    expect(inactive.body.code).toBe("VENDOR_INACTIVE");
    expect((await Vendor.findById(localVendor))!.purchaseDocumentCount).toBe(0);
  });

  it("collects line problems: unknown variant, a service, fractional pcs", async () => {
    const res = await receive({
      vendorId: localVendor,
      lines: [
        { variantId: "665f1c2e8a4b3c0012ab3999", quantity: 1, unitCost: "1.000" },
        { variantId: wrap.variantId, quantity: 1, unitCost: "1.000" },
        { variantId: coffee.variantId, quantity: 1.5, unitCost: "1.000" },
        { variantId: rice.variantId, quantity: 1, unitCost: "1.000" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VARIANT_NOT_FOUND");
    expect(res.body.errors.map((e: { code: string }) => e.code)).toEqual([
      "VARIANT_NOT_FOUND",
      "VARIANT_NOT_PURCHASABLE",
      "VALIDATION_FAILED",
    ]);
    expect(res.body.errors[2].field).toBe("lines[2].quantity");
    // The vendor claim rolled back with the rest.
    expect((await Vendor.findById(localVendor))!.purchaseDocumentCount).toBe(0);
  });

  it("records untracked goods without moving stock", async () => {
    const res = await receive({ vendorId: localVendor, lines: [{ variantId: bags.variantId, quantity: 500, unitCost: "0.040" }] });
    expect(res.status).toBe(201);
    expect(res.body.data.goodsReceipt.lines[0]).toMatchObject({ stocked: false, quantityAfter: null, subtotal: "20.000" });
    expect(await level(bags.variantId)).toBeNull();
    expect(await StockMovement.countDocuments({ organizationId: ctx.org._id })).toBe(0);
  });

  it("brings negative stock back up; the average restarts at the receipt's cost", async () => {
    await Organization.updateOne({ _id: ctx.org._id }, { $set: { "settings.inventory.allowNegativeStock": true } });
    const out = await request
      .post(`/api/v1/stores/${ctx.storeA._id}/stock-adjustments`)
      .set(auth(admin))
      .set("Idempotency-Key", newKey())
      .send({ reason: "damaged", lines: [{ variantId: coffee.variantId, quantityChange: -4 }] });
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const res = await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 10, unitCost: "2.000" }] });
    expect(res.body.data.goodsReceipt.lines[0].quantityAfter).toBe(6);
    expect(await level(coffee.variantId)).toMatchObject({ quantityMilli: 6000, avgCostMinor: 2000, valueMinor: 12000 });
  });
});

// ==========================================
// Costs
// ==========================================

describe("stock cost for an organization with no TRN", () => {
  beforeEach(async () => {
    await Organization.updateOne({ _id: ctx.org._id }, { $set: { taxRegistrationNumber: null } });
  });

  it("adds the PO line's VAT to the stock cost for a VAT-registered vendor and a standard product", async () => {
    const po = await issuedPo();
    const res = await receive({
      purchaseOrderId: po.id,
      lines: [
        { purchaseOrderLineId: poLines(po)[0], quantity: 10 },
        { purchaseOrderLineId: poLines(po)[1], quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);
    const grn = res.body.data.goodsReceipt;
    expect(grn.lines[0]).toMatchObject({ unitCost: "1.600", subtotal: "16.000", stockUnitCost: "1.760", stockValue: "17.600" });
    expect(grn).toMatchObject({ subtotal: "16.500", stockValue: "18.150" });
    expect(await level(coffee.variantId)).toMatchObject({ valueMinor: 17600, avgCostMinor: 1760 });
  });

  it("adds no VAT for a vendor that is not VAT-registered, or a zero-rated product", async () => {
    const water = await product(goods({ name: "Water", sku: "WAT-1", taxPreference: "zero_rated", purchase: { costPrice: "0.100" } }));
    const local = await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] });
    expect(local.body.data.goodsReceipt.lines[0].stockUnitCost).toBe("1.000");
    const zero = await receive({ vendorId: vatVendor, lines: [{ variantId: water.variantId, quantity: 1, unitCost: "0.100" }] });
    expect(zero.body.data.goodsReceipt.lines[0].stockUnitCost).toBe("0.100");
    const standard = await receive({ vendorId: vatVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] });
    expect(standard.body.data.goodsReceipt.lines[0].stockUnitCost).toBe("1.100");
  });
});

describe("last purchase cost", () => {
  it("shows the newest receipt on the product, without touching the cost price", async () => {
    const before = await request.get(`${PRODUCTS}/${coffee.productId}`).set(auth(admin));
    expect(before.body.data.product.variants[0].lastPurchase).toBeNull();

    await receive({ vendorId: localVendor, receivedDate: "2026-10-02", lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.500" }] });
    const second = await receive({ vendorId: vatVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.650" }] });

    const res = await request.get(`${PRODUCTS}/${coffee.productId}`).set(auth(admin));
    const variant = res.body.data.product.variants[0];
    expect(variant.costPrice).toBe("1.600");
    expect(variant.lastPurchase).toEqual({
      unitCost: "1.650",
      receivedDate: todayIn("Asia/Bahrain"),
      vendor: { id: vatVendor, name: "Gulf Roasters" },
      goodsReceipt: { id: second.body.data.goodsReceipt.id, number: "GRN-00002" },
    });
  });

  it("is hidden from callers who cannot see cost prices", async () => {
    await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.500" }] });
    const cashier = await tokenFor(ctx.org._id, "cashier@alnoor.test", {
      storeAccess: [{ storeId: ctx.storeA._id, roleId: ctx.role("cashier")._id }],
    });
    const res = await request.get(`${PRODUCTS}/${coffee.productId}`).set(auth(cashier));
    expect(res.status).toBe(200);
    expect(res.body.data.product.variants[0]).toMatchObject({ costPrice: null, lastPurchase: null });
  });
});

// ==========================================
// Idempotency and concurrency
// ==========================================

describe("idempotency and concurrency", () => {
  it("replays a retried request without adding stock twice", async () => {
    const po = await issuedPo();
    const body = { purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 5 }] };
    const key = newKey();
    const first = await receive(body, { key });
    const again = await receive(body, { key });
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(await level(coffee.variantId)).toMatchObject({ quantityMilli: 5000 });

    const reused = await receive({ ...body, notes: "different" }, { key });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("requires an Idempotency-Key", async () => {
    const res = await request
      .post(storeGrns())
      .set(auth(admin))
      .send({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("two receipts of the same PO at once never receive more than ordered", async () => {
    const po = await issuedPo();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 10 }] }))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "RECEIVED_QUANTITY_EXCEEDS_ORDERED")).toBe(true);
    const numbers = results.filter((r) => r.status === 201).map((r) => r.body.data.goodsReceipt.number).sort();
    expect(numbers).toEqual(["GRN-00001", "GRN-00002"]);
    expect(await level(coffee.variantId)).toMatchObject({ quantityMilli: 20000 });
    const current = await request.get(`${storePos()}/${po.id}`).set(auth(admin));
    expect(current.body.data.purchaseOrder.lines[0].receivedQuantity).toBe(20);
    expect(current.body.data.purchaseOrder.version).toBe(po.version + 2);
  });
});

// ==========================================
// Permissions
// ==========================================

describe("permissions", () => {
  const storeToken = (slug: string, email: string, storeId: unknown = ctx.storeA._id) =>
    tokenFor(ctx.org._id, email, { storeAccess: [{ storeId, roleId: ctx.role(slug)._id }] });

  it("an inventory clerk receives against a PO at the PO's costs", async () => {
    const clerk = await storeToken("inventory_clerk", "clerk@alnoor.test");
    const po = await issuedPo();
    const res = await receive({ purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1, unitCost: "1.600" }] }, { token: clerk });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("an inventory clerk cannot change the cost or receive without a PO", async () => {
    const clerk = await storeToken("inventory_clerk", "clerk@alnoor.test");
    const po = await issuedPo();
    const cost = await receive(
      { purchaseOrderId: po.id, lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }, { purchaseOrderLineId: poLines(po)[1], quantity: 1, unitCost: "0.600" }] },
      { token: clerk }
    );
    expect(cost.status).toBe(403);
    expect(cost.body.message).toContain("purchase:order");
    expect(cost.body.errors[0].field).toBe("lines[1].unitCost");

    const direct = await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] }, { token: clerk });
    expect(direct.status).toBe(403);
    expect(direct.body.errors[0].field).toBe("vendorId");
    expect(await GoodsReceipt.countDocuments({ organizationId: ctx.org._id })).toBe(0);
  });

  it("a store manager receives without a PO in their store only", async () => {
    const manager = await storeToken("store_manager", "manager@alnoor.test");
    const body = { vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] };
    expect((await receive(body, { token: manager })).status).toBe(201);
    expect((await receive(body, { token: manager, store: ctx.storeB._id })).status).toBe(403);
  });

  it("an accountant reads receipts but cannot receive; a cashier can do neither", async () => {
    await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] });
    const accountant = await tokenFor(ctx.org._id, "acc@alnoor.test", { orgRoleId: ctx.role("accountant")._id });
    expect((await request.get(storeGrns()).set(auth(accountant))).status).toBe(200);
    const post = await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] }, { token: accountant });
    expect(post.status).toBe(403);
    expect(post.body.message).toContain("purchase:receive");

    const cashier = await storeToken("cashier", "cashier@alnoor.test");
    expect((await request.get(storeGrns()).set(auth(cashier))).status).toBe(403);
    expect((await request.get(ALL_GRNS).set(auth(cashier))).status).toBe(403);
  });

  it("a deactivated store's receipts can be read but no goods received", async () => {
    const res = await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] });
    await Store.updateOne({ _id: ctx.storeA._id }, { $set: { isActive: false } });
    expect((await request.get(storeGrns()).set(auth(admin))).status).toBe(200);
    expect((await request.get(`${storeGrns()}/${res.body.data.goodsReceipt.id}`).set(auth(admin))).status).toBe(200);
    const refused = await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] });
    expect(refused.status).toBe(403);
  });
});

// ==========================================
// Reads
// ==========================================

describe("read and list", () => {
  it("gets one receipt in its store; other stores and organizations see 404", async () => {
    const created = (await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] })).body.data
      .goodsReceipt;
    const res = await request.get(`${storeGrns()}/${created.id}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ goodsReceipt: created, purchaseOrder: null });

    const wrongStore = await request.get(`${storeGrns(ctx.storeB._id)}/${created.id}`).set(auth(admin));
    expect(wrongStore.status).toBe(404);
    expect(wrongStore.body.code).toBe("GOODS_RECEIPT_NOT_FOUND");
    expect((await request.get(`${storeGrns()}/abc`).set(auth(admin))).status).toBe(400);

    const other = await setup("other");
    const otherAdmin = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    const cross = await request.get(`${storeGrns(other.storeA._id)}/${created.id}`).set(auth(otherAdmin));
    expect(cross.status).toBe(404);
  });

  it("lists newest first with filters, search and paging", async () => {
    const po = await issuedPo();
    await receive({ purchaseOrderId: po.id, receivedDate: "2026-10-03", vendorReference: "DN-1", lines: [{ purchaseOrderLineId: poLines(po)[0], quantity: 1 }] });
    await receive({ vendorId: localVendor, receivedDate: "2026-10-10", vendorReference: "INV-9", lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] });
    await receive({ vendorId: localVendor, lines: [{ variantId: rice.variantId, quantity: 1, unitCost: "0.500" }] }, { store: ctx.storeB._id });

    const numbers = async (url: string) => {
      const res = await request.get(url).set(auth(admin));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.data.goodsReceipts.map((grn: { number: string }) => grn.number);
    };
    expect(await numbers(ALL_GRNS)).toEqual(["GRN-00003", "GRN-00002", "GRN-00001"]);
    expect(await numbers(storeGrns())).toEqual(["GRN-00002", "GRN-00001"]);
    expect(await numbers(`${ALL_GRNS}?storeId=${ctx.storeB._id}`)).toEqual(["GRN-00003"]);
    expect(await numbers(`${ALL_GRNS}?vendorId=${vatVendor}`)).toEqual(["GRN-00001"]);
    expect(await numbers(`${ALL_GRNS}?purchaseOrderId=${po.id}`)).toEqual(["GRN-00001"]);
    expect(await numbers(`${ALL_GRNS}?withoutPurchaseOrder=true`)).toEqual(["GRN-00003", "GRN-00002"]);
    expect(await numbers(`${storeGrns()}?from=2026-10-04&to=2026-10-31`)).toEqual(["GRN-00002"]);
    expect(await numbers(`${ALL_GRNS}?search=00001`)).toEqual(["GRN-00001"]);
    expect(await numbers(`${ALL_GRNS}?search=0001`)).toEqual([]); // GRN-00010 to GRN-00019
    expect(await numbers(`${ALL_GRNS}?search=grn-00002`)).toEqual(["GRN-00002"]);
    expect(await numbers(`${ALL_GRNS}?search=inv`)).toEqual(["GRN-00002"]);
    expect(await numbers(`${ALL_GRNS}?vendorId=bad`)).toEqual([]);
    expect(await numbers(`${ALL_GRNS}?from=nope&limit=abc`)).toHaveLength(3);

    const page = await request.get(`${ALL_GRNS}?limit=1&page=2`).set(auth(admin));
    expect(page.body.data.goodsReceipts[0]).toMatchObject({ number: "GRN-00002", lineCount: 1, purchaseOrder: null });
    expect(page.body.data.pagination).toMatchObject({ total: 3 });
  });

  it("narrows the cross-store list to the caller's stores", async () => {
    await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] });
    await receive({ vendorId: localVendor, lines: [{ variantId: coffee.variantId, quantity: 1, unitCost: "1.000" }] }, { store: ctx.storeB._id });
    const clerk = await tokenFor(ctx.org._id, "clerk@alnoor.test", {
      storeAccess: [{ storeId: ctx.storeB._id, roleId: ctx.role("inventory_clerk")._id }],
    });
    const res = await request.get(ALL_GRNS).set(auth(clerk));
    expect(res.status).toBe(200);
    expect(res.body.data.goodsReceipts.map((grn: { number: string }) => grn.number)).toEqual(["GRN-00002"]);
  });
});
