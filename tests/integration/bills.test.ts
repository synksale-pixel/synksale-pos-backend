/**
 * Purpose: Phase 3d vendor bills and payments over HTTP: billing receipt lines (defaults, price
 * variance, partial and over-billing, concurrent bills), service lines, VAT (rates, vendor
 * treatment, the rounding adjustment), organizations with no TRN, dates, duplicate invoice
 * numbers, idempotency, voids, payments (partial, full, overpayment, other vendors, voids), the
 * lists and their filters, permissions, and the catalog / vendor rules bills change.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { GoodsReceipt } from "../../src/models/goodsReceipt.model";
import { Bill } from "../../src/models/bill.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { addDays } from "../../src/services/bill.service";
import { todayIn } from "../../src/services/purchaseOrder.service";
import { singleExample, serviceExample } from "../../src/docs/product.openapi";

const PRODUCTS = "/api/v1/products";
const VENDORS = "/api/v1/vendors";
const BILLS = "/api/v1/bills";
const PAYMENTS = "/api/v1/vendor-payments";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let keySeq = 0;
const newKey = () => `bill-key-${Date.now()}-${(keySeq += 1)}`;

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
let vatVendor: string; // vat_registered, 30 days terms
let localVendor: string; // not registered
let coffee: { variantId: string; productId: string }; // standard, tracked
let rice: { variantId: string; productId: string }; // kg
let bags: { variantId: string; productId: string }; // untracked goods
let delivery: { variantId: string; productId: string }; // a service

async function product(body: Record<string, unknown>, token = admin) {
  const res = await request.post(PRODUCTS).set(auth(token)).send(body);
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

async function seed() {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
  vatVendor = await vendor({ name: "Gulf Roasters", taxRegistrationNumber: "220000987600003", paymentTermsDays: 30 });
  localVendor = await vendor({ name: "Corner Supplier" });
  coffee = await product(goods({ name: "Coffee", sku: "COF-1", purchase: { costPrice: "1.600" } }));
  rice = await product(goods({ name: "Rice", sku: "RICE-1", unit: "kg", purchase: { costPrice: "0.500" } }));
  bags = await product(goods({ name: "Bags", sku: "BAG-1", inventory: { trackInventory: false } }));
  delivery = await product({ ...serviceExample, name: "Delivery charge" });
}

beforeEach(seed);

const grnPath = (storeId: unknown = ctx.storeA._id) => `/api/v1/stores/${storeId}/goods-receipts`;

/** A receipt without a PO: 24 coffee at 1.600 and 12.5 kg rice at 0.500 by default. */
async function receipt(
  opts: { vendorId?: string; storeId?: unknown; date?: string; lines?: Record<string, unknown>[] } = {}
) {
  const res = await request
    .post(grnPath(opts.storeId))
    .set(auth(admin))
    .set("Idempotency-Key", newKey())
    .send({
      vendorId: opts.vendorId ?? vatVendor,
      receivedDate: opts.date ?? "2026-11-01",
      lines: opts.lines ?? [
        { variantId: coffee.variantId, quantity: 24, unitCost: "1.600" },
        { variantId: rice.variantId, quantity: 12.5, unitCost: "0.500" },
      ],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const grn = res.body.data.goodsReceipt;
  return { id: grn.id as string, number: grn.number as string, lines: grn.lines.map((l: { id: string }) => l.id) as string[] };
}

const postBill = (body: Record<string, unknown>, opts: { token?: string; key?: string } = {}) =>
  request
    .post(BILLS)
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send(body);

const postPayment = (body: Record<string, unknown>, opts: { token?: string; key?: string } = {}) =>
  request
    .post(PAYMENTS)
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send(body);

const voidBillReq = (id: string, version: number, key = newKey()) =>
  request.post(`${BILLS}/${id}/void`).set(auth(admin)).set("Idempotency-Key", key).send({ version, reason: "Wrong vendor" });

const voidPaymentReq = (id: string, version: number, key = newKey()) =>
  request.post(`${PAYMENTS}/${id}/void`).set(auth(admin)).set("Idempotency-Key", key).send({ version, reason: "Cheque bounced" });

async function billOk(body: Record<string, unknown>) {
  const res = await postBill(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.bill;
}

async function receiptLine(grnId: string, index: number) {
  const res = await request.get(`${grnPath()}/${grnId}`).set(auth(admin));
  expect(res.status).toBe(200);
  return res.body.data.goodsReceipt.lines[index];
}

// ==========================================
// Recording bills
// ==========================================

describe("record a bill", () => {
  it("bills a whole receipt line by default: quantity, cost, VAT, due date, numbering, billedQuantity", async () => {
    const grn = await receipt();
    const res = await postBill({
      vendorId: vatVendor,
      vendorInvoiceNumber: "INV-1",
      billDate: "2026-11-05",
      lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.message).toBe("Bill recorded successfully.");
    const bill = res.body.data.bill;
    expect(bill).toMatchObject({
      number: "BILL-00001",
      status: "unpaid",
      vendorInvoiceNumber: "INV-1",
      billDate: "2026-11-05",
      dueDate: "2026-12-05",
      subtotal: "38.400",
      tax: "3.840",
      vatAdjustment: "0.000",
      total: "42.240",
      paid: "0.000",
      balanceDue: "42.240",
      costVariance: "0.000",
      version: 1,
      payments: [],
      voided: null,
      voidReason: null,
    });
    expect(bill.vendor).toMatchObject({ id: vatVendor, name: "Gulf Roasters", vatTreatment: "vat_registered", isActive: true });
    expect(bill.lines[0]).toMatchObject({
      kind: "goods",
      goodsReceipt: { id: grn.id, number: grn.number, receivedDate: "2026-11-01" },
      goodsReceiptLineId: grn.lines[0],
      store: { name: "Store 1" },
      variant: { id: coffee.variantId },
      quantity: 24,
      unitCost: "1.600",
      receivedUnitCost: "1.600",
      subtotal: "38.400",
      tax: { taxPreference: "standard", taxRate: { name: "VAT 10%", rate: 10 }, tax: "3.840" },
      total: "42.240",
      costVariance: "0.000",
    });
    expect((await receiptLine(grn.id, 0)).billedQuantity).toBe(24);
    expect((await receiptLine(grn.id, 1)).billedQuantity).toBe(0);

    const second = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "INV-2", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1] }] });
    expect(second.number).toBe("BILL-00002");
    // billDate defaults to today; dueDate to today + 30.
    const today = todayIn("Asia/Bahrain");
    expect(second.billDate).toBe(today);
    expect(second.dueDate).toBe(addDays(today, 30));
  });

  it("keeps a different price as a cost variance and does not touch stock or the last purchase cost", async () => {
    const grn = await receipt();
    const bill = await billOk({
      vendorId: vatVendor,
      vendorInvoiceNumber: "INV-1",
      lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], unitCost: "1.650", note: "Price increase" }],
    });
    expect(bill.lines[0]).toMatchObject({ unitCost: "1.650", receivedUnitCost: "1.600", subtotal: "39.600", costVariance: "1.200", note: "Price increase" });
    expect(bill.costVariance).toBe("1.200");

    const productRes = await request.get(`${PRODUCTS}/${coffee.productId}`).set(auth(admin));
    expect(productRes.body.data.product.variants[0].lastPurchase.unitCost).toBe("1.600");
  });

  it("bills a receipt line over several bills, then refuses over-billing with the remaining quantity", async () => {
    const grn = await receipt();
    await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "A", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1], quantity: 6.25 }] });
    const over = await postBill({
      vendorId: vatVendor,
      vendorInvoiceNumber: "B",
      lines: [
        { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 25 },
        { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1], quantity: 6.5 },
      ],
    });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("BILLED_QUANTITY_EXCEEDS_RECEIVED");
    expect(over.body.errors).toEqual([
      expect.objectContaining({ field: "lines[0].quantity", meta: { received: 24, billed: 0, remaining: 24 } }),
      expect.objectContaining({ field: "lines[1].quantity", meta: { received: 12.5, billed: 6.25, remaining: 6.25 } }),
    ]);
    // The rest by default, then nothing left.
    const rest = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "C", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1] }] });
    expect(rest.lines[0].quantity).toBe(6.25);
    const none = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "D", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1] }] });
    expect(none.status).toBe(409);
    expect(none.body.errors[0].meta).toEqual({ received: 12.5, billed: 12.5, remaining: 0 });
    expect((await receiptLine(grn.id, 1)).billedQuantity).toBe(12.5);
  });

  it("two bills racing for the same receipt line: one wins, the other is refused", async () => {
    const grn = await receipt();
    const line = { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] };
    const results = await Promise.all([
      postBill({ vendorId: vatVendor, vendorInvoiceNumber: "R1", lines: [line] }),
      postBill({ vendorId: vatVendor, vendorInvoiceNumber: "R2", lines: [line] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await receiptLine(grn.id, 0)).billedQuantity).toBe(24);
  });

  it("bills receipts from several stores and a service line on one bill", async () => {
    const a = await receipt();
    const b = await receipt({ storeId: ctx.storeB._id, lines: [{ variantId: bags.variantId, quantity: 100, unitCost: "0.050" }] });
    const bill = await billOk({
      vendorId: vatVendor,
      vendorInvoiceNumber: "STATEMENT-10",
      lines: [
        { goodsReceiptId: a.id, goodsReceiptLineId: a.lines[0] },
        { goodsReceiptId: b.id, goodsReceiptLineId: b.lines[0] },
        { variantId: delivery.variantId, quantity: 1, unitCost: "5.000" },
      ],
    });
    expect(bill.lines.map((l: { kind: string }) => l.kind)).toEqual(["goods", "goods", "service"]);
    expect(bill.lines[1].store.name).toBe("Store 2");
    expect(bill.lines[2]).toMatchObject({ goodsReceipt: null, goodsReceiptLineId: null, store: null, receivedUnitCost: null, subtotal: "5.000", tax: { tax: "0.500" }, costVariance: "0.000" });
    // 38.400 + 5.000 + 5.000 = 48.400; VAT 3.840 + 0.500 + 0.500
    expect(bill).toMatchObject({ subtotal: "48.400", tax: "4.840", total: "53.240" });

    const byReceipt = await request.get(`${BILLS}?goodsReceiptId=${b.id}`).set(auth(admin));
    expect(byReceipt.body.data.bills.map((x: { id: string }) => x.id)).toEqual([bill.id]);
  });

  it("collects line problems: goods on a service line, other vendor's receipt, unknown variant and tax rate", async () => {
    const other = await receipt({ vendorId: localVendor });
    const res = await postBill({
      vendorId: vatVendor,
      vendorInvoiceNumber: "X",
      lines: [
        { variantId: coffee.variantId, quantity: 1, unitCost: "1.000" },
        { goodsReceiptId: other.id, goodsReceiptLineId: other.lines[0] },
        { variantId: "665f1c2e8a4b3c0012ab3880", quantity: 1, unitCost: "1.000" },
        { variantId: delivery.variantId, quantity: 1, unitCost: "1.000", taxRateId: "665f1c2e8a4b3c0012ab3600" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("GOODS_REQUIRE_RECEIPT");
    expect(res.body.errors.map((e: { field: string; code: string }) => [e.field, e.code])).toEqual([
      ["lines[0].variantId", "GOODS_REQUIRE_RECEIPT"],
      ["lines[1].goodsReceiptId", "VENDOR_MISMATCH"],
      ["lines[2].variantId", "VARIANT_NOT_FOUND"],
      ["lines[3].taxRateId", "TAX_RATE_NOT_FOUND"],
    ]);
    expect(res.body.errors[1].meta).toEqual({ goodsReceiptNumber: other.number });
    expect(await Bill.countDocuments({ organizationId: ctx.org._id })).toBe(0);
  });

  it("404s an unknown receipt or receipt line, 400s an unknown vendor", async () => {
    const grn = await receipt();
    const missing = await postBill({
      vendorId: vatVendor,
      vendorInvoiceNumber: "X",
      lines: [
        { goodsReceiptId: "665f1c2e8a4b3c0012ab3d00", goodsReceiptLineId: grn.lines[0] },
        { goodsReceiptId: grn.id, goodsReceiptLineId: "665f1c2e8a4b3c0012ab3d01" },
      ],
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("GOODS_RECEIPT_NOT_FOUND");
    expect(missing.body.errors.map((e: { field: string }) => e.field)).toEqual(["lines[0].goodsReceiptId", "lines[1].goodsReceiptLineId"]);

    const noVendor = await postBill({ vendorId: "665f1c2e8a4b3c0012ab3900", vendorInvoiceNumber: "X", lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: "1.000" }] });
    expect(noVendor.status).toBe(400);
    expect(noVendor.body.code).toBe("VENDOR_NOT_FOUND");
  });

  it("refuses fractional quantities of whole-number units", async () => {
    const grn = await receipt();
    const res = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "X", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 1.5 }] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("lines[0].quantity");
  });
});

describe("VAT", () => {
  it("an explicit rate, or none, overrides the default", async () => {
    const zero = await request.post("/api/v1/tax-rates").set(auth(admin)).send({ name: "Zero", components: [{ name: "VAT", rate: 0 }] });
    expect(zero.status, JSON.stringify(zero.body)).toBe(201);
    const grn = await receipt();
    const bill = await billOk({
      vendorId: vatVendor,
      vendorInvoiceNumber: "X",
      lines: [
        { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], taxRateId: zero.body.data.taxRate.id },
        { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1], taxRateId: null },
      ],
    });
    expect(bill.lines[0].tax).toMatchObject({ taxRate: { name: "Zero", rate: 0 }, tax: "0.000" });
    expect(bill.lines[1].tax).toMatchObject({ taxRate: null, tax: "0.000" });
    expect(bill.tax).toBe("0.000");
  });

  it("a vendor that is not VAT-registered charges no VAT", async () => {
    const grn = await receipt({ vendorId: localVendor });
    const bill = await billOk({ vendorId: localVendor, vendorInvoiceNumber: "X", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }] });
    expect(bill.vendor.vatTreatment).toBe("not_registered");
    expect(bill.lines[0].tax).toMatchObject({ taxRate: null, tax: "0.000" });
    expect(bill.total).toBe("38.400");
  });

  it("vatAdjustment corrects the total by up to 5 smallest units, never beyond", async () => {
    const grn = await receipt();
    const bill = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "X", vatAdjustment: "-0.002", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }] });
    expect(bill).toMatchObject({ vatAdjustment: "-0.002", tax: "3.838", total: "42.238" });

    for (const vatAdjustment of ["0.006", "-0.006"]) {
      const res = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: `Y${vatAdjustment}`, vatAdjustment, lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1] }] });
      expect([res.status, res.body.code], vatAdjustment).toEqual([400, "VAT_ADJUSTMENT_TOO_LARGE"]);
    }
    // Cannot make VAT negative.
    const service = await postBill({ vendorId: localVendor, vendorInvoiceNumber: "Z", vatAdjustment: "-0.001", lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: "1.000" }] });
    expect(service.body.code).toBe("VAT_ADJUSTMENT_TOO_LARGE");
  });

  it("a positive vatAdjustment needs VAT on the lines; a negative one still needs room", async () => {
    const res = await postBill({ vendorId: localVendor, vendorInvoiceNumber: "NV1", vatAdjustment: "0.001", lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: "1.000" }] });
    expect([res.status, res.body.code]).toEqual([400, "VAT_ADJUSTMENT_WITHOUT_VAT"]);
    expect(res.body.errors[0]).toMatchObject({ field: "vatAdjustment", code: "VAT_ADJUSTMENT_WITHOUT_VAT" });
    // Zero is no adjustment at all and stays allowed.
    const zero = await billOk({ vendorId: localVendor, vendorInvoiceNumber: "NV2", vatAdjustment: "0.000", lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: "1.000" }] });
    expect(zero).toMatchObject({ vatAdjustment: "0.000", tax: "0.000" });
  });

  it("without a TRN the cost variance compares totals (VAT is part of the cost)", async () => {
    await Organization.updateOne({ _id: ctx.org._id }, { $set: { taxRegistrationNumber: null } });
    const grn = await receipt();
    expect((await receiptLine(grn.id, 0)).stockUnitCost).toBe("1.760");
    const bill = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "X", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], unitCost: "1.650" }] });
    // total 39.600 + 3.960 = 43.560; stock 24 × 1.760 = 42.240
    expect(bill.lines[0].costVariance).toBe("1.320");
  });
});

describe("dates and invoice numbers", () => {
  it("refuses a future billDate, one before a receipt's receivedDate, and a dueDate before billDate", async () => {
    const grn = await receipt({ date: "2026-11-03" });
    const line = [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }];
    const future = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "X", billDate: "2999-01-01", lines: line });
    expect([future.status, future.body.errors[0].field]).toEqual([400, "billDate"]);
    const early = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "X", billDate: "2026-11-02", lines: line });
    expect([early.status, early.body.errors[0].field]).toEqual([400, "billDate"]);
    const due = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "X", dueDate: "2026-11-02", lines: line });
    expect([due.status, due.body.errors[0].field]).toEqual([400, "dueDate"]);
  });

  it("refuses a duplicate vendor invoice number (case-insensitive) until the first bill is void", async () => {
    const service = [{ variantId: delivery.variantId, quantity: 1, unitCost: "2.000" }];
    const first = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "INV-9", lines: service });
    const dup = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "inv-9", lines: service });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DUPLICATE_VENDOR_INVOICE");
    expect(dup.body.errors[0].meta).toEqual({ billId: first.id, billNumber: first.number });
    // Another vendor may use the same number.
    await billOk({ vendorId: localVendor, vendorInvoiceNumber: "INV-9", lines: service });

    expect((await voidBillReq(first.id, first.version)).status).toBe(200);
    await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "INV-9", lines: service });
  });

  it("replays a retried request instead of billing twice; another body with the key is refused", async () => {
    const grn = await receipt();
    const body = { vendorId: vatVendor, vendorInvoiceNumber: "X", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 2 }] };
    const key = newKey();
    const first = await postBill(body, { key });
    const again = await postBill(body, { key });
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.data.bill.id).toBe(first.body.data.bill.id);
    expect((await receiptLine(grn.id, 0)).billedQuantity).toBe(2);
    const other = await postBill({ ...body, vendorInvoiceNumber: "Y" }, { key });
    expect(other.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

// ==========================================
// Voiding bills
// ==========================================

describe("void a bill", () => {
  it("returns the billed quantity to the receipt and keeps the number", async () => {
    const grn = await receipt();
    const bill = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "X", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }] });
    const res = await voidBillReq(bill.id, 1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.message).toBe("Bill voided successfully.");
    expect(res.body.data.bill).toMatchObject({ number: bill.number, status: "void", version: 2, balanceDue: "0.000", voidReason: "Wrong vendor" });
    expect(res.body.data.bill.voided.by.name).toBe("Test User");
    expect((await receiptLine(grn.id, 0)).billedQuantity).toBe(0);

    const stale = await voidBillReq(bill.id, 1);
    expect([stale.status, stale.body.code, stale.body.errors[0].meta]).toEqual([409, "BILL_VERSION_CONFLICT", { currentVersion: 2 }]);
    const twice = await voidBillReq(bill.id, 2);
    expect([twice.status, twice.body.code]).toEqual([409, "BILL_STATUS_CONFLICT"]);
    const missing = await voidBillReq("665f1c2e8a4b3c0012ab3e00", 1);
    expect([missing.status, missing.body.code]).toEqual([404, "BILL_NOT_FOUND"]);
  });

  it("is refused while a payment is allocated; allowed once the payment is void", async () => {
    const bill = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "X", lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: "10.000" }] });
    const pay = await postPayment({ vendorId: vatVendor, amount: "5.000", method: "cash", allocations: [{ billId: bill.id, amount: "5.000" }] });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const blocked = await voidBillReq(bill.id, 2);
    expect([blocked.status, blocked.body.code, blocked.body.errors[0].meta]).toEqual([409, "BILL_HAS_PAYMENTS", { payments: ["PAY-00001"] }]);

    const payment = pay.body.data.payment;
    expect((await voidPaymentReq(payment.id, payment.version)).status).toBe(200);
    expect((await voidBillReq(bill.id, 3)).status).toBe(200);
  });
});

// ==========================================
// Payments
// ==========================================

describe("vendor payments", () => {
  async function twoBills() {
    const service = (unitCost: string) => [{ variantId: delivery.variantId, quantity: 1, unitCost }];
    const a = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "A", billDate: "2026-11-01", lines: service("100.000") }); // 110.000
    const b = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "B", billDate: "2026-11-02", lines: service("200.000") }); // 220.000
    return { a, b };
  }

  it("pays one bill in full and another in part, then voids the payment", async () => {
    const { a, b } = await twoBills();
    const res = await postPayment({
      vendorId: vatVendor,
      paymentDate: "2026-11-10",
      amount: "250.000",
      method: "bank_transfer",
      reference: "FT26318XK2",
      notes: "October",
      allocations: [
        { billId: a.id, amount: "110.000" },
        { billId: b.id, amount: "140.000" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.message).toBe("Vendor payment recorded successfully.");
    const { payment, bills } = res.body.data;
    expect(payment).toMatchObject({
      number: "PAY-00001",
      status: "posted",
      vendor: { id: vatVendor, name: "Gulf Roasters", isActive: true },
      paymentDate: "2026-11-10",
      amount: "250.000",
      method: "bank_transfer",
      reference: "FT26318XK2",
      notes: "October",
      version: 1,
      voided: null,
    });
    expect(payment.allocations).toEqual([
      { bill: { id: a.id, number: a.number, vendorInvoiceNumber: "A" }, amount: "110.000" },
      { bill: { id: b.id, number: b.number, vendorInvoiceNumber: "B" }, amount: "140.000" },
    ]);
    expect(bills.map((x: { status: string; paid: string; balanceDue: string; version: number }) => [x.status, x.paid, x.balanceDue, x.version])).toEqual([
      ["paid", "110.000", "0.000", 2],
      ["partially_paid", "140.000", "80.000", 2],
    ]);

    const detail = await request.get(`${BILLS}/${b.id}`).set(auth(admin));
    expect(detail.body.data.bill.payments).toEqual([
      expect.objectContaining({ id: payment.id, number: "PAY-00001", amount: "140.000", status: "posted", method: "bank_transfer" }),
    ]);

    const voided = await voidPaymentReq(payment.id, 1);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.payment).toMatchObject({ status: "void", version: 2, voidReason: "Cheque bounced" });
    expect(voided.body.data.bills.map((x: { status: string; paid: string }) => [x.status, x.paid])).toEqual([
      ["unpaid", "0.000"],
      ["unpaid", "0.000"],
    ]);
    const again = await voidPaymentReq(payment.id, 2);
    expect([again.status, again.body.code]).toEqual([409, "VENDOR_PAYMENT_STATUS_CONFLICT"]);
    const stale = await voidPaymentReq(payment.id, 1);
    expect([stale.status, stale.body.code]).toEqual([409, "VENDOR_PAYMENT_VERSION_CONFLICT"]);

    // Void payments are still listed on the bill, but do not count.
    const after = await request.get(`${BILLS}/${b.id}`).set(auth(admin));
    expect(after.body.data.bill.payments[0].status).toBe("void");
    expect(after.body.data.bill.balanceDue).toBe("220.000");
  });

  it("refuses paying more than is due, a paid bill, another vendor's bill and an unknown bill", async () => {
    const { a, b } = await twoBills();
    const over = await postPayment({ vendorId: vatVendor, amount: "120.000", method: "cash", allocations: [{ billId: a.id, amount: "120.000" }] });
    expect([over.status, over.body.code, over.body.errors[0]]).toEqual([
      409,
      "PAYMENT_EXCEEDS_DUE",
      expect.objectContaining({ field: "allocations[0].amount", meta: { balanceDue: "110.000" } }),
    ]);

    await postPayment({ vendorId: vatVendor, amount: "110.000", method: "cash", allocations: [{ billId: a.id, amount: "110.000" }] });
    const paid = await postPayment({ vendorId: vatVendor, amount: "1.000", method: "cash", allocations: [{ billId: a.id, amount: "1.000" }] });
    expect([paid.status, paid.body.code, paid.body.errors[0].meta]).toEqual([409, "BILL_STATUS_CONFLICT", { status: "paid" }]);

    const other = await postPayment({ vendorId: localVendor, amount: "1.000", method: "cash", allocations: [{ billId: b.id, amount: "1.000" }] });
    expect([other.status, other.body.code]).toEqual([400, "VENDOR_MISMATCH"]);

    const unknown = await postPayment({ vendorId: vatVendor, amount: "1.000", method: "cash", allocations: [{ billId: "665f1c2e8a4b3c0012ab3e00", amount: "1.000" }] });
    expect([unknown.status, unknown.body.code]).toEqual([404, "BILL_NOT_FOUND"]);

    const sum = await postPayment({ vendorId: vatVendor, amount: "2.000", method: "cash", allocations: [{ billId: b.id, amount: "1.000" }] });
    expect([sum.status, sum.body.code]).toEqual([400, "VALIDATION_FAILED"]);

    const decimals = await postPayment({ vendorId: vatVendor, amount: "1.0001", method: "cash", allocations: [{ billId: b.id, amount: "1.0001" }] });
    expect(decimals.status).toBe(400);

    const early = await postPayment({ vendorId: vatVendor, paymentDate: "2026-11-01", amount: "1.000", method: "cash", allocations: [{ billId: b.id, amount: "1.000" }] });
    expect([early.status, early.body.errors[0].field]).toEqual([400, "paymentDate"]);
  });

  it("two payments racing for one bill cannot pay more than is due between them", async () => {
    const { a } = await twoBills();
    const body = { vendorId: vatVendor, amount: "80.000", method: "cash", allocations: [{ billId: a.id, amount: "80.000" }] };
    const results = await Promise.all([postPayment(body), postPayment(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const bill = await request.get(`${BILLS}/${a.id}`).set(auth(admin));
    expect(bill.body.data.bill.paid).toBe("80.000");
  });
});

// ==========================================
// Lists
// ==========================================

describe("lists", () => {
  it("filters bills by status, overdue, vendor, dates and search; payments by bill, method and search", async () => {
    const service = (unitCost: string) => [{ variantId: delivery.variantId, quantity: 1, unitCost }];
    const old = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "OLD-1", billDate: "2026-10-01", dueDate: "2026-10-15", lines: service("1.000") });
    const fresh = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "NEW-1", dueDate: "2999-01-01", lines: service("1.000") });
    const local = await billOk({ vendorId: localVendor, vendorInvoiceNumber: "LOC-1", billDate: "2026-11-01", lines: service("3.000") });
    const pay = await postPayment({ vendorId: localVendor, amount: "1.000", method: "cheque", reference: "CHQ-77", allocations: [{ billId: local.id, amount: "1.000" }] });
    expect(pay.status).toBe(201);

    const ids = async (query: string) =>
      (await request.get(`${BILLS}${query}`).set(auth(admin))).body.data.bills.map((b: { id: string }) => b.id);
    expect(await ids("")).toEqual([local.id, fresh.id, old.id]);
    // The local vendor has no payment terms: its bill was due on its billDate.
    expect(await ids("?overdue=true")).toEqual([local.id, old.id]);
    expect(await ids("?status=partially_paid")).toEqual([local.id]);
    expect(await ids("?status=unpaid,bogus")).toEqual([fresh.id, old.id]);
    expect(await ids(`?vendorId=${localVendor}`)).toEqual([local.id]);
    expect(await ids("?vendorId=nope")).toEqual([]);
    expect(await ids("?from=2026-10-01&to=2026-10-31")).toEqual([old.id]);
    expect(await ids("?dueTo=2026-10-31")).toEqual([old.id]);
    expect(await ids("?search=old")).toEqual([old.id]);
    expect(await ids("?search=BILL-00003")).toEqual([local.id]);
    expect(await ids("?search=0000")).toEqual([local.id, fresh.id, old.id]);

    const list = await request.get(`${BILLS}?limit=1`).set(auth(admin));
    expect(list.body.data.pagination).toMatchObject({ total: 3, limit: 1 });
    expect(list.body.data.bills[0]).toMatchObject({ id: local.id, lineCount: 1, overdue: true });
    expect(list.body.data.bills[0].lines).toBeUndefined();

    const payments = async (query: string) =>
      (await request.get(`${PAYMENTS}${query}`).set(auth(admin))).body.data.payments.map((p: { number: string }) => p.number);
    expect(await payments(`?billId=${local.id}`)).toEqual(["PAY-00001"]);
    expect(await payments(`?billId=${old.id}`)).toEqual([]);
    expect(await payments("?method=cash")).toEqual([]);
    expect(await payments("?method=cheque&status=posted")).toEqual(["PAY-00001"]);
    expect(await payments("?search=chq")).toEqual(["PAY-00001"]);
    expect(await payments("?search=PAY")).toEqual(["PAY-00001"]);

    const one = await request.get(`${PAYMENTS}/${pay.body.data.payment.id}`).set(auth(admin));
    expect(one.status).toBe(200);
    expect(one.body.data.bills).toEqual([]);
    const summary = (await request.get(PAYMENTS).set(auth(admin))).body.data.payments[0];
    expect(summary).toMatchObject({ billCount: 1, vendor: { name: "Corner Supplier" } });
  });
});

// ==========================================
// Permissions
// ==========================================

describe("permissions", () => {
  it("accountants bill and pay; store roles cannot even read; a bill-only role cannot pay", async () => {
    const accountant = await tokenFor(ctx.org._id, "acc@alnoor.test", { orgRoleId: ctx.role("accountant")._id });
    const manager = await tokenFor(ctx.org._id, "mgr@alnoor.test", {
      storeAccess: [{ storeId: ctx.storeA._id, roleId: ctx.role("store_manager")._id }],
    });
    const billOnlyRole = await request
      .post("/api/v1/roles")
      .set(auth(admin))
      .send({ name: "AP clerk", scope: "organization", permissions: ["purchase:read", "purchase:bill"] });
    const billOnly = await tokenFor(ctx.org._id, "ap@alnoor.test", { orgRoleId: billOnlyRole.body.data.role.id });

    const service = [{ variantId: delivery.variantId, quantity: 1, unitCost: "1.000" }];
    const bill = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "ACC", lines: service }, { token: accountant });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const payBody = { vendorId: vatVendor, amount: "1.100", method: "cash", allocations: [{ billId: bill.body.data.bill.id, amount: "1.100" }] };

    expect((await request.get(BILLS).set(auth(manager))).status).toBe(403);
    expect((await request.get(PAYMENTS).set(auth(manager))).status).toBe(403);
    expect((await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "M", lines: service }, { token: manager })).status).toBe(403);
    expect((await postPayment(payBody, { token: billOnly })).status).toBe(403);
    expect((await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "AP", lines: service }, { token: billOnly })).status).toBe(201);
    expect((await postPayment(payBody, { token: accountant })).status).toBe(201);
  });

  it("store staff see billedQuantity on their receipt lines", async () => {
    const clerk = await tokenFor(ctx.org._id, "clerk@alnoor.test", {
      storeAccess: [{ storeId: ctx.storeA._id, roleId: ctx.role("inventory_clerk")._id }],
    });
    const grn = await receipt();
    await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "X", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 4 }] });
    const res = await request.get(`${grnPath()}/${grn.id}`).set(auth(clerk));
    expect(res.status).toBe(200);
    expect(res.body.data.goodsReceipt.lines[0].billedQuantity).toBe(4);
  });
});

// ==========================================
// Catalog and vendor rules
// ==========================================

describe("catalog and vendor rules", () => {
  it("a product received as untracked goods, or billed as a service, cannot be deleted", async () => {
    await receipt({ lines: [{ variantId: bags.variantId, quantity: 10, unitCost: "0.050" }] });
    const bagsDelete = await request.delete(`${PRODUCTS}/${bags.productId}`).set(auth(admin));
    expect([bagsDelete.status, bagsDelete.body.code]).toEqual([409, "PRODUCT_IN_USE"]);

    await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "X", lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: "1.000" }] });
    const serviceDelete = await request.delete(`${PRODUCTS}/${delivery.productId}`).set(auth(admin));
    expect([serviceDelete.status, serviceDelete.body.code]).toEqual([409, "PRODUCT_IN_USE"]);

    const unused = await product({ ...serviceExample, name: "Unused service" });
    expect((await request.delete(`${PRODUCTS}/${unused.productId}`).set(auth(admin))).status).toBe(200);
  });

  it("a vendor with a bill cannot be deleted; a deactivated vendor can still be billed and paid", async () => {
    const fresh = await vendor({ name: "Fresh Vendor" });
    const bill = await billOk({ vendorId: fresh, vendorInvoiceNumber: "X", lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: "1.000" }] });
    const del = await request.delete(`${VENDORS}/${fresh}`).set(auth(admin));
    expect([del.status, del.body.code]).toEqual([409, "VENDOR_IN_USE"]);

    expect((await request.patch(`${VENDORS}/${fresh}`).set(auth(admin)).send({ isActive: false })).status).toBe(200);
    await billOk({ vendorId: fresh, vendorInvoiceNumber: "Y", lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: "1.000" }] });
    const pay = await postPayment({ vendorId: fresh, amount: "1.000", method: "other", allocations: [{ billId: bill.id, amount: "1.000" }] });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.data.payment.vendor.isActive).toBe(false);
  });

  it("receipts stay final apart from the billed quantity", async () => {
    const grn = await receipt();
    await expect(GoodsReceipt.updateOne({ _id: grn.id }, { $set: { notes: "edited" } })).rejects.toThrow(/final/);
    await expect(GoodsReceipt.updateOne({ _id: grn.id }, { $inc: { "lines.$[].quantityMilli": 1 } })).rejects.toThrow(/final/);
  });
});
