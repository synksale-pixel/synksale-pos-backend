/**
 * Purpose: Phase 3b purchase orders over HTTP: drafts and numbering, line pricing and the VAT
 * estimate, idempotent create, edits with version checks, issue (vendor copy and re-estimate),
 * cancel, close, delete, the lists and their filters, permissions per role and store, a
 * deactivated store, tenant isolation, and the vendor / product delete rules.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Vendor } from "../../src/models/vendor.model";
import { PurchaseOrder } from "../../src/models/purchaseOrder.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { todayIn } from "../../src/services/purchaseOrder.service";
import { singleExample, serviceExample } from "../../src/docs/product.openapi";

const PRODUCTS = "/api/v1/products";
const VENDORS = "/api/v1/vendors";
const ALL_POS = "/api/v1/purchase-orders";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let keySeq = 0;
const newKey = () => `test-key-${Date.now()}-${(keySeq += 1)}`;

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
let coffee: string; // standard-rated, cost price 1.600
let tea: string; // standard-rated, no cost price
let water: string; // zero-rated, cost 0.100
let wrap: string; // a service

const storePos = (storeId: unknown = ctx.storeA._id) => `/api/v1/stores/${storeId}/purchase-orders`;

async function product(body: Record<string, unknown>): Promise<string> {
  const res = await request.post(PRODUCTS).set(auth(admin)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.product.variants[0].id;
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

beforeEach(async () => {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
  vatVendor = await vendor({ name: "Gulf Roasters", taxRegistrationNumber: "220000987600003" });
  localVendor = await vendor({ name: "Corner Supplier" });
  coffee = await product(goods({ name: "Coffee", sku: "COF-1", purchase: { costPrice: "1.600" } }));
  tea = await product(goods({ name: "Tea", sku: "TEA-1", purchase: {} }));
  water = await product(goods({ name: "Water", sku: "WAT-1", taxPreference: "zero_rated", purchase: { costPrice: "0.100" } }));
  wrap = await product({ ...serviceExample });
});

const createPo = (body: Record<string, unknown>, opts: { token?: string; store?: unknown; key?: string } = {}) =>
  request
    .post(storePos(opts.store))
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send(body);

const draft = async (body: Record<string, unknown> = {}) => {
  const res = await createPo({ vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 24 }], ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.purchaseOrder;
};

const poUrl = (po: { id: string }, suffix = "", storeId: unknown = ctx.storeA._id) => `${storePos(storeId)}/${po.id}${suffix}`;

const issue = (po: { id: string; version: number }, token = admin) =>
  request.post(poUrl(po, "/issue")).set(auth(token)).send({ version: po.version });

// ==========================================
// Create
// ==========================================

describe("create a draft", () => {
  it("numbers it, prices lines from the cost price and estimates VAT for a VAT-registered vendor", async () => {
    const po = await draft({ vendorReference: "Q-1", notes: "Back door" });
    expect(po).toMatchObject({
      number: "PO-00001",
      status: "draft",
      version: 1,
      editable: true,
      orderDate: todayIn("Asia/Bahrain"),
      expectedDate: null,
      vendorReference: "Q-1",
      notes: "Back door",
      subtotal: "38.400",
      estimatedTax: "3.840",
      estimatedTotal: "42.240",
      issued: null,
      cancelled: null,
      closed: null,
      statusReason: null,
    });
    expect(po.store).toMatchObject({ name: "Store 1", code: "ALNOOR-1" });
    expect(po.vendor).toMatchObject({ id: vatVendor, name: "Gulf Roasters", vatTreatment: "vat_registered", isActive: true });
    expect(po.lines).toHaveLength(1);
    expect(po.lines[0]).toMatchObject({
      quantity: 24,
      receivedQuantity: 0,
      unitCost: "1.600",
      subtotal: "38.400",
      total: "42.240",
      note: null,
      tax: { taxPreference: "standard", taxRate: { name: "VAT 10%", rate: 10 }, estimatedTax: "3.840" },
    });
    expect(po.lines[0].variant).toMatchObject({ id: coffee, name: "Coffee" });
    expect(po.createdBy.name).toBe("Test User");
  });

  it("gives consecutive numbers per organization", async () => {
    expect((await draft()).number).toBe("PO-00001");
    expect((await draft()).number).toBe("PO-00002");
    const other = await setup("other");
    const otherAdmin = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    const otherVendor = (await request.post(VENDORS).set(auth(otherAdmin)).send({ name: "V" })).body.data.vendor.id;
    const otherProduct = (await request.post(PRODUCTS).set(auth(otherAdmin)).send(goods({ name: "X", sku: "X-1" }))).body.data.product
      .variants[0].id;
    const res = await createPo({ vendorId: otherVendor, lines: [{ variantId: otherProduct, quantity: 1 }] }, { token: otherAdmin, store: other.storeA._id });
    expect(res.status).toBe(201);
    expect(res.body.data.purchaseOrder.number).toBe("PO-00001");
  });

  it("never gives two concurrent drafts the same number", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => createPo({ vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 1 }] }))
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
    const numbers = results.map((r) => r.body.data.purchaseOrder.number).sort();
    expect(numbers).toEqual(["PO-00001", "PO-00002", "PO-00003", "PO-00004", "PO-00005", "PO-00006"]);
    expect((await Vendor.findById(vatVendor))!.purchaseDocumentCount).toBe(6);
  });

  it("uses a sent unit cost and keeps the line note", async () => {
    const po = await draft({ lines: [{ variantId: coffee, quantity: 2, unitCost: "1.555", note: "GR-250" }] });
    expect(po.lines[0]).toMatchObject({ unitCost: "1.555", subtotal: "3.110", note: "GR-250" });
    // 0.311 VAT: 3.110 × 10%.
    expect(po.estimatedTax).toBe("0.311");
  });

  it("estimates no VAT for a vendor that is not VAT-registered, or a zero-rated product", async () => {
    const local = await draft({ vendorId: localVendor });
    expect(local.estimatedTax).toBe("0.000");
    expect(local.lines[0].tax).toEqual({ taxPreference: "standard", taxRate: null, estimatedTax: "0.000" });

    const zero = await draft({ lines: [{ variantId: water, quantity: 10 }] });
    expect(zero.lines[0].tax).toEqual({ taxPreference: "zero_rated", taxRate: null, estimatedTax: "0.000" });
    expect(zero.estimatedTotal).toBe("1.000");
  });

  it("estimates no VAT for an overseas vendor (reverse charge)", async () => {
    const overseas = await vendor({ name: "Shenzhen Pack", countryCode: "CN" });
    expect((await draft({ vendorId: overseas })).estimatedTax).toBe("0.000");
  });

  it("rounds per line and sums the rounded lines", async () => {
    const po = await draft({
      lines: [
        { variantId: coffee, quantity: 1, unitCost: "0.005" },
        { variantId: water, quantity: 1, unitCost: "0.005" },
      ],
    });
    // Coffee VAT 0.0005 rounds half-up to 0.001; water is zero-rated.
    expect(po.lines.map((l: { tax: { estimatedTax: string } }) => l.tax.estimatedTax)).toEqual(["0.001", "0.000"]);
    expect(po).toMatchObject({ subtotal: "0.010", estimatedTax: "0.001", estimatedTotal: "0.011" });
  });

  it("takes the order date and expected date as sent, and refuses an expected date before today's default", async () => {
    const po = await draft({ orderDate: "2026-10-01", expectedDate: "2026-10-05" });
    expect(po).toMatchObject({ orderDate: "2026-10-01", expectedDate: "2026-10-05" });

    const res = await createPo({ vendorId: vatVendor, expectedDate: "2000-01-01", lines: [{ variantId: coffee, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({ field: "expectedDate", code: "VALIDATION_FAILED" });
  });

  it("collects every line problem in one 400, and persists nothing", async () => {
    const res = await createPo({
      vendorId: vatVendor,
      lines: [
        { variantId: "665f1c2e8a4b3c0012ab3fff", quantity: 1 },
        { variantId: wrap, quantity: 1, unitCost: "0.500" },
        { variantId: tea, quantity: 1 },
        { variantId: coffee, quantity: 1 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VARIANT_NOT_FOUND");
    expect(res.body.errors.map((e: { field: string; code: string }) => [e.field, e.code])).toEqual([
      ["lines[0].variantId", "VARIANT_NOT_FOUND"],
      ["lines[1].variantId", "VARIANT_NOT_PURCHASABLE"],
      ["lines[2].unitCost", "UNIT_COST_REQUIRED"],
    ]);
    expect(await PurchaseOrder.countDocuments({})).toBe(0);
    expect((await Vendor.findById(vatVendor))!.purchaseDocumentCount).toBe(0);
  });

  it("refuses a fractional quantity for a whole-number unit", async () => {
    const res = await createPo({ vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 1.5 }] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({ field: "lines[0].quantity", code: "VALIDATION_FAILED" });
  });

  it("allows a fractional quantity for a decimal unit", async () => {
    const rice = await product(goods({ name: "Rice", sku: "RICE-1", unit: "kg", purchase: { costPrice: "0.400" } }));
    const po = await draft({ lines: [{ variantId: rice, quantity: 12.5 }] });
    expect(po.lines[0]).toMatchObject({ quantity: 12.5, subtotal: "5.000" });
  });

  it("refuses an unknown or deactivated vendor", async () => {
    const missing = await createPo({ vendorId: "665f1c2e8a4b3c0012ab3fff", lines: [{ variantId: coffee, quantity: 1 }] });
    expect(missing.status).toBe(400);
    expect(missing.body.errors[0]).toMatchObject({ field: "vendorId", code: "VENDOR_NOT_FOUND" });

    await request.patch(`${VENDORS}/${localVendor}`).set(auth(admin)).send({ isActive: false });
    const inactive = await createPo({ vendorId: localVendor, lines: [{ variantId: coffee, quantity: 1 }] });
    expect(inactive.status).toBe(400);
    expect(inactive.body.code).toBe("VENDOR_INACTIVE");
    expect((await Vendor.findById(localVendor))!.purchaseDocumentCount).toBe(0);
  });

  it("refuses a body storeId and unknown fields", async () => {
    const res = await createPo({ storeId: String(ctx.storeA._id), vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  describe("idempotency", () => {
    const body = () => ({ vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 3 }] });

    it("requires the header", async () => {
      const res = await request.post(storePos()).set(auth(admin)).send(body());
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    });

    it("replays a retried create instead of making a second PO", async () => {
      const key = newKey();
      const first = await createPo(body(), { key });
      const second = await createPo(body(), { key });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers["idempotent-replayed"]).toBe("true");
      expect(second.body.data.purchaseOrder.id).toBe(first.body.data.purchaseOrder.id);
      expect(await PurchaseOrder.countDocuments({})).toBe(1);
      expect((await Vendor.findById(vatVendor))!.purchaseDocumentCount).toBe(1);
    });

    it("refuses the same key with a different body", async () => {
      const key = newKey();
      await createPo(body(), { key });
      const res = await createPo({ ...body(), notes: "changed" }, { key });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });
  });
});

// ==========================================
// Edit
// ==========================================

describe("edit", () => {
  it("applies the sent fields, bumps the version and keeps the rest", async () => {
    const po = await draft({ vendorReference: "Q-1", notes: "n" });
    const res = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, expectedDate: "2099-01-01", notes: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.purchaseOrder).toMatchObject({ version: 2, expectedDate: "2099-01-01", notes: null, vendorReference: "Q-1" });
    expect(res.body.data.purchaseOrder.lines[0].unitCost).toBe("1.600");
  });

  it("refuses a stale version without changing anything", async () => {
    const po = await draft();
    await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, notes: "first" });
    const res = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, notes: "second" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PURCHASE_ORDER_VERSION_CONFLICT");
    expect(res.body.errors[0]).toMatchObject({ field: "version", meta: { currentVersion: 2 } });
    expect((await PurchaseOrder.findById(po.id))!.notes).toBe("first");
  });

  it("lets only one of two concurrent edits from the same version through", async () => {
    const po = await draft();
    const results = await Promise.all(
      ["a", "b", "c"].map((notes) => request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, notes }))
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await PurchaseOrder.findById(po.id))!.version).toBe(2);
  });

  it("replaces every line, picking up the cost price where no unitCost is sent", async () => {
    const po = await draft({ lines: [{ variantId: coffee, quantity: 1, unitCost: "9.000" }] });
    const res = await request
      .patch(poUrl(po))
      .set(auth(admin))
      .send({ version: 1, lines: [{ variantId: coffee, quantity: 2 }, { variantId: water, quantity: 5 }] });
    expect(res.status).toBe(200);
    const updated = res.body.data.purchaseOrder;
    expect(updated.lines.map((l: { unitCost: string }) => l.unitCost)).toEqual(["1.600", "0.100"]);
    expect(updated.lines[0].id).not.toBe(po.lines[0].id);
    expect(updated).toMatchObject({ subtotal: "3.700", estimatedTax: "0.320" });
  });

  it("changes the vendor of a draft, re-estimating VAT and moving the vendor counts", async () => {
    const po = await draft();
    const res = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, vendorId: localVendor });
    expect(res.status).toBe(200);
    expect(res.body.data.purchaseOrder).toMatchObject({ vendor: { id: localVendor }, estimatedTax: "0.000" });
    expect((await Vendor.findById(vatVendor))!.purchaseDocumentCount).toBe(0);
    expect((await Vendor.findById(localVendor))!.purchaseDocumentCount).toBe(1);
  });

  it("refuses a deactivated vendor on edit, but the stored vendor being deactivated never blocks one", async () => {
    const po = await draft();
    await request.patch(`${VENDORS}/${localVendor}`).set(auth(admin)).send({ isActive: false });
    const res = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, vendorId: localVendor });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VENDOR_INACTIVE");

    await request.patch(`${VENDORS}/${vatVendor}`).set(auth(admin)).send({ isActive: false });
    const ok = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, notes: "still editable" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.purchaseOrder.vendor.isActive).toBe(false);
    // A form resent whole carries the PO's own (now deactivated) vendor: that is no change.
    const resent = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 2, vendorId: vatVendor, notes: "resent" });
    expect(resent.status).toBe(200);
  });

  it("checks the date order against the stored dates", async () => {
    const po = await draft({ orderDate: "2026-10-10" });
    const res = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, expectedDate: "2026-10-09" });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("expectedDate");
  });

  it("edits an issued PO, keeping it issued and its vendor, using the VAT treatment copied at issue", async () => {
    const po = await draft();
    const issued = (await issue(po)).body.data.purchaseOrder;
    // The vendor deregisters after issue: the issued PO still estimates with the copy.
    await request.patch(`${VENDORS}/${vatVendor}`).set(auth(admin)).send({ taxRegistrationNumber: null, vatTreatment: "not_registered" });

    const res = await request
      .patch(poUrl(po))
      .set(auth(admin))
      .send({ version: issued.version, lines: [{ variantId: coffee, quantity: 10, unitCost: "1.650" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.purchaseOrder).toMatchObject({ status: "issued", estimatedTax: "1.650", vendor: { vatTreatment: "vat_registered" } });

    const vendorChange = await request.patch(poUrl(po)).set(auth(admin)).send({ version: issued.version + 1, vendorId: localVendor });
    expect(vendorChange.status).toBe(400);
    expect(vendorChange.body.errors[0]).toMatchObject({ field: "vendorId", code: "VALIDATION_FAILED" });
  });

  it("refuses edits once cancelled, with the status and what would allow it", async () => {
    const po = await draft();
    const issued = (await issue(po)).body.data.purchaseOrder;
    const cancelled = (await request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version: issued.version })).body.data.purchaseOrder;
    expect(cancelled.editable).toBe(false);
    const res = await request.patch(poUrl(po)).set(auth(admin)).send({ version: cancelled.version, notes: "x" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PURCHASE_ORDER_STATUS_CONFLICT");
    expect(res.body.errors[0].meta).toEqual({ status: "cancelled", allowed: ["draft", "issued"] });
  });

  it("checks the version before the status", async () => {
    const po = await draft();
    await issue(po);
    await request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version: 2 });
    const res = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 1, notes: "stale" });
    expect(res.body.code).toBe("PURCHASE_ORDER_VERSION_CONFLICT");
  });

  it("refuses a PO partly received (locked from the first receipt)", async () => {
    const po = await draft();
    await issue(po);
    await PurchaseOrder.updateOne({ _id: po.id }, { $set: { status: "partially_received", "lines.0.receivedQuantityMilli": 5000 } });
    const res = await request.patch(poUrl(po)).set(auth(admin)).send({ version: 2, notes: "x" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PURCHASE_ORDER_STATUS_CONFLICT");
  });
});

// ==========================================
// Issue, cancel, close, delete
// ==========================================

describe("issue", () => {
  it("issues a draft and copies the vendor's details, which later vendor edits do not change", async () => {
    const po = await draft();
    const res = await issue(po);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const issued = res.body.data.purchaseOrder;
    expect(issued).toMatchObject({ status: "issued", version: 2, number: po.number, orderDate: po.orderDate, editable: true });
    expect(issued.issued.by.name).toBe("Test User");

    await request.patch(`${VENDORS}/${vatVendor}`).set(auth(admin)).send({ name: "Gulf Roasters Renamed" });
    const read = await request.get(poUrl(po)).set(auth(admin));
    expect(read.body.data.purchaseOrder.vendor).toMatchObject({
      name: "Gulf Roasters",
      taxRegistrationNumber: "220000987600003",
      vatTreatment: "vat_registered",
    });
  });

  it("works the VAT out again at issue when the vendor changed since the draft was saved", async () => {
    const po = await draft({ vendorId: localVendor });
    expect(po.estimatedTax).toBe("0.000");
    await request.patch(`${VENDORS}/${localVendor}`).set(auth(admin)).send({ taxRegistrationNumber: "220000111100003", vatTreatment: "vat_registered" });
    const issued = (await issue(po)).body.data.purchaseOrder;
    expect(issued.vendor.vatTreatment).toBe("vat_registered");
    expect(issued.estimatedTax).toBe("3.840");
  });

  it("refuses a deactivated vendor", async () => {
    const po = await draft();
    await request.patch(`${VENDORS}/${vatVendor}`).set(auth(admin)).send({ isActive: false });
    const res = await issue(po);
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({ field: "vendorId", code: "VENDOR_INACTIVE" });
  });

  it("a second click with the old version is a version conflict, the current version a status conflict", async () => {
    const po = await draft();
    await issue(po);
    const again = await issue(po);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PURCHASE_ORDER_VERSION_CONFLICT");
    const current = await issue({ id: po.id, version: 2 });
    expect(current.body.code).toBe("PURCHASE_ORDER_STATUS_CONFLICT");
  });
});

describe("cancel and close", () => {
  it("cancels an issued PO with nothing received, keeping the reason", async () => {
    const po = await draft();
    await issue(po);
    const res = await request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version: 2, reason: "Out of season" });
    expect(res.status).toBe(200);
    expect(res.body.data.purchaseOrder).toMatchObject({ status: "cancelled", statusReason: "Out of season", editable: false, version: 3 });
    expect(res.body.data.purchaseOrder.cancelled.by.name).toBe("Test User");
  });

  it("refuses to cancel a draft (delete it instead)", async () => {
    const po = await draft();
    const res = await request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.errors[0].meta).toEqual({ status: "draft", allowed: ["issued"] });
  });

  it("closes only a partly received PO", async () => {
    const po = await draft();
    await issue(po);
    const early = await request.post(poUrl(po, "/close")).set(auth(admin)).send({ version: 2 });
    expect(early.body.code).toBe("PURCHASE_ORDER_STATUS_CONFLICT");

    await PurchaseOrder.updateOne({ _id: po.id }, { $set: { status: "partially_received", "lines.0.receivedQuantityMilli": 5000 } });
    const cancel = await request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version: 2 });
    expect(cancel.body.code).toBe("PURCHASE_ORDER_STATUS_CONFLICT");
    const res = await request.post(poUrl(po, "/close")).set(auth(admin)).send({ version: 2, reason: "Rest unavailable" });
    expect(res.status).toBe(200);
    expect(res.body.data.purchaseOrder).toMatchObject({ status: "closed", statusReason: "Rest unavailable" });
    expect(res.body.data.purchaseOrder.lines[0].receivedQuantity).toBe(5);
  });
});

describe("delete a draft", () => {
  it("deletes it, leaving a gap in the numbering and releasing the vendor", async () => {
    const po = await draft();
    const res = await request.delete(poUrl(po, "?version=1")).set(auth(admin));
    expect(res.status).toBe(200);
    expect((await request.get(poUrl(po)).set(auth(admin))).status).toBe(404);
    expect((await draft()).number).toBe("PO-00002");
    expect((await Vendor.findById(vatVendor))!.purchaseDocumentCount).toBe(1);
  });

  it("needs the version in the query string and refuses a stale one", async () => {
    const po = await draft();
    expect((await request.delete(poUrl(po)).set(auth(admin))).status).toBe(400);
    expect((await request.delete(poUrl(po, "?version=abc")).set(auth(admin))).status).toBe(400);
    const stale = await request.delete(poUrl(po, "?version=7")).set(auth(admin));
    expect(stale.body.code).toBe("PURCHASE_ORDER_VERSION_CONFLICT");
  });

  it("refuses an issued PO (cancel it instead)", async () => {
    const po = await draft();
    await issue(po);
    const res = await request.delete(poUrl(po, "?version=2")).set(auth(admin));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PURCHASE_ORDER_STATUS_CONFLICT");
  });
});

// ==========================================
// Reads and lists
// ==========================================

describe("reads and lists", () => {
  it("lists newest number first with summaries, and filters by status, vendor, search and dates", async () => {
    const a = await draft({ orderDate: "2026-10-01", vendorReference: "QUOTE-7" });
    const b = await draft({ vendorId: localVendor, orderDate: "2026-10-15" });
    await issue(b);

    const all = await request.get(storePos()).set(auth(admin));
    expect(all.status).toBe(200);
    expect(all.body.data.purchaseOrders.map((p: { number: string }) => p.number)).toEqual(["PO-00002", "PO-00001"]);
    expect(all.body.data.purchaseOrders[0]).toMatchObject({ lineCount: 1, status: "issued" });
    expect(all.body.data.purchaseOrders[0].lines).toBeUndefined();
    expect(all.body.data.pagination.total).toBe(2);

    const numbers = async (query: string) =>
      (await request.get(`${storePos()}?${query}`).set(auth(admin))).body.data.purchaseOrders.map((p: { number: string }) => p.number);
    expect(await numbers("status=issued,partially_received")).toEqual(["PO-00002"]);
    expect(await numbers("status=bogus")).toEqual(["PO-00002", "PO-00001"]);
    expect(await numbers(`vendorId=${vatVendor}`)).toEqual([a.number]);
    expect(await numbers("vendorId=nope")).toEqual([]);
    expect(await numbers("search=PO-00002")).toEqual(["PO-00002"]);
    expect(await numbers("search=0000")).toEqual(["PO-00002", "PO-00001"]);
    expect(await numbers("search=quote")).toEqual(["PO-00001"]);
    expect(await numbers("search=(.*")).toEqual([]);
    expect(await numbers("search=%00")).toEqual(["PO-00002", "PO-00001"]);
    expect(await numbers("from=2026-10-10")).toEqual(["PO-00002"]);
    expect(await numbers("to=2026-10-10")).toEqual(["PO-00001"]);
    expect(await numbers("from=garbage")).toEqual(["PO-00002", "PO-00001"]);
  });

  it("the store list shows only that store; the cross-store list shows all and filters by storeId", async () => {
    await draft();
    await createPo({ vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 1 }] }, { store: ctx.storeB._id });

    expect((await request.get(storePos(ctx.storeB._id)).set(auth(admin))).body.data.purchaseOrders).toHaveLength(1);
    const all = await request.get(ALL_POS).set(auth(admin));
    expect(all.body.data.purchaseOrders).toHaveLength(2);
    const onlyB = await request.get(`${ALL_POS}?storeId=${ctx.storeB._id}`).set(auth(admin));
    expect(onlyB.body.data.purchaseOrders.map((p: { store: { code: string } }) => p.store.code)).toEqual(["ALNOOR-2"]);
    expect((await request.get(`${ALL_POS}?storeId=bad`).set(auth(admin))).body.data.purchaseOrders).toEqual([]);
  });

  it("a PO of another store is not found through this store's path", async () => {
    const po = await draft();
    const res = await request.get(poUrl(po, "", ctx.storeB._id)).set(auth(admin));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PURCHASE_ORDER_NOT_FOUND");
  });

  it("a malformed id is a 400", async () => {
    expect((await request.get(`${storePos()}/abc`).set(auth(admin))).status).toBe(400);
  });
});

// ==========================================
// Permissions, stores and tenants
// ==========================================

describe("permissions", () => {
  const staff = (slug: string, storeId: unknown, email: string) =>
    tokenFor(ctx.org._id, email, { storeAccess: [{ storeId, roleId: ctx.role(slug)._id }] });

  it("a store manager orders for their own store only, and lists only their store", async () => {
    const manager = await staff("store_manager", ctx.storeA._id, "manager@alnoor.test");
    const own = await createPo({ vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 1 }] }, { token: manager });
    expect(own.status).toBe(201);
    const po = own.body.data.purchaseOrder;
    expect((await issue(po, manager)).status).toBe(200);

    const other = await createPo({ vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 1 }] }, { token: manager, store: ctx.storeB._id });
    expect(other.status).toBe(403);

    await createPo({ vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 1 }] }, { store: ctx.storeB._id });
    const list = await request.get(ALL_POS).set(auth(manager));
    expect(list.body.data.purchaseOrders.map((p: { number: string }) => p.number)).toEqual([po.number]);
  });

  it("an inventory clerk and an accountant can read but not order; a cashier cannot read", async () => {
    const po = await draft();
    const clerk = await staff("inventory_clerk", ctx.storeA._id, "clerk@alnoor.test");
    const accountant = await tokenFor(ctx.org._id, "acc@alnoor.test", { orgRoleId: ctx.role("accountant")._id });
    const cashier = await staff("cashier", ctx.storeA._id, "cashier@alnoor.test");

    for (const token of [clerk, accountant]) {
      expect((await request.get(poUrl(po)).set(auth(token))).status).toBe(200);
      expect((await createPo({ vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 1 }] }, { token })).status).toBe(403);
      expect((await request.patch(poUrl(po)).set(auth(token)).send({ version: 1, notes: "x" })).status).toBe(403);
    }
    expect((await request.get(ALL_POS).set(auth(accountant))).body.data.purchaseOrders).toHaveLength(1);
    expect((await request.get(poUrl(po)).set(auth(cashier))).status).toBe(403);
    expect((await request.get(ALL_POS).set(auth(cashier))).status).toBe(403);
  });

  it("a deactivated store's POs can be read and cancelled, not created, edited or issued", async () => {
    const po = await draft();
    const other = await draft();
    await issue(po);
    await Store.updateOne({ _id: ctx.storeA._id }, { $set: { isActive: false } });

    expect((await request.get(poUrl(po)).set(auth(admin))).status).toBe(200);
    expect((await request.get(storePos()).set(auth(admin))).status).toBe(200);
    expect((await request.patch(poUrl(po)).set(auth(admin)).send({ version: 2, notes: "x" })).status).toBe(403);
    expect((await issue(other)).status).toBe(403);
    expect((await createPo({ vendorId: vatVendor, lines: [{ variantId: coffee, quantity: 1 }] })).status).toBe(403);
    expect((await request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version: 2 })).status).toBe(200);
  });

  it("another organization's PO is invisible", async () => {
    const po = await draft();
    const other = await setup("other");
    const otherAdmin = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    expect((await request.get(poUrl(po)).set(auth(otherAdmin))).status).toBe(404);
    expect((await request.get(ALL_POS).set(auth(otherAdmin))).body.data.purchaseOrders).toEqual([]);
  });
});

// ==========================================
// Delete rules for vendors and products
// ==========================================

describe("vendor and product delete rules", () => {
  it("a vendor with a PO cannot be deleted, whatever its status; deleting its only draft frees it", async () => {
    const po = await draft();
    const refused = await request.delete(`${VENDORS}/${vatVendor}`).set(auth(admin));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("VENDOR_IN_USE");
    expect(refused.body.errors[0].meta).toEqual({ documentCount: 1 });

    await request.delete(poUrl(po, "?version=1")).set(auth(admin));
    expect((await request.delete(`${VENDORS}/${vatVendor}`).set(auth(admin))).status).toBe(200);
  });

  it("a cancelled PO still keeps its vendor in use", async () => {
    const po = await draft();
    await issue(po);
    await request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version: 2 });
    expect((await request.delete(`${VENDORS}/${vatVendor}`).set(auth(admin))).body.code).toBe("VENDOR_IN_USE");
  });

  it("a concurrent vendor delete and PO create never leave a PO on a deleted vendor", async () => {
    const [created, deleted] = await Promise.all([
      createPo({ vendorId: localVendor, lines: [{ variantId: coffee, quantity: 1 }] }),
      request.delete(`${VENDORS}/${localVendor}`).set(auth(admin)),
    ]);
    const vendorDoc = await Vendor.findOne({ _id: localVendor, isDelete: { $in: [true, false] } });
    if (created.status === 201) {
      expect(deleted.status).toBe(409);
      expect(vendorDoc!.isDelete).toBe(false);
    } else {
      expect(deleted.status).toBe(200);
      expect(created.body.code).toBe("VENDOR_NOT_FOUND");
      expect(await PurchaseOrder.countDocuments({})).toBe(0);
    }
  });

  it("a product on an open PO cannot be deleted; once the PO is cancelled it can", async () => {
    const productId = (await request.get(`${PRODUCTS}?search=Coffee`).set(auth(admin))).body.data.products[0].id;
    const po = await draft();
    const refused = await request.delete(`${PRODUCTS}/${productId}`).set(auth(admin));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("PRODUCT_IN_USE");
    expect(refused.body.errors[0].meta).toEqual({ purchaseOrders: [po.number] });

    await issue(po);
    await request.post(poUrl(po, "/cancel")).set(auth(admin)).send({ version: 2 });
    expect((await request.delete(`${PRODUCTS}/${productId}`).set(auth(admin))).status).toBe(200);

    // The cancelled PO still reads, naming the deleted product.
    const read = await request.get(poUrl(po)).set(auth(admin));
    expect(read.body.data.purchaseOrder.lines[0].product.name).toBe("Coffee");
  });
});
