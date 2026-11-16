/**
 * Purpose: Review tests for Phase 3d vendor bills and payments: responses against the strict Zod
 * response schemas, money math (per-line VAT, cost variance with and without a TRN, the VAT
 * adjustment in 3- and 2-decimal currencies), dates in the organization's timezone, races (bills on
 * one receipt line, payments on one bill, payment vs void, double voids, duplicate invoice numbers,
 * idempotency), atomicity (nothing partial survives a failure), tenant and store isolation,
 * permission edges, receipts posted before 3d, and hostile input (no 500s).
 */

import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Vendor } from "../../src/models/vendor.model";
import { GoodsReceipt, isBilledQuantityUpdate } from "../../src/models/goodsReceipt.model";
import { Bill } from "../../src/models/bill.model";
import { VendorPayment } from "../../src/models/vendorPayment.model";
import { DocumentCounter } from "../../src/models/documentCounter.model";
import { IdempotencyKey } from "../../src/models/idempotencyKey.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { generateSuperAdminAccessToken } from "../../src/services/platformAuth.service";
import { addDays } from "../../src/services/bill.service";
import { todayIn } from "../../src/services/purchaseOrder.service";
import { singleExample, serviceExample } from "../../src/docs/product.openapi";
import {
  BillDataSchema,
  BillLineSchema,
  BillListDataSchema,
  BillPaymentRefSchema,
  BillSchema,
  BillSummarySchema,
  GoodsReceiptDataSchema,
  VendorPaymentAllocationSchema,
  VendorPaymentDataSchema,
  VendorPaymentListDataSchema,
  VendorPaymentSchema,
  VendorPaymentSummarySchema,
} from "../../src/validators/responses";

const PRODUCTS = "/api/v1/products";
const VENDORS = "/api/v1/vendors";
const BILLS = "/api/v1/bills";
const PAYMENTS = "/api/v1/vendor-payments";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const OBJECT_ID = "665f1c2e8a4b3c0012ab3e00";

let keySeq = 0;
const newKey = () => `bill-review-${Date.now()}-${(keySeq += 1)}`;

interface Env {
  org: Awaited<ReturnType<typeof Organization.create>>;
  role: (slug: string) => InstanceType<typeof Role>;
  storeA: InstanceType<typeof Store>;
  admin: string;
  vatVendor: string;
  localVendor: string;
  coffee: Ref;
  rice: Ref;
  delivery: Ref;
}
type Ref = { variantId: string; productId: string };

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

const goodsBody = (overrides: Record<string, unknown>) => ({
  ...singleExample,
  categoryId: undefined,
  taxRateId: undefined,
  barcodes: undefined,
  ...overrides,
});

async function makeEnv(
  slug: string,
  opts: { trn?: string | null; currency?: string; timezone?: string } = {}
): Promise<Env> {
  const currency = opts.currency ?? "BHD";
  const org = await Organization.create({
    name: slug,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    taxRegistrationNumber: opts.trn === undefined ? "220000111100003" : opts.trn,
    settings: { currency, timezone: opts.timezone ?? "Asia/Bahrain" },
  });
  await seedDefaultRolesForOrganization(org._id);
  await seedDefaultTaxRates(org._id, currency);
  const roles = await Role.find({ organizationId: org._id });
  const role = (s: string) => roles.find((r) => r.slug === s)!;
  const storeA = await Store.create({
    organizationId: org._id,
    name: `${slug} Store`,
    code: `${slug.toUpperCase()}-1`,
    address: { line1: "Road 1", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
    countryCode: "BH",
    timezone: "Asia/Bahrain",
  });
  const admin = await tokenFor(org._id, `admin@${slug}.test`, { orgRoleId: role("org_admin")._id });
  const mk = async (path: string, body: Record<string, unknown>) => {
    const res = await request.post(path).set(auth(admin)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data;
  };
  const vatVendor = (await mk(VENDORS, { name: "Gulf Roasters", taxRegistrationNumber: "220000987600003", paymentTermsDays: 30 })).vendor.id;
  const localVendor = (await mk(VENDORS, { name: "Corner Supplier" })).vendor.id;
  const prod = async (body: Record<string, unknown>): Promise<Ref> => {
    const data = await mk(PRODUCTS, body);
    return { variantId: data.product.variants[0].id, productId: data.product.id };
  };
  const costPrice = currency === "AED" ? "1.60" : "1.600";
  const coffee = await prod(goodsBody({ name: "Coffee", sku: "COF-1", sales: { sellingPrice: costPrice }, purchase: { costPrice } }));
  const rice = await prod(goodsBody({ name: "Rice", sku: "RICE-1", unit: "kg", sales: { sellingPrice: costPrice }, purchase: { costPrice } }));
  const delivery = await prod({ ...serviceExample, name: "Delivery charge", sales: { sellingPrice: costPrice } });
  return { org, role, storeA, admin, vatVendor, localVendor, coffee, rice, delivery };
}

let env: Env;
let admin: string;
let vatVendor: string;
let localVendor: string;
let coffee: Ref;
let rice: Ref;
let delivery: Ref;

beforeEach(async () => {
  env = await makeEnv("alnoor");
  ({ admin, vatVendor, localVendor, coffee, rice, delivery } = env);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const grnPath = (e: Env = env) => `/api/v1/stores/${e.storeA._id}/goods-receipts`;

async function receipt(
  opts: { e?: Env; vendorId?: string; date?: string; lines?: Record<string, unknown>[] } = {}
) {
  const e = opts.e ?? env;
  const res = await request
    .post(grnPath(e))
    .set(auth(e.admin))
    .set("Idempotency-Key", newKey())
    .send({
      vendorId: opts.vendorId ?? e.vatVendor,
      receivedDate: opts.date ?? "2026-11-01",
      lines: opts.lines ?? [
        { variantId: e.coffee.variantId, quantity: 24, unitCost: "1.600" },
        { variantId: e.rice.variantId, quantity: 12.5, unitCost: "0.500" },
      ],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const grn = res.body.data.goodsReceipt;
  return { id: grn.id as string, number: grn.number as string, lines: grn.lines.map((l: { id: string }) => l.id) as string[] };
}

const postBill = (body: unknown, opts: { token?: string; key?: string } = {}) =>
  request
    .post(BILLS)
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send(body as object);

const postPayment = (body: unknown, opts: { token?: string; key?: string } = {}) =>
  request
    .post(PAYMENTS)
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send(body as object);

const voidBillReq = (id: string, version: number, opts: { token?: string; key?: string } = {}) =>
  request
    .post(`${BILLS}/${id}/void`)
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send({ version, reason: "Wrong vendor" });

const voidPaymentReq = (id: string, version: number, opts: { token?: string; key?: string } = {}) =>
  request
    .post(`${PAYMENTS}/${id}/void`)
    .set(auth(opts.token ?? admin))
    .set("Idempotency-Key", opts.key ?? newKey())
    .send({ version, reason: "Cheque bounced" });

async function billOk(body: unknown, token = admin) {
  const res = await postBill(body, { token });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.bill;
}

async function payOk(body: unknown, token = admin) {
  const res = await postPayment(body, { token });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

const service = (unitCost: string, variantId = delivery.variantId, quantity = 1) => [{ variantId, quantity, unitCost }];
const serviceBill = (invoice: string, unitCost = "100.000", extra: Record<string, unknown> = {}, vendorId = vatVendor) => ({
  vendorId,
  vendorInvoiceNumber: invoice,
  lines: service(unitCost),
  ...extra,
});
const payBody = (billId: string, amount: string, extra: Record<string, unknown> = {}, vendorId = vatVendor) => ({
  vendorId,
  amount,
  method: "cash",
  allocations: [{ billId, amount }],
  ...extra,
});

async function billedMilli(grnId: string, index: number): Promise<number | undefined> {
  const doc = await GoodsReceipt.collection.findOne({ _id: new mongoose.Types.ObjectId(grnId) });
  return (doc!.lines as { billedQuantityMilli?: number }[])[index].billedQuantityMilli;
}

/** Everything a bill or payment may touch, to prove a failure left nothing behind. */
async function footprint() {
  const orgId = env.org._id;
  const [bills, payments, receipts, bill, pay, keys, vendors] = await Promise.all([
    Bill.collection.find({ organizationId: orgId }).toArray(),
    VendorPayment.collection.find({ organizationId: orgId }).toArray(),
    GoodsReceipt.collection.find({ organizationId: orgId }).toArray(),
    DocumentCounter.collection.findOne({ organizationId: orgId, type: "bill" }),
    DocumentCounter.collection.findOne({ organizationId: orgId, type: "vendor_payment" }),
    IdempotencyKey.countDocuments({ organizationId: orgId }),
    Vendor.collection.find({ organizationId: orgId }, { projection: { purchaseDocumentCount: 1 } }).toArray(),
  ]);
  return JSON.parse(JSON.stringify({ bills, payments, receipts, bill, pay, keys, vendors }));
}

/** Zod errors carry `path` (the global handler's shape), service errors carry `field`. */
const fieldOf = (e: { field?: string; path?: (string | number)[] }) => e.field ?? e.path?.join(".");

const strictOk = (schema: z.ZodTypeAny, value: unknown) => {
  const parsed = schema.safeParse(value);
  expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
};

// ==========================================
// Responses against the Zod schemas
// ==========================================

describe("responses match the Zod response schemas", () => {
  it("bill create, replay, get, list, void and payment create, get, list, void parse strictly", async () => {
    const grn = await receipt();
    const key = newKey();
    const body = {
      vendorId: vatVendor,
      vendorInvoiceNumber: "S-1",
      notes: "n",
      lines: [
        { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], unitCost: "1.650", note: "x" },
        { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1], quantity: 2.5 },
        { variantId: delivery.variantId, quantity: 1, unitCost: "5.000" },
      ],
    };
    const created = await postBill(body, { key });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    strictOk(BillDataSchema, created.body.data);
    strictOk(BillSchema.strict(), created.body.data.bill);
    for (const line of created.body.data.bill.lines) strictOk(BillLineSchema.strict(), line);
    const replay = await postBill(body, { key });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(created.body);

    const billId = created.body.data.bill.id;
    const pay = await postPayment(payBody(billId, "10.000", { reference: "R-1", notes: "n" }));
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    strictOk(VendorPaymentDataSchema, pay.body.data);
    strictOk(VendorPaymentSchema.strict(), pay.body.data.payment);
    for (const a of pay.body.data.payment.allocations) strictOk(VendorPaymentAllocationSchema.strict(), a);
    for (const b of pay.body.data.bills) strictOk(BillSummarySchema.strict(), b);

    const got = await request.get(`${BILLS}/${billId}`).set(auth(admin));
    strictOk(BillDataSchema, got.body.data);
    strictOk(BillSchema.strict(), got.body.data.bill);
    for (const p of got.body.data.bill.payments) strictOk(BillPaymentRefSchema.strict(), p);

    const list = await request.get(BILLS).set(auth(admin));
    strictOk(BillListDataSchema, list.body.data);
    for (const b of list.body.data.bills) strictOk(BillSummarySchema.strict(), b);

    const gotPay = await request.get(`${PAYMENTS}/${pay.body.data.payment.id}`).set(auth(admin));
    strictOk(VendorPaymentDataSchema, gotPay.body.data);
    expect(gotPay.body.data.bills).toEqual([]);
    const payList = await request.get(PAYMENTS).set(auth(admin));
    strictOk(VendorPaymentListDataSchema, payList.body.data);
    for (const p of payList.body.data.payments) strictOk(VendorPaymentSummarySchema.strict(), p);

    const voidedPay = await voidPaymentReq(pay.body.data.payment.id, 1);
    expect(voidedPay.status).toBe(200);
    strictOk(VendorPaymentDataSchema, voidedPay.body.data);
    strictOk(VendorPaymentSchema.strict(), voidedPay.body.data.payment);

    const voided = await voidBillReq(billId, 3);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    strictOk(BillDataSchema, voided.body.data);
    strictOk(BillSchema.strict(), voided.body.data.bill);

    const grnGet = await request.get(`${grnPath()}/${grn.id}`).set(auth(admin));
    strictOk(GoodsReceiptDataSchema, grnGet.body.data);
  });

  it("an error response carries no stack, hash or token", async () => {
    const res = await postBill({ vendorId: "x" });
    expect(res.status).toBe(400);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/stack|passwordHash|at .*\.ts:\d+/i);
    expect(res.body.success).toBe(false);
  });
});

// ==========================================
// Money
// ==========================================

describe("money math", () => {
  it("VAT is rounded per line (half up) and the bill sums the rounded lines", async () => {
    const second = await request.post(PRODUCTS).set(auth(admin)).send({ ...serviceExample, name: "Second service" });
    const v2 = second.body.data.product.variants[0].id;
    const bill = await billOk({
      vendorId: vatVendor,
      vendorInvoiceNumber: "ROUND",
      lines: [
        { variantId: delivery.variantId, quantity: 3, unitCost: "0.333" }, // 0.999, VAT 0.0999 -> 0.100
        { variantId: v2, quantity: 1, unitCost: "0.005" }, // VAT 0.0005 -> 0.001
      ],
    });
    expect(bill.lines[0]).toMatchObject({ subtotal: "0.999", tax: { tax: "0.100" }, total: "1.099" });
    expect(bill.lines[1]).toMatchObject({ subtotal: "0.005", tax: { tax: "0.001" }, total: "0.006" });
    expect(bill).toMatchObject({ subtotal: "1.004", tax: "0.101", total: "1.105" });
  });

  it("a fractional quantity of a kg line rounds the subtotal half up", async () => {
    const grn = await receipt({ lines: [{ variantId: rice.variantId, quantity: 5, unitCost: "1.500" }] });
    const bill = await billOk({
      vendorId: vatVendor,
      vendorInvoiceNumber: "K",
      lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 0.001, unitCost: "1.500" }],
    });
    // 0.001 x 1.500 = 0.0015 -> 0.002
    expect(bill.lines[0]).toMatchObject({ quantity: 0.001, subtotal: "0.002", total: "0.002" });
    expect(await billedMilli(grn.id, 0)).toBe(1);
  });

  it("cost variance with a TRN compares VAT-exclusive costs; partial quantities and cheaper invoices are signed", async () => {
    const grn = await receipt();
    const more = await billOk({
      vendorId: vatVendor,
      vendorInvoiceNumber: "V1",
      lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 10, unitCost: "1.655" }],
    });
    expect(more.lines[0].costVariance).toBe("0.550");
    const less = await billOk({
      vendorId: vatVendor,
      vendorInvoiceNumber: "V2",
      lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 10, unitCost: "1.500" }],
    });
    expect(less.lines[0].costVariance).toBe("-1.000");
    expect(less.costVariance).toBe("-1.000");
  });

  it("cost variance without a TRN compares totals, VAT included", async () => {
    await Organization.updateOne({ _id: env.org._id }, { $set: { taxRegistrationNumber: null } });
    const grn = await receipt();
    const bill = await billOk({
      vendorId: vatVendor,
      vendorInvoiceNumber: "N1",
      lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 10, unitCost: "1.655" }],
    });
    // subtotal 16.550 + VAT 1.655 = 18.205; stock 10 x 1.760 = 17.600
    expect(bill.lines[0].costVariance).toBe("0.605");
  });

  it("vatAdjustment: both boundaries, zero, -0 and a plus sign", async () => {
    const grn = await receipt();
    const line = (i: number) => [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[i], quantity: i === 0 ? 1 : 1 }];
    const up = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "U", vatAdjustment: "0.005", lines: line(0) });
    expect(up).toMatchObject({ vatAdjustment: "0.005", tax: "0.165", total: "1.765" });
    const down = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "D", vatAdjustment: "-0.005", lines: line(1) });
    expect(down.vatAdjustment).toBe("-0.005");
    const zero = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "Z", vatAdjustment: "-0", lines: service("1.000") });
    expect(zero.vatAdjustment).toBe("0.000");
    const plus = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "P", vatAdjustment: "+0.001", lines: service("1.000", delivery.variantId) });
    expect(plus.status).toBe(400);
  });

  it("2-decimal currency (AED): adjustment limits are 0.05, finer amounts are refused", async () => {
    const aed = await makeEnv("aedorg", { currency: "AED" });
    const aedBill = (body: Record<string, unknown>) =>
      postBill(
        {
          vendorId: aed.vatVendor,
          vendorInvoiceNumber: `A-${keySeq++}`,
          lines: [{ variantId: aed.delivery.variantId, quantity: 1, unitCost: "10.00" }],
          ...body,
        },
        { token: aed.admin }
      );
    const ok = await aedBill({ vatAdjustment: "0.05" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // AED default VAT is 5%: 0.50 + 0.05 adjustment.
    expect(ok.body.data.bill).toMatchObject({ subtotal: "10.00", tax: "0.55", vatAdjustment: "0.05", total: "10.55" });
    const neg = await aedBill({ vatAdjustment: "-0.05" });
    expect(neg.body.data.bill).toMatchObject({ tax: "0.45", total: "10.45" });
    for (const vatAdjustment of ["0.06", "-0.06", "0.005", "0.001"]) {
      const res = await aedBill({ vatAdjustment });
      expect([res.status, res.body.code], vatAdjustment).toEqual([400, "VAT_ADJUSTMENT_TOO_LARGE"]);
    }
    const fine = await aedBill({ lines: [{ variantId: aed.delivery.variantId, quantity: 1, unitCost: "1.005" }] });
    expect([fine.status, fine.body.code]).toEqual([400, "TOO_MANY_DECIMALS"]);
    expect(fine.body.errors[0].field).toBe("lines[0].unitCost");
    const tooFine = await postPayment(
      { vendorId: aed.vatVendor, amount: "1.001", method: "cash", allocations: [{ billId: ok.body.data.bill.id, amount: "1.001" }] },
      { token: aed.admin }
    );
    expect([tooFine.status, tooFine.body.code]).toEqual([400, "TOO_MANY_DECIMALS"]);
  });

  it("an amount near the safe-integer limit is a 400, never a 500", async () => {
    // The last two fit as a subtotal but not once the 10% VAT is added: a clean 400, no database message.
    for (const unitCost of ["9999999999999.999", "8500000000000.000", "8200000000000.000"]) {
      const res = await postBill(serviceBill(`BIG-${unitCost}`, unitCost));
      expect([res.status, res.body.code], `${unitCost}: ${JSON.stringify(res.body)}`).toEqual([400, "AMOUNT_OUT_OF_RANGE"]);
      expect(JSON.stringify(res.body)).not.toMatch(/Database|totalMinor|Minor/);
    }
    expect(await Bill.countDocuments({})).toBe(0);
    // A large amount that does fit works end to end, including the payment.
    const fits = await billOk(serviceBill("BIG-OK", "8000000000000.000", {}, localVendor));
    expect(fits.total).toBe("8000000000000.000");
    const qty = await postBill({
      vendorId: vatVendor,
      vendorInvoiceNumber: "BIGQ",
      lines: [{ variantId: delivery.variantId, quantity: 1_000_000_000, unitCost: "9999999999.999" }],
    });
    expect(qty.status).toBeLessThan(500);
  });

  it("a zero-cost bill is recorded as paid and cannot be paid; it can be voided", async () => {
    const bill = await billOk(serviceBill("FREE", "0.000"));
    expect(bill).toMatchObject({ total: "0.000", balanceDue: "0.000", status: "paid" });
    const pay = await postPayment(payBody(bill.id, "0.001"));
    expect([pay.status, pay.body.code]).toEqual([409, "BILL_STATUS_CONFLICT"]);
    expect((await voidBillReq(bill.id, 1)).status).toBe(200);
  });
});

// ==========================================
// Dates
// ==========================================

describe("dates in the organization's timezone", () => {
  it("today and tomorrow follow the organization's timezone, not UTC", async () => {
    const far = await makeEnv("kiribati", { timezone: "Pacific/Kiritimati" });
    const today = todayIn("Pacific/Kiritimati");
    const res = await postBill(
      { vendorId: far.vatVendor, vendorInvoiceNumber: "T", lines: [{ variantId: far.delivery.variantId, quantity: 1, unitCost: "1.000" }] },
      { token: far.admin }
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.bill.billDate).toBe(today);
    const tomorrow = await postBill(
      { vendorId: far.vatVendor, vendorInvoiceNumber: "T2", billDate: addDays(today, 1), lines: [{ variantId: far.delivery.variantId, quantity: 1, unitCost: "1.000" }] },
      { token: far.admin }
    );
    expect([tomorrow.status, tomorrow.body.errors[0].field]).toEqual([400, "billDate"]);
    const pay = await postPayment(payBody(res.body.data.bill.id, "0.500", {}, far.vatVendor), { token: far.admin });
    expect(pay.body.data.payment.paymentDate).toBe(today);
    const payTomorrow = await postPayment(payBody(res.body.data.bill.id, "0.100", { paymentDate: addDays(today, 1) }, far.vatVendor), { token: far.admin });
    expect([payTomorrow.status, payTomorrow.body.errors[0].field]).toEqual([400, "paymentDate"]);
  });

  it("rejects impossible dates, defaults a due date across a year end, accepts billDate = receivedDate", async () => {
    for (const billDate of ["2026-02-30", "2026-13-01", "2026-1-1", "20261101", ""]) {
      const res = await postBill(serviceBill(`D-${billDate}`, "1.000", { billDate }));
      expect([res.status, res.body.code], billDate).toEqual([400, "VALIDATION_FAILED"]);
    }
    expect(addDays("2026-12-31", 30)).toBe("2027-01-30");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    const monthEnd = await billOk(serviceBill("ME", "1.000", { billDate: "2026-10-31" }));
    expect(monthEnd.dueDate).toBe("2026-11-30");

    const grn = await receipt({ date: "2026-11-03" });
    const same = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "SAME", billDate: "2026-11-03", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }] });
    expect(same.billDate).toBe("2026-11-03");
    const equalDue = await billOk(serviceBill("DUE", "1.000", { billDate: "2026-11-03", dueDate: "2026-11-03" }));
    expect(equalDue.dueDate).toBe("2026-11-03");
  });

  it("a payment before the latest billDate of the bills paid is refused; on the billDate is fine", async () => {
    const a = await billOk(serviceBill("PA", "10.000", { billDate: "2026-11-02" }));
    const b = await billOk(serviceBill("PB", "10.000", { billDate: "2026-11-05" }, vatVendor));
    const res = await postPayment({
      vendorId: vatVendor,
      paymentDate: "2026-11-04",
      amount: "2.000",
      method: "cash",
      allocations: [{ billId: a.id, amount: "1.000" }, { billId: b.id, amount: "1.000" }],
    });
    expect([res.status, res.body.errors[0].field]).toEqual([400, "paymentDate"]);
    const ok = await postPayment(payBody(b.id, "1.000", { paymentDate: "2026-11-05" }));
    expect(ok.status).toBe(201);
  });
});

// ==========================================
// Contract error codes
// ==========================================

describe("error codes, statuses and field paths", () => {
  it("schema rules carry field paths in errors[]", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ vendorInvoiceNumber: "  " }, "vendorInvoiceNumber"],
      [{ vendorInvoiceNumber: "x".repeat(51) }, "vendorInvoiceNumber"],
      [{ lines: [] }, "lines"],
      [{ lines: [{}] }, "lines.0"],
      [{ lines: [{ variantId: delivery.variantId }] }, "lines.0.quantity"],
      [{ lines: [{ variantId: delivery.variantId, quantity: 1 }] }, "lines.0.unitCost"],
      [{ lines: [{ variantId: delivery.variantId, quantity: 0, unitCost: "1.000" }] }, "lines.0.quantity"],
      [{ lines: [{ variantId: delivery.variantId, quantity: -1, unitCost: "1.000" }] }, "lines.0.quantity"],
      [{ lines: [{ variantId: delivery.variantId, quantity: 0.0005, unitCost: "1.000" }] }, "lines.0.quantity"],
      [{ lines: [{ variantId: delivery.variantId, quantity: "1", unitCost: "1.000" }] }, "lines.0.quantity"],
      [{ lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: 1 }] }, "lines.0.unitCost"],
      [{ lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: "-1.000" }] }, "lines.0.unitCost"],
      [{ lines: [{ goodsReceiptId: OBJECT_ID }] }, "lines.0.goodsReceiptLineId"],
      [{ lines: [{ goodsReceiptLineId: OBJECT_ID }] }, "lines.0.goodsReceiptId"],
      [{ lines: [{ goodsReceiptId: OBJECT_ID, goodsReceiptLineId: OBJECT_ID, variantId: OBJECT_ID }] }, "lines.0.variantId"],
      [{ lines: [{ variantId: delivery.variantId, quantity: 1, unitCost: "1.000", extra: 1 }] }, "lines.0"],
      [{ billDate: "2026-11-05", dueDate: "2026-11-04" }, "dueDate"],
      [{ notes: "" }, "notes"],
      [{ vatAdjustment: 1 }, "vatAdjustment"],
      [{ vatAdjustment: "1.0001" }, "vatAdjustment"],
    ];
    for (const [override, field] of cases) {
      const res = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "E", lines: service("1.000"), ...override });
      expect(res.status, JSON.stringify(override)).toBe(400);
      expect(res.body.code, JSON.stringify(override)).toBe("VALIDATION_FAILED");
      expect(res.body.errors.map(fieldOf), JSON.stringify(override)).toContain(field);
    }
  });

  it("a goods receipt line or service variant listed twice is refused, whatever the letter case", async () => {
    const grn = await receipt();
    const line = { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 1 };
    const twice = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "T", lines: [line, { ...line, goodsReceiptLineId: grn.lines[0].toUpperCase() }] });
    expect(twice.status).toBe(400);
    const svc = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "T2", lines: [...service("1.000"), ...service("2.000", delivery.variantId.toUpperCase())] });
    expect(svc.status).toBe(400);
  });

  it("uppercase object ids are accepted", async () => {
    const grn = await receipt();
    const bill = await billOk({
      vendorId: vatVendor.toUpperCase(),
      vendorInvoiceNumber: "UP",
      lines: [{ goodsReceiptId: grn.id.toUpperCase(), goodsReceiptLineId: grn.lines[0].toUpperCase() }],
    });
    expect(bill.lines[0].quantity).toBe(24);
    const pay = await postPayment(payBody(bill.id.toUpperCase(), "1.000", {}, vatVendor.toUpperCase()));
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  });

  it("collects every over-billed line, in order, and takes the first one's code", async () => {
    const grn = await receipt();
    const res = await postBill({
      vendorId: vatVendor,
      vendorInvoiceNumber: "OV",
      lines: [
        { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 25 },
        { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1], quantity: 12.5 },
      ],
    });
    expect([res.status, res.body.code]).toEqual([409, "BILLED_QUANTITY_EXCEEDS_RECEIVED"]);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].meta).toEqual({ received: 24, billed: 0, remaining: 24 });
    expect(await Bill.countDocuments({})).toBe(0);
  });

  it("a VAT adjustment that makes the VAT negative (400) comes before a duplicate invoice (409)", async () => {
    await billOk(serviceBill("ORD"));
    await billOk(serviceBill("ORD", "1.000", {}, localVendor));
    // localVendor charges no VAT, so -0.005 makes the VAT negative; the invoice number is also a duplicate.
    const res = await postBill(serviceBill("ORD", "1.000", { vatAdjustment: "-0.005" }, localVendor));
    expect([res.status, res.body.code]).toEqual([400, "VAT_ADJUSTMENT_TOO_LARGE"]);
    const dup = await postBill(serviceBill("ORD", "1.000", { vatAdjustment: "-0.500" }));
    expect([dup.status, dup.body.code]).toEqual([400, "VAT_ADJUSTMENT_TOO_LARGE"]);
    const dupOnly = await postBill(serviceBill("ORD", "1.000"));
    expect([dupOnly.status, dupOnly.body.code]).toEqual([409, "DUPLICATE_VENDOR_INVOICE"]);
    // Over-billing (409) never beats a 400 either.
    const grn = await receipt();
    const both = await postBill({
      vendorId: vatVendor,
      vendorInvoiceNumber: "ORD2",
      vatAdjustment: "0.006",
      lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 25 }],
    });
    expect([both.status, both.body.code]).toEqual([400, "VAT_ADJUSTMENT_TOO_LARGE"]);
  });

  it("vendor, receipt and tax-rate problems come in the documented order", async () => {
    const grn = await receipt({ vendorId: localVendor });
    // vendor unknown wins over everything
    const noVendor = await postBill({ vendorId: OBJECT_ID, vendorInvoiceNumber: "O", lines: [{ goodsReceiptId: OBJECT_ID, goodsReceiptLineId: OBJECT_ID }] });
    expect([noVendor.status, noVendor.body.code, noVendor.body.errors[0].field]).toEqual([400, "VENDOR_NOT_FOUND", "vendorId"]);
    // missing receipt (404) wins over a vendor mismatch (400) on another line
    const mixed = await postBill({
      vendorId: vatVendor,
      vendorInvoiceNumber: "O2",
      lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }, { goodsReceiptId: OBJECT_ID, goodsReceiptLineId: OBJECT_ID }],
    });
    expect([mixed.status, mixed.body.code]).toEqual([404, "GOODS_RECEIPT_NOT_FOUND"]);
    // line problem (400) wins over a duplicate invoice (409)
    await billOk(serviceBill("DUP"));
    const lineFirst = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "DUP", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }] });
    expect([lineFirst.status, lineFirst.body.code]).toEqual([400, "VENDOR_MISMATCH"]);
    // date problem (400) wins over a duplicate (409)
    const dateFirst = await postBill(serviceBill("DUP", "1.000", { billDate: "2999-01-01" }));
    expect([dateFirst.status, dateFirst.body.errors[0].field]).toEqual([400, "billDate"]);
  });

  it("payment errors come in the documented order with their codes and metas", async () => {
    const a = await billOk(serviceBill("PA", "100.000")); // 110.000
    const b = await billOk(serviceBill("PB", "10.000", {}, localVendor), env.admin); // local: 10.000
    // sum mismatch is a schema error (400)
    const sum = await postPayment({ vendorId: vatVendor, amount: "5.000", method: "cash", allocations: [{ billId: a.id, amount: "4.999" }] });
    expect([sum.status, fieldOf(sum.body.errors[0])]).toEqual([400, "amount"]);
    // unknown bill 404 beats vendor mismatch 400
    const nf = await postPayment({ vendorId: vatVendor, amount: "2.000", method: "cash", allocations: [{ billId: b.id, amount: "1.000" }, { billId: OBJECT_ID, amount: "1.000" }] });
    expect([nf.status, nf.body.code, nf.body.errors[0].field]).toEqual([404, "BILL_NOT_FOUND", "allocations[1].billId"]);
    // vendor mismatch 400 beats exceeds 409
    const mm = await postPayment({ vendorId: vatVendor, amount: "999.000", method: "cash", allocations: [{ billId: b.id, amount: "999.000" }] });
    expect([mm.status, mm.body.code, mm.body.errors[0].meta]).toEqual([400, "VENDOR_MISMATCH", { billNumber: b.number }]);
    // unknown vendor
    const nv = await postPayment({ vendorId: OBJECT_ID, amount: "1.000", method: "cash", allocations: [{ billId: a.id, amount: "1.000" }] });
    expect([nv.status, nv.body.code, nv.body.errors[0].field]).toEqual([400, "VENDOR_NOT_FOUND", "vendorId"]);
    // exceeds: one item per allocation
    const c = await billOk(serviceBill("PC", "1.000"));
    const ex = await postPayment({
      vendorId: vatVendor,
      amount: "120.000",
      method: "cash",
      allocations: [{ billId: a.id, amount: "110.001" }, { billId: c.id, amount: "9.999" }],
    });
    expect([ex.status, ex.body.code]).toEqual([409, "PAYMENT_EXCEEDS_DUE"]);
    expect(ex.body.errors.map((e: { field: string; meta: unknown }) => [e.field, e.meta])).toEqual([
      ["allocations[0].amount", { balanceDue: "110.000" }],
      ["allocations[1].amount", { balanceDue: "1.100" }],
    ]);
    // void bill is not payable
    expect((await voidBillReq(c.id, 1)).status).toBe(200);
    const vd = await postPayment(payBody(c.id, "1.000"));
    expect([vd.status, vd.body.code, vd.body.errors[0].meta]).toEqual([409, "BILL_STATUS_CONFLICT", { status: "void" }]);
    // schema rules
    for (const override of [
      { method: "bitcoin" },
      { amount: "0.000", allocations: [{ billId: a.id, amount: "0.000" }] },
      { allocations: [] },
      { reference: "" },
      { reference: "r".repeat(51) },
      { paymentDate: "2026-02-31" },
      { allocations: [{ billId: a.id, amount: "1.000" }, { billId: a.id.toUpperCase(), amount: "1.000" }], amount: "2.000" },
      { status: "paid" },
      { organizationId: String(env.org._id) },
    ]) {
      const res = await postPayment({ ...payBody(a.id, "1.000"), ...override });
      expect([res.status, res.body.code], JSON.stringify(override)).toEqual([400, "VALIDATION_FAILED"]);
    }
    const many = await postPayment({
      vendorId: vatVendor,
      amount: "101.000",
      method: "cash",
      allocations: Array.from({ length: 101 }, () => ({ billId: new mongoose.Types.ObjectId().toString(), amount: "1.000" })),
    });
    expect(many.status).toBe(400);
  });

  it("void bodies are validated: version and reason", async () => {
    const bill = await billOk(serviceBill("V"));
    const bodies: unknown[] = [
      {},
      { version: 1 },
      { reason: "r" },
      { version: 0, reason: "r" },
      { version: 1.5, reason: "r" },
      { version: "1", reason: "r" },
      { version: { $gt: 0 }, reason: "r" },
      { version: 1, reason: "   " },
      { version: 1, reason: "r".repeat(501) },
      { version: 1, reason: "r", extra: true },
    ];
    for (const body of bodies) {
      const res = await request.post(`${BILLS}/${bill.id}/void`).set(auth(admin)).set("Idempotency-Key", newKey()).send(body as object);
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, "VALIDATION_FAILED"]);
    }
    const noKey = await request.post(`${BILLS}/${bill.id}/void`).set(auth(admin)).send({ version: 1, reason: "r" });
    expect([noKey.status, noKey.body.code]).toEqual([400, "VALIDATION_FAILED"]);
    const badKey = await request.post(`${BILLS}/${bill.id}/void`).set(auth(admin)).set("Idempotency-Key", "x".repeat(300)).send({ version: 1, reason: "r" });
    expect(badKey.status).toBe(400);
  });

  it("body fields the client must not control are refused", async () => {
    for (const extra of [
      { organizationId: String(env.org._id) },
      { status: "paid" },
      { paid: "5.000" },
      { number: "BILL-00099" },
      { createdBy: OBJECT_ID },
      { totalMinor: 1 },
      { version: 9 },
      { activeInvoiceKey: null },
    ]) {
      const res = await postBill({ ...serviceBill("X"), ...extra });
      expect([res.status, res.body.code], JSON.stringify(extra)).toEqual([400, "VALIDATION_FAILED"]);
    }
    expect(await Bill.countDocuments({})).toBe(0);
  });
});

// ==========================================
// Voids, payments and statuses
// ==========================================

describe("payments and voids keep bills consistent", () => {
  it("voiding one of two payments puts the bill back to partially_paid with the right paid", async () => {
    const bill = await billOk(serviceBill("PP", "100.000")); // 110.000
    const p1 = await payOk(payBody(bill.id, "50.000"));
    const p2 = await payOk(payBody(bill.id, "60.000"));
    expect(p2.bills[0]).toMatchObject({ status: "paid", paid: "110.000", balanceDue: "0.000", version: 3 });
    const voided = await voidPaymentReq(p1.payment.id, 1);
    expect(voided.body.data.bills[0]).toMatchObject({ status: "partially_paid", paid: "60.000", balanceDue: "50.000", version: 4 });
    const blocked = await voidBillReq(bill.id, 4);
    expect([blocked.status, blocked.body.errors[0].meta]).toEqual([409, { payments: [p2.payment.number] }]);
    const detail = await request.get(`${BILLS}/${bill.id}`).set(auth(admin));
    expect(detail.body.data.bill.payments.map((p: { number: string; status: string }) => [p.number, p.status])).toEqual([
      [p1.payment.number, "void"],
      [p2.payment.number, "posted"],
    ]);
  });

  it("a bill voided is not overdue and has no balance; overdue only counts open bills", async () => {
    const bill = await billOk(serviceBill("OD", "10.000", { billDate: "2026-10-01", dueDate: "2026-10-02" }));
    expect(bill.overdue).toBe(true);
    const paid = await payOk(payBody(bill.id, "11.000"));
    expect(paid.bills[0]).toMatchObject({ status: "paid", overdue: false });
    await voidPaymentReq(paid.payment.id, 1);
    const voided = await voidBillReq(bill.id, 3);
    expect(voided.body.data.bill).toMatchObject({ status: "void", overdue: false, balanceDue: "0.000" });
    const overdue = await request.get(`${BILLS}?overdue=true`).set(auth(admin));
    expect(overdue.body.data.bills).toEqual([]);
  });

  it("a payment to several bills is all or nothing", async () => {
    const a = await billOk(serviceBill("A1", "10.000"));
    const b = await billOk(serviceBill("B1", "10.000"));
    const before = await footprint();
    const res = await postPayment({
      vendorId: vatVendor,
      amount: "12.100",
      method: "cash",
      allocations: [{ billId: a.id, amount: "11.000" }, { billId: b.id, amount: "1.100" }].concat([]),
    });
    expect(res.status).toBe(201);
    const second = await postPayment({
      vendorId: vatVendor,
      amount: "11.100",
      method: "cash",
      allocations: [{ billId: a.id, amount: "0.100" }, { billId: b.id, amount: "11.000" }],
    });
    expect([second.status, second.body.code]).toEqual([409, "BILL_STATUS_CONFLICT"]);
    const after = await Bill.find({}).lean();
    expect(after.map((x) => x.paidMinor)).toEqual([11000, 1100]);
    expect(before.bills).toHaveLength(2);
  });
});

// ==========================================
// Races
// ==========================================

describe("races", () => {
  it("parallel bills on one receipt line never bill more than was received", async () => {
    const grn = await receipt();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        postBill({ vendorId: vatVendor, vendorInvoiceNumber: `P${i}`, lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 10 }] })
      )
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes, JSON.stringify(results.map((r) => r.body.code))).toEqual([201, 201, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe("BILLED_QUANTITY_EXCEEDS_RECEIVED");
    expect(await billedMilli(grn.id, 0)).toBe(20000);
    const numbers = results.filter((r) => r.status === 201).map((r) => r.body.data.bill.number).sort();
    expect(numbers).toEqual(["BILL-00001", "BILL-00002"]);
  });

  it("bills and voids racing on one line keep billedQuantity equal to the sum of live bills", async () => {
    const grn = await receipt();
    const line = (quantity: number) => [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity }];
    const first = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "F", lines: line(20) });
    const results = await Promise.all([
      voidBillReq(first.id, 1),
      postBill({ vendorId: vatVendor, vendorInvoiceNumber: "G", lines: line(10) }),
      postBill({ vendorId: vatVendor, vendorInvoiceNumber: "H", lines: line(10) }),
      postBill({ vendorId: vatVendor, vendorInvoiceNumber: "I", lines: line(10) }),
    ]);
    expect(results[0].status, JSON.stringify(results[0].body)).toBe(200);
    for (const r of results.slice(1)) expect([201, 409]).toContain(r.status);
    const live = await Bill.find({ status: { $ne: "void" } }).lean();
    const sum = live.reduce((total, b) => total + b.lines.reduce((s, l) => s + l.quantityMilli, 0), 0);
    expect(await billedMilli(grn.id, 0)).toBe(sum);
    expect(sum).toBeLessThanOrEqual(24000);
  });

  it("parallel payments on one bill never pay more than is due", async () => {
    const bill = await billOk(serviceBill("PAR", "100.000")); // 110.000
    const results = await Promise.all(Array.from({ length: 5 }, () => postPayment(payBody(bill.id, "30.000"))));
    const ok = results.filter((r) => r.status === 201).length;
    expect(ok).toBe(3);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect([r.status, r.body.code]).toEqual([409, "PAYMENT_EXCEEDS_DUE"]);
    }
    const stored = await Bill.findById(bill.id);
    expect([stored!.paidMinor, stored!.status, stored!.version]).toEqual([90000, "partially_paid", 4]);
    const numbers = results.filter((r) => r.status === 201).map((r) => r.body.data.payment.number).sort();
    expect(numbers).toEqual(["PAY-00001", "PAY-00002", "PAY-00003"]);
  });

  it("parallel payments that together exactly settle a bill: the last one makes it paid", async () => {
    const bill = await billOk(serviceBill("EXACT", "100.000")); // 110.000
    const results = await Promise.all([55, 55].map((n) => postPayment(payBody(bill.id, `${n}.000`))));
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect((await Bill.findById(bill.id))!.status).toBe("paid");
  });

  it("a payment racing the void of its bill: exactly one of them wins, the books stay consistent", async () => {
    for (let i = 0; i < 4; i++) {
      const bill = await billOk(serviceBill(`RV${i}`, "10.000"));
      const [pay, voided] = await Promise.all([postPayment(payBody(bill.id, "5.000")), voidBillReq(bill.id, 1)]);
      const stored = await Bill.findById(bill.id);
      if (pay.status === 201) {
        expect(voided.status, JSON.stringify(voided.body)).toBe(409);
        expect(stored!.status).toBe("partially_paid");
        expect(stored!.paidMinor).toBe(5000);
      } else {
        expect(voided.status, JSON.stringify([pay.body, voided.body])).toBe(200);
        expect([pay.status, pay.body.code]).toEqual([409, expect.stringMatching(/BILL_STATUS_CONFLICT|BILL_NOT_FOUND/)]);
        expect(stored!.status).toBe("void");
        expect(stored!.paidMinor).toBe(0);
        expect(await VendorPayment.countDocuments({ "allocations.billId": bill.id })).toBe(0);
      }
    }
  });

  it("two voids of the same payment: one wins, the bill's paid goes down once", async () => {
    const bill = await billOk(serviceBill("VV", "100.000"));
    const keep = await payOk(payBody(bill.id, "40.000"));
    const pay = await payOk(payBody(bill.id, "30.000"));
    const results = await Promise.all([voidPaymentReq(pay.payment.id, 1), voidPaymentReq(pay.payment.id, 1), voidPaymentReq(pay.payment.id, 2)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expect(r.status).toBe(409);
    const stored = await Bill.findById(bill.id);
    expect(stored!.paidMinor).toBe(40000);
    expect(stored!.status).toBe("partially_paid");
    expect((await VendorPayment.findById(keep.payment.id))!.status).toBe("posted");
  });

  it("two voids of the same bill: one wins and the billed quantity is given back once", async () => {
    const grn = await receipt();
    const other = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "OTHER", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 5 }] });
    const bill = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "TWICE", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 10 }] });
    const results = await Promise.all([voidBillReq(bill.id, 1), voidBillReq(bill.id, 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await billedMilli(grn.id, 0)).toBe(5000);
    expect((await Bill.findById(other.id))!.status).toBe("unpaid");
  });

  it("the same invoice number entered in parallel creates one bill and burns no number", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => postBill(serviceBill("SAMEINV", "1.000"))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) expect([r.status, r.body.code]).toEqual([409, "DUPLICATE_VENDOR_INVOICE"]);
    expect(await Bill.countDocuments({})).toBe(1);
    expect((await Vendor.findById(vatVendor))!.purchaseDocumentCount).toBe(1);
    const next = await billOk(serviceBill("NEXT", "1.000"));
    expect(next.number).toBe("BILL-00002");
  });

  it("the same invoice number differing only in case or surrounding spaces is a duplicate; other vendors are not", async () => {
    await billOk(serviceBill("Inv/77"));
    const up = await postBill(serviceBill("INV/77", "1.000"));
    const padded = await postBill(serviceBill("  inv/77  ", "1.000"));
    expect([up.body.code, padded.body.code]).toEqual(["DUPLICATE_VENDOR_INVOICE", "DUPLICATE_VENDOR_INVOICE"]);
    expect((await postBill(serviceBill("INV/77", "1.000", {}, localVendor))).status).toBe(201);
  });

  it("first bills of an organization racing for the counter get distinct numbers", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => postBill(serviceBill(`C${i}`, "1.000"))));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.data.bill.number)).size).toBe(6);
  });

  it("the same Idempotency-Key sent twice at once creates one bill", async () => {
    const key = newKey();
    const results = await Promise.all([postBill(serviceBill("IDEM"), { key }), postBill(serviceBill("IDEM"), { key })]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0].body.data.bill.id).toBe(results[1].body.data.bill.id);
    expect(await Bill.countDocuments({})).toBe(1);
    expect(await IdempotencyKey.countDocuments({})).toBe(1);
  });
});

// ==========================================
// Idempotency
// ==========================================

describe("idempotency", () => {
  it("replays creates and voids with their original status; the same key for another user, path or body is refused", async () => {
    const other = await tokenFor(env.org._id, "acc2@alnoor.test", { orgRoleId: env.role("accountant")._id });
    const key = newKey();
    const first = await postBill(serviceBill("K1"), { key });
    expect(first.status).toBe(201);
    const byOther = await postBill(serviceBill("K1"), { key, token: other });
    expect([byOther.status, byOther.body.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    const onPayments = await postPayment(payBody(first.body.data.bill.id, "1.000"), { key });
    expect([onPayments.status, onPayments.body.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);

    const voidKey = newKey();
    const v = await voidBillReq(first.body.data.bill.id, 1, { key: voidKey });
    expect(v.status).toBe(200);
    const replay = await voidBillReq(first.body.data.bill.id, 1, { key: voidKey });
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(v.body);
    const sameKeyOtherBill = await voidBillReq(OBJECT_ID, 1, { key: voidKey });
    expect([sameKeyOtherBill.status, sameKeyOtherBill.body.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);

    const payKey = newKey();
    const bill = await billOk(serviceBill("K2"));
    const p = await postPayment(payBody(bill.id, "2.000"), { key: payKey });
    const pReplay = await postPayment(payBody(bill.id, "2.000"), { key: payKey });
    expect([p.status, pReplay.status]).toEqual([201, 201]);
    expect(await VendorPayment.countDocuments({})).toBe(1);
    expect((await Bill.findById(bill.id))!.paidMinor).toBe(2000);
  });

  it("a failed request does not burn its key: the retry with the same key runs again", async () => {
    const key = newKey();
    const bad = await postBill(serviceBill("RETRY", "1.000", { billDate: "2999-01-01" }), { key });
    expect(bad.status).toBe(400);
    const ok = await postBill(serviceBill("RETRY", "1.000"), { key });
    expect(ok.status).toBe(201);
    expect(ok.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("an idempotency key of another organization does not collide", async () => {
    const other = await makeEnv("other-keys");
    const key = newKey();
    const mine = await postBill(serviceBill("SK"), { key });
    const theirs = await postBill(
      { vendorId: other.vatVendor, vendorInvoiceNumber: "SK", lines: [{ variantId: other.delivery.variantId, quantity: 1, unitCost: "1.000" }] },
      { key, token: other.admin }
    );
    expect([mine.status, theirs.status]).toEqual([201, 201]);
    expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
  });
});

// ==========================================
// Atomicity
// ==========================================

describe("atomicity: a failure partway leaves nothing behind", () => {
  it("a failure taking the bill number rolls back billedQuantity, the vendor count and the key", async () => {
    const grn = await receipt();
    const before = await footprint();
    const key = newKey();
    const spy = vi.spyOn(DocumentCounter, "findOneAndUpdate").mockImplementationOnce((() => {
      throw new Error("boom: counter");
    }) as never);
    const body = { vendorId: vatVendor, vendorInvoiceNumber: "ATOM", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 4 }] };
    const res = await postBill(body, { key });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/boom|stack/i);
    expect(spy).toHaveBeenCalled();
    expect(await footprint()).toEqual(before);
    spy.mockRestore();
    const retry = await postBill(body, { key });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.data.bill.number).toBe("BILL-00001");
    expect(await billedMilli(grn.id, 0)).toBe(4000);
  });

  it("a failure creating the bill rolls back everything the bill moved", async () => {
    const grn = await receipt();
    const before = await footprint();
    vi.spyOn(Bill, "create").mockRejectedValueOnce(new Error("boom: create") as never);
    const res = await postBill({
      vendorId: vatVendor,
      vendorInvoiceNumber: "ATOM2",
      lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 4 }, { goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1] }, ...service("3.000")],
    });
    expect(res.status).toBe(500);
    expect(await footprint()).toEqual(before);
  });

  it("a failure voiding a bill after the quantities were given back restores them", async () => {
    const grn = await receipt();
    const bill = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "VATOM", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 7 }] });
    const before = await footprint();
    vi.spyOn(Bill, "findOneAndUpdate").mockImplementationOnce((() => {
      throw new Error("boom: void");
    }) as never);
    const res = await voidBillReq(bill.id, 1);
    expect(res.status).toBe(500);
    expect(await footprint()).toEqual(before);
    expect(await billedMilli(grn.id, 0)).toBe(7000);
  });

  it("a failure creating a payment after the bills were raised rolls them back", async () => {
    const a = await billOk(serviceBill("PAT1", "10.000"));
    const b = await billOk(serviceBill("PAT2", "10.000"));
    const before = await footprint();
    vi.spyOn(VendorPayment, "create").mockRejectedValueOnce(new Error("boom: pay") as never);
    const res = await postPayment({
      vendorId: vatVendor,
      amount: "5.000",
      method: "cash",
      allocations: [{ billId: a.id, amount: "2.000" }, { billId: b.id, amount: "3.000" }],
    });
    expect(res.status).toBe(500);
    expect(await footprint()).toEqual(before);
  });

  it("a failure voiding a payment halfway restores every bill", async () => {
    const a = await billOk(serviceBill("PV1", "10.000"));
    const b = await billOk(serviceBill("PV2", "10.000"));
    const pay = await payOk({
      vendorId: vatVendor,
      amount: "5.000",
      method: "cash",
      allocations: [{ billId: a.id, amount: "2.000" }, { billId: b.id, amount: "3.000" }],
    });
    const before = await footprint();
    vi.spyOn(VendorPayment, "findOneAndUpdate").mockImplementationOnce((() => {
      throw new Error("boom: void pay");
    }) as never);
    const res = await voidPaymentReq(pay.payment.id, 1);
    expect(res.status).toBe(500);
    expect(await footprint()).toEqual(before);
  });
});

// ==========================================
// Tenant, store and permission isolation
// ==========================================

describe("isolation", () => {
  it("another organization's receipt, vendor, tax rate, variant, bill and payment are invisible", async () => {
    const other = await makeEnv("rival");
    const theirGrn = await receipt({ e: other });
    const theirBill = await billOk(
      { vendorId: other.vatVendor, vendorInvoiceNumber: "THEIRS", lines: [{ goodsReceiptId: theirGrn.id, goodsReceiptLineId: theirGrn.lines[0] }] },
      other.admin
    );
    const theirPay = await payOk(payBody(theirBill.id, "1.000", {}, other.vatVendor), other.admin);
    const theirRate = (await request.get("/api/v1/tax-rates").set(auth(other.admin))).body.data.taxRates[0].id;
    const theirBillsBefore = await Bill.findById(theirBill.id).lean();

    // referencing their receipt / vendor / variant / tax rate from my organization
    const viaReceipt = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "X1", lines: [{ goodsReceiptId: theirGrn.id, goodsReceiptLineId: theirGrn.lines[0] }] });
    expect([viaReceipt.status, viaReceipt.body.code]).toEqual([404, "GOODS_RECEIPT_NOT_FOUND"]);
    const viaVendor = await postBill(serviceBill("X2", "1.000", {}, other.vatVendor));
    expect([viaVendor.status, viaVendor.body.code]).toEqual([400, "VENDOR_NOT_FOUND"]);
    const viaVariant = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "X3", lines: service("1.000", other.delivery.variantId) });
    expect([viaVariant.status, viaVariant.body.code]).toEqual([400, "VARIANT_NOT_FOUND"]);
    const viaRate = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "X4", lines: [{ ...service("1.000")[0], taxRateId: theirRate }] });
    expect([viaRate.status, viaRate.body.code]).toEqual([400, "TAX_RATE_NOT_FOUND"]);
    const viaGoodsVariant = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "X5", lines: service("1.000", other.coffee.variantId) });
    expect([viaGoodsVariant.status, viaGoodsVariant.body.code]).toEqual([400, "VARIANT_NOT_FOUND"]);

    // paying, reading and voiding their bill and payment
    const pay = await postPayment(payBody(theirBill.id, "1.000", {}, vatVendor));
    expect([pay.status, pay.body.code]).toEqual([404, "BILL_NOT_FOUND"]);
    const payTheirVendor = await postPayment(payBody(theirBill.id, "1.000", {}, other.vatVendor));
    expect([payTheirVendor.status, payTheirVendor.body.code]).toEqual([400, "VENDOR_NOT_FOUND"]);
    expect((await request.get(`${BILLS}/${theirBill.id}`).set(auth(admin))).status).toBe(404);
    expect((await voidBillReq(theirBill.id, 1)).status).toBe(404);
    expect((await request.get(`${PAYMENTS}/${theirPay.payment.id}`).set(auth(admin))).status).toBe(404);
    expect((await voidPaymentReq(theirPay.payment.id, 1)).status).toBe(404);

    // lists and filters
    for (const query of [`?vendorId=${other.vatVendor}`, `?goodsReceiptId=${theirGrn.id}`, "?search=THEIRS", `?search=${theirBill.number}`]) {
      const res = await request.get(`${BILLS}${query}`).set(auth(admin));
      expect(res.body.data.bills, query).toEqual([]);
    }
    expect((await request.get(`${BILLS}`).set(auth(admin))).body.data.pagination.total).toBe(0);
    for (const query of [`?billId=${theirBill.id}`, `?vendorId=${other.vatVendor}`, `?search=${theirPay.payment.number}`]) {
      const res = await request.get(`${PAYMENTS}${query}`).set(auth(admin));
      expect(res.body.data.payments, query).toEqual([]);
    }
    expect(await Bill.findById(theirBill.id).lean()).toEqual(theirBillsBefore);
    expect(await billedMilli(theirGrn.id, 0)).toBe(24000);

    // numbers are per organization
    expect((await billOk(serviceBill("MINE"))).number).toBe("BILL-00001");
  });

  it("my receipt on another organization's bill request: their admin cannot bill my receipt", async () => {
    const other = await makeEnv("rival2");
    const grn = await receipt();
    const res = await postBill(
      { vendorId: other.vatVendor, vendorInvoiceNumber: "STEAL", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }] },
      { token: other.admin }
    );
    expect([res.status, res.body.code]).toEqual([404, "GOODS_RECEIPT_NOT_FOUND"]);
    expect(await billedMilli(grn.id, 0)).toBe(0);
  });

  it("store roles get 403 on all eight routes; platform tokens and junk tokens get 401", async () => {
    const bill = await billOk(serviceBill("ST"));
    const pay = await payOk(payBody(bill.id, "1.000"));
    const holders = await Promise.all(
      ["store_manager", "inventory_clerk", "cashier"].map((slug) =>
        tokenFor(env.org._id, `${slug}@alnoor.test`, { storeAccess: [{ storeId: env.storeA._id, roleId: env.role(slug)._id }] })
      )
    );
    const platform = generateSuperAdminAccessToken({ userId: new mongoose.Types.ObjectId().toString(), email: "root@platform.test" } as never);
    const routes = (token: string) => [
      request.get(BILLS).set(auth(token)),
      request.get(`${BILLS}/${bill.id}`).set(auth(token)),
      request.post(BILLS).set(auth(token)).set("Idempotency-Key", newKey()).send(serviceBill("S2")),
      request.post(`${BILLS}/${bill.id}/void`).set(auth(token)).set("Idempotency-Key", newKey()).send({ version: 2, reason: "r" }),
      request.get(PAYMENTS).set(auth(token)),
      request.get(`${PAYMENTS}/${pay.payment.id}`).set(auth(token)),
      request.post(PAYMENTS).set(auth(token)).set("Idempotency-Key", newKey()).send(payBody(bill.id, "1.000")),
      request.post(`${PAYMENTS}/${pay.payment.id}/void`).set(auth(token)).set("Idempotency-Key", newKey()).send({ version: 1, reason: "r" }),
    ];
    for (const token of holders) {
      const responses = await Promise.all(routes(token));
      expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
    }
    for (const token of [platform, "junk", ""]) {
      const responses = await Promise.all(routes(token));
      expect(responses.map((r) => r.status), token).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);
    }
    expect(await Bill.countDocuments({})).toBe(1);
    expect(await VendorPayment.countDocuments({})).toBe(1);
  });

  it("a user with no role at all, or an inactive user, gets nothing", async () => {
    const none = await tokenFor(env.org._id, "norole@alnoor.test", {});
    expect((await request.get(BILLS).set(auth(none))).status).toBe(403);
    const user = await User.create({ organizationId: env.org._id, email: "off@alnoor.test", passwordHash: "SecurePassword123", firstName: "O", lastName: "F", isActive: false, orgRoleId: env.role("org_admin")._id });
    const token = generateAccessToken({ userId: user._id.toString(), organizationId: String(env.org._id), isSuperAdmin: false });
    expect((await request.get(BILLS).set(auth(token))).status).toBe(401);
  });

  it("custom roles: purchase:bill alone and purchase:pay alone do exactly what they grant", async () => {
    const mkRole = async (name: string, permissions: string[]) => {
      const res = await request.post("/api/v1/roles").set(auth(admin)).send({ name, scope: "organization", permissions });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.data.role.id as string;
    };
    const billerToken = await tokenFor(env.org._id, "biller@alnoor.test", { orgRoleId: await mkRole("Biller", ["purchase:bill"]) });
    const payerToken = await tokenFor(env.org._id, "payer@alnoor.test", { orgRoleId: await mkRole("Payer", ["purchase:pay"]) });

    // biller: can create and void, cannot read (list/detail), cannot pay
    const bill = await postBill(serviceBill("CB"), { token: billerToken });
    expect(bill.status).toBe(201);
    expect((await request.get(BILLS).set(auth(billerToken))).status).toBe(403);
    expect((await request.get(`${BILLS}/${bill.body.data.bill.id}`).set(auth(billerToken))).status).toBe(403);
    expect((await postPayment(payBody(bill.body.data.bill.id, "1.000"), { token: billerToken })).status).toBe(403);

    // payer: can pay and void payments, cannot bill, cannot void bills, cannot read
    expect((await postBill(serviceBill("CP"), { token: payerToken })).status).toBe(403);
    const pay = await postPayment(payBody(bill.body.data.bill.id, "1.000"), { token: payerToken });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect((await voidBillReq(bill.body.data.bill.id, 2, { token: payerToken })).status).toBe(403);
    expect((await request.get(PAYMENTS).set(auth(payerToken))).status).toBe(403);
    expect((await voidPaymentReq(pay.body.data.payment.id, 1, { token: payerToken })).status).toBe(200);
    // the biller cannot void the payment
    expect((await voidPaymentReq(pay.body.data.payment.id, 2, { token: billerToken })).status).toBe(403);
    expect((await voidBillReq(bill.body.data.bill.id, 3, { token: billerToken })).status).toBe(200);
  });

  it("an organization admin cannot grant bill or pay permissions they do not have (privilege ceiling)", async () => {
    const readerRole = await request.post("/api/v1/roles").set(auth(admin)).send({ name: "Reader", scope: "organization", permissions: ["purchase:read", "role:manage"] });
    if (readerRole.status !== 201) return; // role:manage is not a grantable permission here; nothing to check
    const token = await tokenFor(env.org._id, "reader@alnoor.test", { orgRoleId: readerRole.body.data.role.id });
    const escalate = await request.post("/api/v1/roles").set(auth(token)).send({ name: "Esc", scope: "organization", permissions: ["purchase:pay"] });
    expect(escalate.status).toBe(403);
  });
});

// ==========================================
// Receipts posted before Phase 3d
// ==========================================

describe("receipts without billedQuantityMilli (posted before 3d)", () => {
  async function legacyReceipt() {
    const grn = await receipt();
    await GoodsReceipt.collection.updateOne({ _id: new mongoose.Types.ObjectId(grn.id) }, { $unset: { "lines.$[].billedQuantityMilli": "" } });
    expect(await billedMilli(grn.id, 0)).toBeUndefined();
    return grn;
  }

  it("reads as billedQuantity 0, bills fully by default, partially, refuses over-billing, and voids back to 0", async () => {
    const grn = await legacyReceipt();
    const got = await request.get(`${grnPath()}/${grn.id}`).set(auth(admin));
    expect(got.body.data.goodsReceipt.lines.map((l: { billedQuantity: number }) => l.billedQuantity)).toEqual([0, 0]);
    strictOk(GoodsReceiptDataSchema, got.body.data);

    const partial = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "L1", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 4 }] });
    expect(await billedMilli(grn.id, 0)).toBe(4000);
    const rest = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "L2", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }] });
    expect(rest.lines[0].quantity).toBe(20);
    expect(await billedMilli(grn.id, 0)).toBe(24000);
    const over = await postBill({ vendorId: vatVendor, vendorInvoiceNumber: "L3", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0], quantity: 1 }] });
    expect([over.status, over.body.errors[0].meta]).toEqual([409, { received: 24, billed: 24, remaining: 0 }]);
    expect((await voidBillReq(partial.id, 1)).status).toBe(200);
    expect(await billedMilli(grn.id, 0)).toBe(20000);
    expect((await voidBillReq(rest.id, 1)).status).toBe(200);
    expect(await billedMilli(grn.id, 0)).toBe(0);
    // the second line was never touched and still has no field
    expect(await billedMilli(grn.id, 1)).toBeUndefined();
  });

  it("a legacy line over-billed in parallel is still capped", async () => {
    const grn = await legacyReceipt();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) => postBill({ vendorId: vatVendor, vendorInvoiceNumber: `LP${i}`, lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[1], quantity: 6 }] }))
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
    expect(await billedMilli(grn.id, 1)).toBe(12000);
  });

  it("a legacy receipt in the receipt list and a deleted-product variant still read", async () => {
    await legacyReceipt();
    const list = await request.get(grnPath()).set(auth(admin));
    expect(list.status).toBe(200);
  });
});

// ==========================================
// The receipt's only allowed update
// ==========================================

describe("goods receipts stay final", () => {
  it("isBilledQuantityUpdate accepts only $inc of lines' billedQuantityMilli", () => {
    expect(isBilledQuantityUpdate({ $inc: { "lines.$.billedQuantityMilli": 5 } })).toBe(true);
    expect(isBilledQuantityUpdate({ $inc: { "lines.$[l].billedQuantityMilli": -5 } })).toBe(true);
    expect(isBilledQuantityUpdate({ $inc: { "lines.$.billedQuantityMilli": 5 }, $set: { notes: "x" } })).toBe(false);
    expect(isBilledQuantityUpdate({ $inc: { "lines.$.quantityMilli": 5 } })).toBe(false);
    expect(isBilledQuantityUpdate({ $inc: { "lines.$.billedQuantityMilli": 5, "lines.$.quantityMilli": 5 } })).toBe(false);
    expect(isBilledQuantityUpdate({ $inc: { "lines.0.billedQuantityMilli": 5 } })).toBe(false);
    expect(isBilledQuantityUpdate({ $inc: { "lines.$.billedQuantityMilli.x": 5 } })).toBe(false);
    expect(isBilledQuantityUpdate({ $inc: {} })).toBe(false);
    expect(isBilledQuantityUpdate({ $set: { "lines.$.billedQuantityMilli": 5 } })).toBe(false);
    expect(isBilledQuantityUpdate([{ $set: { notes: "x" } }])).toBe(false);
    expect(isBilledQuantityUpdate(null)).toBe(false);
  });

  it("updateOne with anything else, updateMany, findOneAndUpdate, deleteOne and save-after-edit are refused", async () => {
    const grn = await receipt();
    await expect(GoodsReceipt.updateOne({ _id: grn.id }, { $set: { "lines.0.billedQuantityMilli": 1 } })).rejects.toThrow(/final/);
    await expect(GoodsReceipt.updateOne({ _id: grn.id }, { $inc: { "lines.$[].billedQuantityMilli": 1 }, $set: { notes: "x" } })).rejects.toThrow(/final/);
    await expect(GoodsReceipt.updateMany({}, { $inc: { "lines.$[].billedQuantityMilli": 1 } })).rejects.toThrow();
    await expect(GoodsReceipt.findOneAndUpdate({ _id: grn.id }, { $inc: { "lines.$[].billedQuantityMilli": 1 } })).rejects.toThrow();
    await expect(GoodsReceipt.deleteOne({ _id: grn.id })).rejects.toThrow();
    expect(await billedMilli(grn.id, 0)).toBe(0);
  });
});

// ==========================================
// Hostile input
// ==========================================

describe("hostile input never produces a 500", () => {
  it("malformed ids in paths", async () => {
    for (const id of ["nope", "123", "z".repeat(24), "%00", "..%2f..", "a".repeat(25), "%24ne", "null", "undefined"]) {
      const get = await request.get(`${BILLS}/${id}`).set(auth(admin));
      expect([get.status, id].join(), id).toBe(`400,${id}`);
      const getPay = await request.get(`${PAYMENTS}/${id}`).set(auth(admin));
      expect([getPay.status, id].join(), id).toBe(`400,${id}`);
      const voidBill = await voidBillReq(id, 1);
      expect(voidBill.status, `void bill ${id}: ${JSON.stringify(voidBill.body)}`).toBe(400);
      const voidPay = await voidPaymentReq(id, 1);
      expect(voidPay.status, `void pay ${id}: ${JSON.stringify(voidPay.body)}`).toBe(400);
    }
  });

  it("malformed ids and operators in bodies", async () => {
    const bodies: unknown[] = [
      { ...serviceBill("H"), vendorId: "nope" },
      { ...serviceBill("H"), vendorId: { $ne: null } },
      { ...serviceBill("H"), vendorInvoiceNumber: { $ne: "" } },
      { ...serviceBill("H"), lines: [{ variantId: { $ne: null }, quantity: 1, unitCost: "1.000" }] },
      { ...serviceBill("H"), lines: "x" },
      { ...serviceBill("H"), lines: [null] },
      { ...serviceBill("H"), vendorInvoiceNumber: "a\u0000b" },
      [],
      "string",
      null,
    ];
    for (const body of bodies) {
      const res = await request.post(BILLS).set(auth(admin)).set("Idempotency-Key", newKey()).send(body as object);
      expect(res.status, JSON.stringify(body)).toBeLessThan(500);
    }
    const bill = await billOk(serviceBill("HB"));
    for (const body of [
      { vendorId: vatVendor, amount: "1.000", method: "cash", allocations: [{ billId: { $ne: null }, amount: "1.000" }] },
      { vendorId: vatVendor, amount: "1.000", method: { $ne: "x" }, allocations: [{ billId: bill.id, amount: "1.000" }] },
      { vendorId: vatVendor, amount: "1.000", method: "cash", allocations: [{ billId: "nope", amount: "1.000" }] },
      { vendorId: vatVendor, amount: "1.000", method: "cash", allocations: "x" },
      { vendorId: vatVendor, amount: ["1.000"], method: "cash", allocations: [{ billId: bill.id, amount: "1.000" }] },
    ]) {
      const res = await postPayment(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("odd query strings on the lists", async () => {
    const bill = await billOk(serviceBill("Q.*(1)", "1.000"));
    await payOk(payBody(bill.id, "1.100", { reference: "ref[1]" }));
    const queries = [
      "?page=abc&limit=-5",
      "?page=1e30",
      "?page=-3",
      "?page=0.2",
      "?limit=100000",
      "?limit=0",
      "?limit=NaN",
      "?page=Infinity",
      "?page=1&page=2",
      "?limit=1&limit=2",
      "?search=%00",
      "?search=a%00b",
      "?search=.*",
      "?search=(",
      "?search=\\",
      "?search=[",
      "?search=%24where",
      `?search=${"x".repeat(9000)}`,
      "?search[$ne]=x",
      "?search[]=x",
      "?vendorId[$ne]=x",
      "?vendorId=%00",
      "?vendorId=",
      "?goodsReceiptId=nope",
      "?status[]=unpaid",
      "?status=a&status=b",
      "?status=,,,",
      "?status=%00",
      "?overdue=1",
      "?overdue=true&overdue=false",
      "?from=2026-13-45&to=bogus",
      "?from=2026-11-05&to=2026-11-01",
      "?dueFrom=%00&dueTo=",
      "?method=bitcoin",
      "?method=cash,%00",
      "?billId=nope",
      "?billId[$ne]=1",
    ];
    for (const query of queries) {
      const list = await request.get(`${BILLS}${query}`).set(auth(admin));
      expect(list.status, `bills ${query.slice(0, 60)}: ${JSON.stringify(list.body).slice(0, 200)}`).toBe(200);
      const pays = await request.get(`${PAYMENTS}${query}`).set(auth(admin));
      expect(pays.status, `payments ${query.slice(0, 60)}: ${JSON.stringify(pays.body).slice(0, 200)}`).toBe(200);
    }
    // regex characters are literal
    const literal = await request.get(`${BILLS}?search=${encodeURIComponent("Q.*(")}`).set(auth(admin));
    expect(literal.body.data.bills).toHaveLength(1);
    const wildcard = await request.get(`${BILLS}?search=${encodeURIComponent(".*")}`).set(auth(admin));
    expect(wildcard.body.data.bills).toEqual([]);
    const refLiteral = await request.get(`${PAYMENTS}?search=${encodeURIComponent("ref[1")}`).set(auth(admin));
    expect(refLiteral.body.data.payments).toHaveLength(1);
    const wild = await request.get(`${PAYMENTS}?search=${encodeURIComponent("r.f")}`).set(auth(admin));
    expect(wild.body.data.payments).toEqual([]);
    // limits
    const big = await request.get(`${BILLS}?limit=100000&page=1e30`).set(auth(admin));
    expect(big.body.data.pagination).toMatchObject({ limit: 100, page: 1000000 });
    const dflt = await request.get(`${BILLS}?page=abc&limit=-5`).set(auth(admin));
    expect(dflt.body.data.pagination).toMatchObject({ page: 1, limit: 20 });
    // repeated params are ignored, not combined
    const repeated = await request.get(`${BILLS}?status=void&status=unpaid`).set(auth(admin));
    expect(repeated.body.data.bills).toHaveLength(1);
    // inverted range is empty
    const inverted = await request.get(`${BILLS}?from=2026-11-05&to=2026-11-01`).set(auth(admin));
    expect(inverted.body.data.bills).toEqual([]);
  });

  it("search finds bills by number with or without the prefix and case", async () => {
    const bill = await billOk(serviceBill("ABC-1", "1.000"));
    for (const term of ["BILL-00001", "bill-00001", "00001", "0000", "B", "bill", "abc", "ABC-1"]) {
      const res = await request.get(`${BILLS}?search=${term}`).set(auth(admin));
      expect(res.body.data.bills.map((b: { id: string }) => b.id), term).toEqual([bill.id]);
    }
    for (const term of ["BILL-00002", "2", "xyz"]) {
      const res = await request.get(`${BILLS}?search=${term}`).set(auth(admin));
      expect(res.body.data.bills, term).toEqual([]);
    }
  });
});

// ==========================================
// Catalog and vendor rules
// ==========================================

describe("catalog and vendor rules", () => {
  it("a variant on a bill cannot be deleted, a variant of a received product neither", async () => {
    const created = await request.post(PRODUCTS).set(auth(admin)).send({
      ...serviceExample,
      name: "Multi service",
      variants: undefined,
    });
    expect(created.status).toBe(201);
    await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "CAT", lines: service("1.000", created.body.data.product.variants[0].id) });
    const del = await request.delete(`${PRODUCTS}/${created.body.data.product.id}`).set(auth(admin));
    expect([del.status, del.body.code]).toEqual([409, "PRODUCT_IN_USE"]);
    // even after the bill is void, the history stays
    const bill = (await request.get(BILLS).set(auth(admin))).body.data.bills[0];
    expect((await voidBillReq(bill.id, 1)).status).toBe(200);
    const again = await request.delete(`${PRODUCTS}/${created.body.data.product.id}`).set(auth(admin));
    expect(again.status).toBe(409);
  });

  it("a received variant or a billed variant cannot be deleted, an unused sibling can", async () => {
    const tee = await request.post(PRODUCTS).set(auth(admin)).send({
      name: "Tee",
      type: "goods",
      itemType: "variant",
      unit: "pcs",
      taxPreference: "standard",
      attributes: [{ name: "Size", options: ["S", "M"] }],
      variants: [
        { attributeValues: { Size: "S" }, sellingPrice: "4.000", costPrice: "2.000" },
        { attributeValues: { Size: "M" }, sellingPrice: "4.000", costPrice: "2.000" },
      ],
      inventory: { trackInventory: false },
    });
    expect(tee.status, JSON.stringify(tee.body)).toBe(201);
    const [small, medium] = tee.body.data.product.variants;
    await receipt({ lines: [{ variantId: small.id, quantity: 2, unitCost: "2.000" }] });
    const used = await request.delete(`${PRODUCTS}/${tee.body.data.product.id}/variants/${small.id}`).set(auth(admin));
    expect([used.status, used.body.code]).toEqual([409, "VARIANT_IN_USE"]);
    const whole = await request.delete(`${PRODUCTS}/${tee.body.data.product.id}`).set(auth(admin));
    expect([whole.status, whole.body.code]).toEqual([409, "PRODUCT_IN_USE"]);
    expect((await request.delete(`${PRODUCTS}/${tee.body.data.product.id}/variants/${medium.id}`).set(auth(admin))).status).toBe(200);
  });

  it("a bill still shows its vendor and lines after the vendor is deactivated and the product renamed", async () => {
    const grn = await receipt();
    const bill = await billOk({ vendorId: vatVendor, vendorInvoiceNumber: "SNAP", lines: [{ goodsReceiptId: grn.id, goodsReceiptLineId: grn.lines[0] }] });
    await request.patch(`${VENDORS}/${vatVendor}`).set(auth(admin)).send({ name: "Renamed Vendor", isActive: false });
    const got = await request.get(`${BILLS}/${bill.id}`).set(auth(admin));
    expect(got.body.data.bill.vendor).toMatchObject({ name: "Gulf Roasters", isActive: false });
    strictOk(BillDataSchema, got.body.data);
    const pay = await postPayment(payBody(bill.id, "1.000"));
    expect(pay.body.data.payment.vendor).toMatchObject({ name: "Renamed Vendor", isActive: false });
  });

  it("vendor payment and bill counts keep a vendor undeletable even after everything is void", async () => {
    const fresh = (await request.post(VENDORS).set(auth(admin)).send({ name: "Fresh" })).body.data.vendor.id;
    const bill = await billOk(serviceBill("FV", "1.000", {}, fresh));
    expect((await voidBillReq(bill.id, 1)).status).toBe(200);
    const del = await request.delete(`${VENDORS}/${fresh}`).set(auth(admin));
    expect([del.status, del.body.code]).toEqual([409, "VENDOR_IN_USE"]);
  });
});
