/**
 * Purpose: Phase 3e vendor returns and debit notes over HTTP: unbilled-first returns, credit on
 * the named bill line, stock and receipt counters, debit notes applied to their bill or kept as
 * vendor credit, applying spare credit, price adjustments and their void, the bill and payment
 * rules credit changes, the 404/400/409 codes, permissions, idempotency, lists and the
 * documented response schemas.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { StockLevel } from "../../src/models/stockLevel.model";
import { StockMovement } from "../../src/models/stockMovement.model";
import { Vendor } from "../../src/models/vendor.model";
import { DebitNote } from "../../src/models/debitNote.model";
import { VendorReturn } from "../../src/models/vendorReturn.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { singleExample } from "../../src/docs/product.openapi";
import {
  BillLineSchema,
  BillSchema,
  BillSummarySchema,
  DebitNoteApplicationSchema,
  DebitNoteLineSchema,
  DebitNoteSchema,
  DebitNoteSummarySchema,
  GoodsReceiptLineSchema,
  VendorReturnLineSchema,
  VendorReturnSchema,
  VendorReturnSummarySchema,
} from "../../src/validators/responses";

const PRODUCTS = "/api/v1/products";
const VENDORS = "/api/v1/vendors";
const BILLS = "/api/v1/bills";
const PAYMENTS = "/api/v1/vendor-payments";
const NOTES = "/api/v1/debit-notes";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let keySeq = 0;
const newKey = () => `rtn-key-${Date.now()}-${(keySeq += 1)}`;

async function setup(slug: string) {
  const org = await Organization.create({
    name: slug,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    taxRegistrationNumber: "220000111100003",
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
let otherVendor: string;
let coffee: { variantId: string; productId: string }; // standard, tracked
let bags: { variantId: string; productId: string }; // untracked goods

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

beforeEach(async () => {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
  vatVendor = await vendor({ name: "Gulf Roasters", taxRegistrationNumber: "220000987600003", paymentTermsDays: 30 });
  otherVendor = await vendor({ name: "Corner Supplier" });
  coffee = await product(goods({ name: "Coffee", sku: "COF-1", purchase: { costPrice: "1.600" } }));
  bags = await product(goods({ name: "Bags", sku: "BAG-1", inventory: { trackInventory: false } }));
});

const grnPath = (storeId: unknown = ctx.storeA._id) => `/api/v1/stores/${storeId}/goods-receipts`;
const rtnPath = (storeId: unknown = ctx.storeA._id) => `/api/v1/stores/${storeId}/vendor-returns`;

/** A receipt without a PO: 24 coffee at 1.600 by default. */
async function receipt(opts: { vendorId?: string; storeId?: unknown; lines?: Record<string, unknown>[] } = {}) {
  const res = await request
    .post(grnPath(opts.storeId))
    .set(auth(admin))
    .set("Idempotency-Key", newKey())
    .send({
      vendorId: opts.vendorId ?? vatVendor,
      receivedDate: "2026-11-01",
      lines: opts.lines ?? [{ variantId: coffee.variantId, quantity: 24, unitCost: "1.600" }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const grn = res.body.data.goodsReceipt;
  return { id: grn.id as string, lines: grn.lines.map((l: { id: string }) => l.id) as string[] };
}

async function bill(grn: { id: string; lines: string[] }, opts: { quantity?: number; unitCost?: string; invoice?: string; vendorId?: string } = {}) {
  const res = await request
    .post(BILLS)
    .set(auth(admin))
    .set("Idempotency-Key", newKey())
    .send({
      vendorId: opts.vendorId ?? vatVendor,
      vendorInvoiceNumber: opts.invoice ?? `INV-${keySeq}`,
      billDate: "2026-11-05",
      lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: opts.quantity, unitCost: opts.unitCost }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.bill;
}

const postReturn = (body: Record<string, unknown>, opts: { token?: string; key?: string; storeId?: unknown } = {}) =>
  request
    .post(rtnPath(opts.storeId))
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send({ vendorId: vatVendor, reason: "damaged", returnDate: "2026-11-10", ...body });

async function returnOk(body: Record<string, unknown>) {
  const res = await postReturn(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.vendorReturn;
}

const line = (grn: { id: string; lines: string[] }, quantity: number, extra: Record<string, unknown> = {}) => ({
  goodsReceiptId: grn.id,
  goodsReceiptLineId: grn.lines[0],
  quantity,
  ...extra,
});

const postNote = (body: Record<string, unknown>, key = newKey()) =>
  request.post(NOTES).set(auth(admin)).set("Idempotency-Key", key).send({ reason: "Billed above the agreed price.", ...body });

const applyNote = (id: string, body: Record<string, unknown>, key = newKey()) =>
  request.post(`${NOTES}/${id}/apply`).set(auth(admin)).set("Idempotency-Key", key).send(body);

const voidNote = (id: string, version: number, key = newKey()) =>
  request.post(`${NOTES}/${id}/void`).set(auth(admin)).set("Idempotency-Key", key).send({ version, reason: "Vendor disagreed" });

const getBill = async (id: string) => (await request.get(`${BILLS}/${id}`).set(auth(admin))).body.data.bill;
const getNote = async (id: string) => (await request.get(`${NOTES}/${id}`).set(auth(admin))).body.data.debitNote;
const receiptLine = async (grnId: string) =>
  (await request.get(`${grnPath()}/${grnId}`).set(auth(admin))).body.data.goodsReceipt.lines[0];
const stockOf = async (variantId: string, storeId: unknown = ctx.storeA._id) =>
  StockLevel.findOne({ organizationId: ctx.org._id, storeId, variantId });

function strictOk(schema: z.ZodTypeAny, value: unknown) {
  const parsed = schema.safeParse(value);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
}

// ==========================================
// Returning goods
// ==========================================

describe("return goods that were never billed", () => {
  it("takes stock out at average cost, raises returnedQuantity, lowers billableQuantity and creates no debit note", async () => {
    const grn = await receipt();
    const before = await Vendor.findById(vatVendor);
    const res = await postReturn({ lines: [line(grn, 4, { note: "Seal broken" })], vendorReference: "RMA-1" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.message).toBe("Vendor return posted successfully.");
    const rtn = res.body.data.vendorReturn;
    expect(rtn).toMatchObject({
      number: "RTN-00001",
      returnDate: "2026-11-10",
      reason: "damaged",
      vendorReference: "RMA-1",
      stockValue: "6.400",
      credit: "0.000",
      debitNotes: [],
    });
    expect(rtn.lines[0]).toMatchObject({
      quantity: 4,
      unbilledQuantity: 4,
      creditedQuantity: 0,
      billLine: null,
      stocked: true,
      unitCost: "1.600",
      stockValue: "6.400",
      quantityAfter: 20,
      note: "Seal broken",
    });

    const level = await stockOf(coffee.variantId);
    expect([level!.quantityMilli, level!.avgCostMinor]).toEqual([20000, 1600]);
    const movement = await StockMovement.findOne({ organizationId: ctx.org._id, type: "vendor_return" });
    expect(movement).toMatchObject({ quantityMilli: -4000, unitCostMinor: 1600, reason: "damaged" });
    expect(movement!.source).toMatchObject({ type: "vendor_return", number: "RTN-00001" });

    expect(await receiptLine(grn.id)).toMatchObject({ billedQuantity: 0, returnedQuantity: 4, billableQuantity: 20 });
    expect((await Vendor.findById(vatVendor))!.purchaseDocumentCount).toBe(before!.purchaseDocumentCount + 1);
  });

  it("returned unbilled goods can no longer be billed", async () => {
    const grn = await receipt();
    await returnOk({ lines: [line(grn, 4)] });
    const over = await request
      .post(BILLS)
      .set(auth(admin))
      .set("Idempotency-Key", newKey())
      .send({ vendorId: vatVendor, vendorInvoiceNumber: "X", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 21 }] });
    expect([over.status, over.body.code]).toEqual([409, "BILLED_QUANTITY_EXCEEDS_RECEIVED"]);
    expect(over.body.errors[0].meta).toMatchObject({ remaining: 20 });
    // The default quantity is what is left to bill.
    const ok = await bill(grn);
    expect(ok.lines[0].quantity).toBe(20);
    expect(await receiptLine(grn.id)).toMatchObject({ billedQuantity: 20, returnedQuantity: 4, billableQuantity: 0 });
  });

  it("untracked goods are recorded without a stock movement", async () => {
    const grn = await receipt({ lines: [{ variantId: bags.variantId, quantity: 10, unitCost: "0.100" }] });
    const rtn = await returnOk({ lines: [line(grn, 3)] });
    expect(rtn.lines[0]).toMatchObject({ stocked: false, unitCost: null, stockValue: "0.000", quantityAfter: null });
    expect(await StockMovement.countDocuments({ organizationId: ctx.org._id, type: "vendor_return" })).toBe(0);
  });
});

describe("return goods that were billed", () => {
  it("takes unbilled first, credits the rest on the named bill line and applies the debit note to the bill", async () => {
    const grn = await receipt();
    // 20 of 24 billed at 1.650 + 10% VAT: 33.000 + 3.300 = 36.300.
    const billed = await bill(grn, { quantity: 20, unitCost: "1.650" });
    expect(billed.total).toBe("36.300");

    const rtn = await returnOk({ lines: [line(grn, 6, { billId: billed.id, billLineId: billed.lines[0].id })] });
    expect(rtn.lines[0]).toMatchObject({
      quantity: 6,
      unbilledQuantity: 4,
      creditedQuantity: 2,
      billLine: { bill: { id: billed.id, number: billed.number }, lineId: billed.lines[0].id, unitCost: "1.650" },
    });
    // 2 × 1.650 = 3.300 + 0.330 VAT
    expect(rtn.credit).toBe("3.630");
    expect(rtn.debitNotes).toEqual([{ id: expect.any(String), number: "DN-00001", bill: { id: billed.id, number: billed.number }, total: "3.630" }]);

    const note = await getNote(rtn.debitNotes[0].id);
    expect(note).toMatchObject({
      type: "return",
      status: "applied",
      vendorReturn: { number: "RTN-00001" },
      bill: { id: billed.id, vendorInvoiceNumber: billed.vendorInvoiceNumber, billDate: "2026-11-05" },
      debitNoteDate: "2026-11-10",
      reason: "Goods returned on RTN-00001 (damaged)",
      subtotal: "3.300",
      tax: "0.330",
      total: "3.630",
      applied: "3.630",
      unapplied: "0.000",
    });
    expect(note.lines[0]).toMatchObject({ quantity: 2, unitCost: "1.650", subtotal: "3.300", tax: { tax: "0.330" } });

    const after = await getBill(billed.id);
    expect(after).toMatchObject({ status: "partially_paid", paid: "0.000", credited: "3.630", balanceDue: "32.670", version: 2 });
    expect(after.lines[0]).toMatchObject({ returnedQuantity: 2, credited: "3.300" });
    expect(after.debitNotes).toEqual([{ id: note.id, number: "DN-00001", type: "return", amount: "3.630", status: "applied" }]);
    expect(await receiptLine(grn.id)).toMatchObject({ billedQuantity: 20, returnedQuantity: 6, billableQuantity: 0 });
  });

  it("returning everything billed gives back exactly the line's VAT and settles the bill", async () => {
    const grn = await receipt({ lines: [{ variantId: coffee.variantId, quantity: 3, unitCost: "0.333" }] });
    const billed = await bill(grn); // 0.999 + 0.100 VAT (rounded) = 1.099
    // One unit at a time: each 0.333 → 0.033 VAT; the last one takes what is left (0.034).
    for (const quantity of [1, 1, 1]) {
      await returnOk({ lines: [line(grn, quantity, { billId: billed.id, billLineId: billed.lines[0].id })] });
    }
    const after = await getBill(billed.id);
    expect(after.lines[0].credited).toBe(after.lines[0].subtotal);
    expect(after).toMatchObject({ credited: after.total, balanceDue: "0.000", status: "paid" });
    expect(after.lines[0].tax.tax).toBe("0.100");
    const notes = await DebitNote.find({ organizationId: ctx.org._id }).sort({ sequence: 1 });
    expect(notes.map((n) => n.taxMinor)).toEqual([33, 33, 34]);
  });

  it("refuses the billed part without a bill line (BILL_LINE_REQUIRED) and with too little left on it", async () => {
    const grn = await receipt();
    const billed = await bill(grn, { quantity: 20 });
    const missing = await postReturn({ lines: [line(grn, 5)] });
    expect([missing.status, missing.body.code]).toEqual([409, "BILL_LINE_REQUIRED"]);
    expect(missing.body.errors[0]).toMatchObject({ field: "lines[0].quantity", meta: { billable: 4 } });

    await returnOk({ lines: [line(grn, 22, { billId: billed.id, billLineId: billed.lines[0].id })] }); // 4 unbilled + 18 credited
    const tooMany = await postReturn({ lines: [line(grn, 2, { billId: billed.id, billLineId: billed.lines[0].id })] }); // 2 credited, 2 left
    expect(tooMany.status, JSON.stringify(tooMany.body)).toBe(201);
    const none = await postReturn({ lines: [line(grn, 1, { billId: billed.id, billLineId: billed.lines[0].id })] });
    expect([none.status, none.body.code]).toEqual([409, "RETURNED_QUANTITY_EXCEEDS_RECEIVED"]);
    expect(none.body.errors[0].meta).toEqual({ received: 24, returned: 24, remaining: 0 });
  });

  it("a fully paid bill keeps the credit on the note as vendor credit", async () => {
    const grn = await receipt();
    const billed = await bill(grn); // 38.400 + 3.840 = 42.240
    const pay = await request
      .post(PAYMENTS)
      .set(auth(admin))
      .set("Idempotency-Key", newKey())
      .send({ vendorId: vatVendor, amount: "42.240", method: "cash", allocations: [{ billId: billed.id, amount: "42.240" }] });
    expect(pay.status).toBe(201);

    const rtn = await returnOk({ lines: [line(grn, 2, { billId: billed.id, billLineId: billed.lines[0].id })] });
    const note = await getNote(rtn.debitNotes[0].id);
    expect(note).toMatchObject({ status: "open", total: "3.520", applied: "0.000", unapplied: "3.520", applications: [] });
    const after = await getBill(billed.id);
    expect(after).toMatchObject({ status: "paid", credited: "0.000", balanceDue: "0.000" });
    expect(after.lines[0]).toMatchObject({ returnedQuantity: 2, credited: "3.200" });

    const open = await request.get(`${NOTES}?vendorId=${vatVendor}&status=open`).set(auth(admin));
    expect(open.body.data.debitNotes.map((n: { number: string }) => n.number)).toEqual([note.number]);
  });
});

describe("return problems", () => {
  it("another store's receipt is not found; another vendor's is a mismatch; a wrong bill line too", async () => {
    const grnB = await receipt({ storeId: ctx.storeB._id });
    const other = await postReturn({ lines: [line(grnB, 1)] });
    expect([other.status, other.body.code]).toEqual([404, "GOODS_RECEIPT_NOT_FOUND"]);

    const grnOther = await receipt({ vendorId: otherVendor });
    const mismatch = await postReturn({ lines: [line(grnOther, 1)] });
    expect([mismatch.status, mismatch.body.code]).toEqual([400, "VENDOR_MISMATCH"]);

    const grn1 = await receipt();
    const grn2 = await receipt();
    const billed = await bill(grn1);
    const wrongLine = await postReturn({ lines: [line(grn2, 1, { billId: billed.id, billLineId: billed.lines[0].id })] });
    expect([wrongLine.status, wrongLine.body.code]).toEqual([400, "BILL_LINE_MISMATCH"]);

    const missingBill = await postReturn({ lines: [line(grn1, 1, { billId: grn1.id, billLineId: grn1.lines[0] })] });
    expect([missingBill.status, missingBill.body.code]).toEqual([404, "BILL_NOT_FOUND"]);

    const noVendor = await postReturn({ vendorId: grn1.id, lines: [line(grn1, 1)] });
    expect([noVendor.status, noVendor.body.code]).toEqual([400, "VENDOR_NOT_FOUND"]);
  });

  it("needs the stock on hand, even when negative stock is allowed", async () => {
    await Organization.updateOne({ _id: ctx.org._id }, { $set: { "settings.inventory.allowNegativeStock": true } });
    const grn = await receipt();
    const adjust = await request
      .post(`/api/v1/stores/${ctx.storeA._id}/stock-adjustments`)
      .set(auth(admin))
      .set("Idempotency-Key", newKey())
      .send({ reason: "damaged", lines: [{ variantId: coffee.variantId, quantityChange: -22 }] });
    expect(adjust.status, JSON.stringify(adjust.body)).toBe(201);
    const res = await postReturn({ lines: [line(grn, 3)] });
    expect([res.status, res.body.code]).toEqual([409, "INSUFFICIENT_STOCK"]);
    expect(res.body.errors[0]).toMatchObject({ field: "lines[0]", meta: { available: 2, requested: 3 } });
    expect((await stockOf(coffee.variantId))!.quantityMilli).toBe(2000);
  });

  it("dates: not in the future, not before the receipt, not before a credited bill", async () => {
    const grn = await receipt();
    const future = await postReturn({ returnDate: "2999-01-01", lines: [line(grn, 1)] });
    expect([future.status, future.body.errors[0].field]).toEqual([400, "returnDate"]);
    const early = await postReturn({ returnDate: "2026-10-31", lines: [line(grn, 1)] });
    expect([early.status, early.body.errors[0].field]).toEqual([400, "returnDate"]);
    const billed = await bill(grn);
    const beforeBill = await postReturn({ returnDate: "2026-11-02", lines: [line(grn, 1, { billId: billed.id, billLineId: billed.lines[0].id })] });
    expect([beforeBill.status, beforeBill.body.errors[0].field]).toEqual([400, "returnDate"]);
  });

  it("a void bill gives its quantity back to unbilled, and cannot be credited", async () => {
    const grn = await receipt();
    const voidedBill = await bill(grn, { invoice: "V" });
    const voided = await request.post(`${BILLS}/${voidedBill.id}/void`).set(auth(admin)).set("Idempotency-Key", newKey()).send({ version: 1, reason: "x" });
    expect(voided.status).toBe(200);
    // Everything is unbilled again: the bill line named is ignored.
    const rtn = await returnOk({ lines: [line(grn, 1, { billId: voidedBill.id, billLineId: voidedBill.lines[0].id })] });
    expect(rtn.lines[0]).toMatchObject({ unbilledQuantity: 1, billLine: null });

    // Billed again on a live bill: naming the void bill's line for the billed part is refused.
    await bill(grn, { invoice: "W" });
    const res = await postReturn({ lines: [line(grn, 1, { billId: voidedBill.id, billLineId: voidedBill.lines[0].id })] });
    expect([res.status, res.body.code]).toEqual([409, "BILL_STATUS_CONFLICT"]);
    expect(res.body.errors[0].field).toBe("lines[0].billId");
  });

  it("a retried request with the same key returns the same return and takes stock once", async () => {
    const grn = await receipt();
    const key = newKey();
    const first = await postReturn({ lines: [line(grn, 2)] }, { key });
    const again = await postReturn({ lines: [line(grn, 2)] }, { key });
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.data.vendorReturn.number).toBe(first.body.data.vendorReturn.number);
    expect((await stockOf(coffee.variantId))!.quantityMilli).toBe(22000);
    expect(await VendorReturn.countDocuments({ organizationId: ctx.org._id })).toBe(1);
  });
});

// ==========================================
// Bills and payments with credit
// ==========================================

describe("credit on bills", () => {
  it("payments see the balance after credit, and a credited bill cannot be voided", async () => {
    const grn = await receipt();
    const billed = await bill(grn); // 42.240
    await returnOk({ lines: [line(grn, 2, { billId: billed.id, billLineId: billed.lines[0].id })] }); // 3.520 credit
    const over = await request
      .post(PAYMENTS)
      .set(auth(admin))
      .set("Idempotency-Key", newKey())
      .send({ vendorId: vatVendor, amount: "42.240", method: "cash", allocations: [{ billId: billed.id, amount: "42.240" }] });
    expect([over.status, over.body.code]).toEqual([409, "PAYMENT_EXCEEDS_DUE"]);
    expect(over.body.errors[0].meta).toEqual({ balanceDue: "38.720" });

    const exact = await request
      .post(PAYMENTS)
      .set(auth(admin))
      .set("Idempotency-Key", newKey())
      .send({ vendorId: vatVendor, amount: "38.720", method: "cash", allocations: [{ billId: billed.id, amount: "38.720" }] });
    expect(exact.status).toBe(201);
    expect(exact.body.data.bills[0]).toMatchObject({ status: "paid", balanceDue: "0.000", credited: "3.520" });

    // Voiding the payment leaves the credit: partially paid, not unpaid.
    const payment = exact.body.data.payment;
    const voidPay = await request.post(`${PAYMENTS}/${payment.id}/void`).set(auth(admin)).set("Idempotency-Key", newKey()).send({ version: 1, reason: "x" });
    expect(voidPay.body.data.bills[0]).toMatchObject({ status: "partially_paid", balanceDue: "38.720" });

    const current = await getBill(billed.id);
    const voidBill = await request.post(`${BILLS}/${billed.id}/void`).set(auth(admin)).set("Idempotency-Key", newKey()).send({ version: current.version, reason: "x" });
    expect([voidBill.status, voidBill.body.code]).toEqual([409, "BILL_HAS_CREDITS"]);
    expect(voidBill.body.errors[0].meta).toEqual({ debitNotes: ["DN-00001"] });
  });
});

describe("price adjustment debit notes", () => {
  it("credits the bill line at its VAT rate, refuses more than the line has left, and voids cleanly", async () => {
    const grn = await receipt();
    const billed = await bill(grn, { unitCost: "1.650" }); // 39.600 + 3.960 = 43.560
    const res = await postNote({ billId: billed.id, debitNoteDate: "2026-11-06", vendorReference: "CN-1", lines: [{ billLineId: billed.lines[0].id, amount: "1.200" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const note = res.body.data.debitNote;
    expect(note).toMatchObject({
      number: "DN-00001",
      type: "price_adjustment",
      status: "applied",
      vendorReturn: null,
      vendorReference: "CN-1",
      subtotal: "1.200",
      tax: "0.120",
      total: "1.320",
      applied: "1.320",
    });
    expect(note.lines[0]).toMatchObject({ quantity: null, unitCost: null, subtotal: "1.200", tax: { taxRate: { rate: 10 }, tax: "0.120" } });
    expect(res.body.data.bills[0]).toMatchObject({ credited: "1.320", balanceDue: "42.240", status: "partially_paid" });

    const tooMuch = await postNote({ billId: billed.id, lines: [{ billLineId: billed.lines[0].id, amount: "38.401" }] });
    expect([tooMuch.status, tooMuch.body.code]).toEqual([409, "CREDIT_EXCEEDS_BILLED"]);
    expect(tooMuch.body.errors[0].meta).toEqual({ subtotal: "39.600", credited: "1.200", remaining: "38.400" });

    const stale = await voidNote(note.id, 9);
    expect([stale.status, stale.body.code]).toEqual([409, "DEBIT_NOTE_VERSION_CONFLICT"]);
    const voided = await voidNote(note.id, note.version);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.debitNote).toMatchObject({ status: "void", applied: "0.000", unapplied: "0.000", voidReason: "Vendor disagreed" });
    expect(voided.body.data.bills[0]).toMatchObject({ credited: "0.000", balanceDue: "43.560", status: "unpaid" });
    expect((await getBill(billed.id)).lines[0].credited).toBe("0.000");
    const again = await voidNote(note.id, voided.body.data.debitNote.version);
    expect([again.status, again.body.code]).toEqual([409, "DEBIT_NOTE_STATUS_CONFLICT"]);

    // With the note void, the bill can be voided again.
    const current = await getBill(billed.id);
    const voidBill = await request.post(`${BILLS}/${billed.id}/void`).set(auth(admin)).set("Idempotency-Key", newKey()).send({ version: current.version, reason: "x" });
    expect(voidBill.status).toBe(200);
  });

  it("a return's note cannot be voided; problems on create come back coded", async () => {
    const grn = await receipt();
    const billed = await bill(grn);
    const rtn = await returnOk({ lines: [line(grn, 1, { billId: billed.id, billLineId: billed.lines[0].id })] });
    const note = await getNote(rtn.debitNotes[0].id);
    const res = await voidNote(note.id, note.version);
    expect([res.status, res.body.code]).toEqual([409, "DEBIT_NOTE_FROM_RETURN"]);
    expect(res.body.errors[0].meta).toEqual({ vendorReturnNumber: "RTN-00001" });

    const noBill = await postNote({ billId: grn.id, lines: [{ billLineId: grn.lines[0], amount: "1.000" }] });
    expect([noBill.status, noBill.body.code, noBill.body.errors[0].field]).toEqual([404, "BILL_NOT_FOUND", "billId"]);
    const noLine = await postNote({ billId: billed.id, lines: [{ billLineId: grn.lines[0], amount: "1.000" }] });
    expect([noLine.status, noLine.body.errors[0].field]).toEqual([404, "lines[0].billLineId"]);
    const decimals = await postNote({ billId: billed.id, lines: [{ billLineId: billed.lines[0].id, amount: "1.0001" }] });
    expect(decimals.status).toBe(400);
    const early = await postNote({ billId: billed.id, debitNoteDate: "2026-11-04", lines: [{ billLineId: billed.lines[0].id, amount: "1.000" }] });
    expect([early.status, early.body.errors[0].field]).toEqual([400, "debitNoteDate"]);
  });
});

describe("applying spare credit", () => {
  it("applies an open note's credit to the vendor's other bills, within what is left and what they owe", async () => {
    const grn1 = await receipt();
    const grn2 = await receipt();
    const bill1 = await bill(grn1, { invoice: "A" }); // 42.240
    await request
      .post(PAYMENTS)
      .set(auth(admin))
      .set("Idempotency-Key", newKey())
      .send({ vendorId: vatVendor, amount: "42.240", method: "cash", allocations: [{ billId: bill1.id, amount: "42.240" }] });
    const bill2 = await bill(grn2, { invoice: "B", quantity: 2 }); // 3.200 + 0.320 = 3.520
    const rtn = await returnOk({ lines: [line(grn1, 5, { billId: bill1.id, billLineId: bill1.lines[0].id })] }); // 8.000 + 0.800
    const note = await getNote(rtn.debitNotes[0].id);
    expect(note).toMatchObject({ status: "open", unapplied: "8.800" });

    const stale = await applyNote(note.id, { version: 7, applications: [{ billId: bill2.id, amount: "1.000" }] });
    expect([stale.status, stale.body.code]).toEqual([409, "DEBIT_NOTE_VERSION_CONFLICT"]);
    const tooMuch = await applyNote(note.id, { version: note.version, applications: [{ billId: bill2.id, amount: "8.801" }] });
    expect([tooMuch.status, tooMuch.body.code]).toEqual([409, "CREDIT_EXCEEDS_AVAILABLE"]);
    const overDue = await applyNote(note.id, { version: note.version, applications: [{ billId: bill2.id, amount: "3.521" }] });
    expect([overDue.status, overDue.body.code]).toEqual([409, "CREDIT_EXCEEDS_DUE"]);
    expect(overDue.body.errors[0].meta).toEqual({ balanceDue: "3.520" });
    const paidBill = await applyNote(note.id, { version: note.version, applications: [{ billId: bill1.id, amount: "1.000" }] });
    expect([paidBill.status, paidBill.body.code]).toEqual([409, "BILL_STATUS_CONFLICT"]);

    const grnOther = await receipt({ vendorId: otherVendor });
    const otherBill = await bill(grnOther, { vendorId: otherVendor, invoice: "O" });
    const mismatch = await applyNote(note.id, { version: note.version, applications: [{ billId: otherBill.id, amount: "1.000" }] });
    expect([mismatch.status, mismatch.body.code]).toEqual([400, "VENDOR_MISMATCH"]);

    const ok = await applyNote(note.id, { version: note.version, applications: [{ billId: bill2.id, amount: "3.520" }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.debitNote).toMatchObject({ status: "open", applied: "3.520", unapplied: "5.280", version: note.version + 1 });
    expect(ok.body.data.debitNote.applications.map((a: { bill: { id: string }; amount: string }) => [a.bill.id, a.amount])).toEqual([[bill2.id, "3.520"]]);
    expect(ok.body.data.bills[0]).toMatchObject({ id: bill2.id, status: "paid", credited: "3.520", balanceDue: "0.000" });
    expect((await getBill(bill2.id)).debitNotes).toEqual([{ id: note.id, number: note.number, type: "return", amount: "3.520", status: "open" }]);

    const list = await request.get(`${NOTES}?billId=${bill2.id}`).set(auth(admin));
    expect(list.body.data.debitNotes.map((n: { id: string }) => n.id)).toEqual([note.id]);
  });
});

// ==========================================
// Permissions, lists and schemas
// ==========================================

describe("permissions", () => {
  it("store managers return goods; clerks cannot; store roles cannot read debit notes", async () => {
    const access = (slug: string) => [{ storeId: ctx.storeA._id, roleId: ctx.role(slug)._id }];
    const manager = await tokenFor(ctx.org._id, "m@alnoor.test", { storeAccess: access("store_manager") });
    const clerk = await tokenFor(ctx.org._id, "c@alnoor.test", { storeAccess: access("inventory_clerk") });
    const grn = await receipt();

    expect((await postReturn({ lines: [line(grn, 1)] }, { token: clerk })).status).toBe(403);
    expect((await postReturn({ lines: [line(grn, 1)] }, { token: manager })).status).toBe(201);
    expect((await postReturn({ lines: [line(grn, 1)] }, { token: manager, storeId: ctx.storeB._id })).status).toBe(403);

    expect((await request.get(NOTES).set(auth(manager))).status).toBe(403);
    expect((await request.get(rtnPath()).set(auth(clerk))).status).toBe(200);
    const all = await request.get("/api/v1/vendor-returns").set(auth(manager));
    expect(all.body.data.vendorReturns).toHaveLength(1);
  });

  it("hides stock costs without inventory:read", async () => {
    const custom = await request
      .post("/api/v1/roles")
      .set(auth(admin))
      .send({ name: "Returns only", scope: "store", permissions: ["purchase:read", "purchase:return"] });
    expect(custom.status).toBe(201);
    const returner = await tokenFor(ctx.org._id, "r@alnoor.test", { storeAccess: [{ storeId: ctx.storeA._id, roleId: custom.body.data.role.id }] });
    const grn = await receipt();
    const res = await postReturn({ lines: [line(grn, 1)] }, { token: returner });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.vendorReturn).toMatchObject({ stockValue: null });
    expect(res.body.data.vendorReturn.lines[0]).toMatchObject({ unitCost: null, stockValue: null });
  });
});

describe("lists and response schemas", () => {
  it("filters returns and matches every documented schema strictly", async () => {
    const grn = await receipt();
    const grnB = await receipt({ storeId: ctx.storeB._id });
    const billed = await bill(grn, { quantity: 20 });
    const rtn = await returnOk({ reason: "expired", lines: [line(grn, 6, { billId: billed.id, billLineId: billed.lines[0].id })] });
    const rtnB = await postReturn({ reason: "excess", lines: [line(grnB, 1)] }, { storeId: ctx.storeB._id });
    expect(rtnB.status).toBe(201);

    const byReceipt = await request.get(`/api/v1/vendor-returns?goodsReceiptId=${grn.id}`).set(auth(admin));
    expect(byReceipt.body.data.vendorReturns.map((r: { id: string }) => r.id)).toEqual([rtn.id]);
    const byReason = await request.get("/api/v1/vendor-returns?reason=excess").set(auth(admin));
    expect(byReason.body.data.vendorReturns).toHaveLength(1);
    const byStore = await request.get(rtnPath(ctx.storeB._id)).set(auth(admin));
    expect(byStore.body.data.vendorReturns.map((r: { number: string }) => r.number)).toEqual([rtnB.body.data.vendorReturn.number]);
    const search = await request.get(`/api/v1/vendor-returns?search=${rtn.number}`).set(auth(admin));
    expect(search.body.data.vendorReturns).toHaveLength(1);

    strictOk(VendorReturnSchema.strict(), rtn);
    for (const l of rtn.lines) strictOk(VendorReturnLineSchema.strict(), l);
    for (const s of byReceipt.body.data.vendorReturns) strictOk(VendorReturnSummarySchema.strict(), s);

    const note = await request.get(`${NOTES}/${rtn.debitNotes[0].id}`).set(auth(admin));
    strictOk(DebitNoteSchema.strict(), note.body.data.debitNote);
    for (const l of note.body.data.debitNote.lines) strictOk(DebitNoteLineSchema.strict(), l);
    for (const a of note.body.data.debitNote.applications) strictOk(DebitNoteApplicationSchema.strict(), a);
    const notes = await request.get(`${NOTES}?vendorReturnId=${rtn.id}&type=return`).set(auth(admin));
    expect(notes.body.data.debitNotes).toHaveLength(1);
    for (const s of notes.body.data.debitNotes) strictOk(DebitNoteSummarySchema.strict(), s);

    const fullBill = await getBill(billed.id);
    strictOk(BillSchema.strict(), fullBill);
    for (const l of fullBill.lines) strictOk(BillLineSchema.strict(), l);
    const bills = await request.get(BILLS).set(auth(admin));
    for (const b of bills.body.data.bills) strictOk(BillSummarySchema.strict(), b);
    strictOk(GoodsReceiptLineSchema.strict(), await receiptLine(grn.id));

    const got = await request.get(`${rtnPath()}/${rtn.id}`).set(auth(admin));
    expect(got.body.data.vendorReturn).toEqual(rtn);
    const otherStore = await request.get(`${rtnPath(ctx.storeB._id)}/${rtn.id}`).set(auth(admin));
    expect([otherStore.status, otherStore.body.code]).toEqual([404, "VENDOR_RETURN_NOT_FOUND"]);
  });
});
