/**
 * Purpose: The Phase 2 stock ledger over HTTP: opening stock, adjustments (change and count
 * modes, reasons, negative stock), transfers, weighted average cost, idempotent retries, the
 * catalog locks, the read endpoints with their permissions and cost visibility, and the ledger
 * invariant (a level always equals the sum of its movements).
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { StockLevel } from "../../src/models/stockLevel.model";
import { StockMovement } from "../../src/models/stockMovement.model";
import { IdempotencyKey } from "../../src/models/idempotencyKey.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";

const API = "/api/v1";
const PRODUCTS = `${API}/products`;
const TRANSFERS = `${API}/stock-transfers`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let keyCounter = 0;
const newKey = () => `test-key-${Date.now()}-${++keyCounter}`;

async function createStore(orgId: mongoose.Types.ObjectId, name: string, code: string, isActive = true) {
  return Store.create({
    organizationId: orgId,
    name,
    code,
    address: { line1: "Road 1", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
    countryCode: "BH",
    timezone: "Asia/Bahrain",
    isActive,
  });
}

async function tokenFor(
  orgId: mongoose.Types.ObjectId,
  email: string,
  opts: { orgRoleId?: unknown; storeAccess?: { storeId: unknown; roleId: unknown }[] }
) {
  const user = await User.create({
    organizationId: orgId,
    email,
    passwordHash: "SecurePassword123",
    firstName: "Test",
    lastName: email.split("@")[0],
    isActive: true,
    orgRoleId: opts.orgRoleId ?? null,
    storeAccess: opts.storeAccess ?? [],
  });
  return generateAccessToken({ userId: user._id.toString(), organizationId: String(orgId), isSuperAdmin: false });
}

let org: mongoose.Types.ObjectId;
let main: string;
let mall: string;
let closed: string;
let admin: string;
let manager: string;
let cashier: string;
let clerk: string;
let accountant: string;

beforeAll(async () => {
  // The concurrency tests rely on the unique indexes existing before the first write.
  await Promise.all([StockLevel.init(), StockMovement.init(), IdempotencyKey.init()]);
});

beforeEach(async () => {
  const organization = await Organization.create({
    name: "Al Noor",
    slug: "alnoor",
    contactEmail: "owner@alnoor.test",
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency: "BHD", timezone: "Asia/Bahrain" },
  });
  org = organization._id;
  await seedDefaultRolesForOrganization(org);
  await seedDefaultTaxRates(org, "BHD");
  const roles = await Role.find({ organizationId: org });
  const role = (slug: string) => roles.find((r) => r.slug === slug)!._id;

  main = (await createStore(org, "Main", "MAIN-1"))._id.toString();
  mall = (await createStore(org, "Mall", "MALL-1"))._id.toString();
  closed = (await createStore(org, "Closed", "CLOSED-1", false))._id.toString();

  admin = await tokenFor(org, "admin@alnoor.test", { orgRoleId: role("org_admin") });
  accountant = await tokenFor(org, "accountant@alnoor.test", { orgRoleId: role("accountant") });
  manager = await tokenFor(org, "manager@alnoor.test", { storeAccess: [{ storeId: main, roleId: role("store_manager") }] });
  cashier = await tokenFor(org, "cashier@alnoor.test", { storeAccess: [{ storeId: main, roleId: role("cashier") }] });
  clerk = await tokenFor(org, "clerk@alnoor.test", { storeAccess: [{ storeId: main, roleId: role("inventory_clerk") }] });
});

// ---------- helpers ----------

async function createProduct(body: Record<string, unknown>) {
  const res = await request.post(PRODUCTS).set(auth(admin)).send({ type: "goods", taxPreference: "exempt", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.product;
}

/** A single pcs item; returns its id and default variant id. */
async function coffee(opening?: { storeId: string; quantity: number; unitCost?: string }[], extra: Record<string, unknown> = {}) {
  const product = await createProduct({
    name: "Coffee",
    sales: { sellingPrice: "2.750" },
    purchase: { costPrice: "1.600" },
    inventory: { reorderPoint: 5, ...(opening ? { openingStock: opening } : {}) },
    ...extra,
  });
  return { productId: product._id as string, variantId: product.variants[0].id as string, product };
}

function adjust(token: string, storeId: string, body: Record<string, unknown>, key = newKey()) {
  return request.post(`${API}/stores/${storeId}/stock-adjustments`).set(auth(token)).set("Idempotency-Key", key).send(body);
}

function transfer(body: Record<string, unknown>, key = newKey(), token = admin) {
  return request.post(TRANSFERS).set(auth(token)).set("Idempotency-Key", key).send(body);
}

async function stockRow(storeId: string, variantId: string, token = admin) {
  const res = await request.get(`${API}/stores/${storeId}/stock?includeInactive=true&limit=100`).set(auth(token));
  expect(res.status).toBe(200);
  return res.body.data.items.find((item: { variant: { id: string } }) => item.variant.id === variantId);
}

/** Every level equals the sum of its movements, and its value is never negative. */
async function expectLedgerConsistent() {
  const levels = await StockLevel.find({ organizationId: org });
  for (const level of levels) {
    const [sum] = await StockMovement.aggregate([
      { $match: { organizationId: org, storeId: level.storeId, variantId: level.variantId } },
      { $group: { _id: null, quantityMilli: { $sum: "$quantityMilli" } } },
    ]);
    expect(sum.quantityMilli).toBe(level.quantityMilli);
    expect(level.valueMinor).toBeGreaterThanOrEqual(0);
  }
}

async function allowNegative(value: boolean) {
  await Organization.updateOne({ _id: org }, { $set: { "settings.inventory.allowNegativeStock": value } });
}

// ---------- opening stock ----------

describe("opening stock on the product form", () => {
  it("records opening movements per store and shows stock on hand", async () => {
    const { productId, variantId, product } = await coffee([
      { storeId: main, quantity: 10, unitCost: "1.000" },
      { storeId: mall, quantity: 4 },
    ]);
    expect(product.variants[0].stockOnHand).toBe(14);

    const mainRow = await stockRow(main, variantId);
    expect(mainRow).toMatchObject({ quantity: 10, averageCost: "1.000", stockValue: "10.000" });
    // No unitCost: the variant's cost price.
    expect(await stockRow(mall, variantId)).toMatchObject({ quantity: 4, averageCost: "1.600", stockValue: "6.400" });

    const history = await request.get(`${API}/stores/${main}/stock-movements`).set(auth(admin));
    expect(history.body.data.movements).toHaveLength(1);
    expect(history.body.data.movements[0]).toMatchObject({
      type: "opening",
      quantityChange: 10,
      quantityAfter: 10,
      unitCost: "1.000",
      valueChange: "10.000",
      source: { type: "product", id: productId, number: null },
      reason: null,
      createdBy: { name: "Test admin" },
    });

    const list = await request.get(`${PRODUCTS}?search=Coffee`).set(auth(admin));
    expect(list.body.data.products[0].stockOnHand).toBe(14);
    await expectLedgerConsistent();
  });

  it("accepts opening stock on each variant of a variant item and on add-variant", async () => {
    const product = await createProduct({
      name: "Rice",
      itemType: "variant",
      unit: "kg",
      attributes: [{ name: "Pack", options: ["1kg", "5kg", "10kg"] }],
      variants: [
        { attributeValues: { Pack: "1kg" }, sellingPrice: "1.000", openingStock: [{ storeId: main, quantity: 2.5, unitCost: "0.400" }] },
        { attributeValues: { Pack: "5kg" }, sellingPrice: "4.000" },
      ],
    });
    expect(product.variants.map((v: { stockOnHand: number }) => v.stockOnHand)).toEqual([2.5, 0]);

    const added = await request
      .post(`${PRODUCTS}/${product._id}/variants`)
      .set(auth(admin))
      .send({ attributeValues: { Pack: "10kg" }, sellingPrice: "7.000", openingStock: [{ storeId: mall, quantity: 3 }] });
    expect(added.status).toBe(201);
    expect(added.body.data.product.variants[2].stockOnHand).toBe(3);
  });

  it("refuses an inactive store, a fractional pcs quantity on add-variant, and untracked products", async () => {
    const inactive = await request
      .post(PRODUCTS)
      .set(auth(admin))
      .send({ name: "Tea", type: "goods", taxPreference: "exempt", sales: { sellingPrice: "1.000" }, inventory: { openingStock: [{ storeId: closed, quantity: 1 }] } });
    expect(inactive.status).toBe(400);
    expect(inactive.body.errors[0]).toMatchObject({ field: "inventory.openingStock[0].storeId", code: "STORE_INACTIVE" });

    const tee = await createProduct({
      name: "Tee",
      itemType: "variant",
      attributes: [{ name: "Size", options: ["S", "M"] }],
      variants: [{ attributeValues: { Size: "S" }, sellingPrice: "4.000" }],
    });
    const fractional = await request
      .post(`${PRODUCTS}/${tee._id}/variants`)
      .set(auth(admin))
      .send({ attributeValues: { Size: "M" }, sellingPrice: "4.000", openingStock: [{ storeId: main, quantity: 1.5 }] });
    expect(fractional.status).toBe(400);
    expect(fractional.body.errors[0].field).toBe("openingStock[0].quantity");

    await request.patch(`${PRODUCTS}/${tee._id}`).set(auth(admin)).send({ inventory: { trackInventory: false } });
    const untracked = await request
      .post(`${PRODUCTS}/${tee._id}/variants`)
      .set(auth(admin))
      .send({ attributeValues: { Size: "M" }, sellingPrice: "4.000", openingStock: [{ storeId: main, quantity: 1 }] });
    expect(untracked.status).toBe(400);
    expect(untracked.body.errors[0].field).toBe("openingStock");
    expect(await StockMovement.countDocuments({})).toBe(0);
  });
});

// ---------- catalog locks ----------

describe("catalog locks once stock has moved", () => {
  it("refuses deleting the product or variant, changing the unit, or untracking with stock on hand", async () => {
    const { productId } = await coffee([{ storeId: main, quantity: 3 }]);

    const del = await request.delete(`${PRODUCTS}/${productId}`).set(auth(admin));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("PRODUCT_IN_USE");

    const unit = await request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ unit: "kg" });
    expect(unit.status).toBe(409);
    expect(unit.body.code).toBe("UNIT_LOCKED");
    // Re-sending the same unit is not a change.
    expect((await request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ unit: "pcs" })).status).toBe(200);

    const untrack = await request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ inventory: { trackInventory: false } });
    expect(untrack.status).toBe(409);
    expect(untrack.body.code).toBe("STOCK_ON_HAND");

    // Once the stock is back to zero, tracking can be switched off.
    const { variantId } = { variantId: (await request.get(`${PRODUCTS}/${productId}`).set(auth(admin))).body.data.product.variants[0].id };
    expect((await adjust(admin, main, { reason: "count_correction", lines: [{ variantId, countedQuantity: 0 }] })).status).toBe(201);
    expect((await request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ inventory: { trackInventory: false } })).status).toBe(200);
  });

  it("refuses deleting a variant with history but allows one without", async () => {
    const tee = await createProduct({
      name: "Tee",
      itemType: "variant",
      attributes: [{ name: "Size", options: ["S", "M"] }],
      variants: [
        { attributeValues: { Size: "S" }, sellingPrice: "4.000", openingStock: [{ storeId: main, quantity: 1 }] },
        { attributeValues: { Size: "M" }, sellingPrice: "4.000" },
      ],
    });
    const [small, medium] = tee.variants;
    await request.patch(`${PRODUCTS}/${tee._id}/variants/${small.id}/deactivate`).set(auth(admin));
    const used = await request.delete(`${PRODUCTS}/${tee._id}/variants/${small.id}`).set(auth(admin));
    expect(used.status).toBe(409);
    expect(used.body.code).toBe("VARIANT_IN_USE");
    await request.patch(`${PRODUCTS}/${tee._id}/variants/${small.id}/activate`).set(auth(admin));
    expect((await request.delete(`${PRODUCTS}/${tee._id}/variants/${medium.id}`).set(auth(admin))).status).toBe(200);
  });
});

// ---------- adjustments ----------

describe("stock adjustments", () => {
  it("removes at the average cost and adds at a new cost (weighted average)", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 10, unitCost: "1.000" }]);

    const damaged = await adjust(admin, main, { reason: "damaged", note: "Dropped", lines: [{ variantId, quantityChange: -2 }] });
    expect(damaged.status).toBe(201);
    expect(damaged.body.data.adjustment).toMatchObject({
      reason: "damaged",
      note: "Dropped",
      valueChange: "-2.000",
      store: { id: main, name: "Main", code: "MAIN-1" },
      lines: [{ mode: "change", quantityBefore: 10, quantityChange: -2, quantityAfter: 8, unitCost: "1.000", valueChange: "-2.000", countedQuantity: null }],
    });

    const found = await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 10, unitCost: "2.500" }] });
    expect(found.status).toBe(201);
    // 8 × 1.000 + 10 × 2.500 = 33.000 over 18 → 1.833
    expect(await stockRow(main, variantId)).toMatchObject({ quantity: 18, stockValue: "33.000", averageCost: "1.833" });

    // Emptying the stock removes exactly the remaining value (no rounding residue).
    const empty = await adjust(admin, main, { reason: "theft_loss", lines: [{ variantId, quantityChange: -18 }] });
    expect(empty.body.data.adjustment.lines[0].valueChange).toBe("-33.000");
    expect(await stockRow(main, variantId)).toMatchObject({ quantity: 0, stockValue: "0.000", averageCost: "1.833" });
    await expectLedgerConsistent();
  });

  it("defaults the cost of added stock to the average, then the cost price", async () => {
    const { variantId } = await coffee();
    const first = await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 2 }] });
    expect(first.body.data.adjustment.lines[0].unitCost).toBe("1.600"); // cost price; no average yet
    await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 1, unitCost: "3.100" }] });
    const third = await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 1 }] });
    expect(third.body.data.adjustment.lines[0].unitCost).toBe("2.100"); // (3.200 + 3.100) / 3
  });

  it("refuses taking stock below zero, all-or-nothing across lines", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 3 }]);
    const tea = await coffee([{ storeId: main, quantity: 5 }], { name: "Tea" });

    const res = await adjust(admin, main, {
      reason: "damaged",
      lines: [
        { variantId: tea.variantId, quantityChange: -1 },
        { variantId, quantityChange: -4 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_STOCK");
    expect(res.body.errors).toEqual([
      expect.objectContaining({ field: "lines[1]", code: "INSUFFICIENT_STOCK", meta: { variantId, available: 3, requested: 4 } }),
    ]);
    expect((await stockRow(main, tea.variantId)).quantity).toBe(5);
    expect(await IdempotencyKey.countDocuments({})).toBe(0); // failures are not remembered
  });

  it("allows negative stock when the organization does, valued at zero", async () => {
    await allowNegative(true);
    const { variantId } = await coffee([{ storeId: main, quantity: 2, unitCost: "1.000" }]);
    const res = await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -5 }] });
    expect(res.status).toBe(201);
    expect(await stockRow(main, variantId)).toMatchObject({ quantity: -3, stockValue: "0.000", averageCost: "1.000" });

    const negative = await request.get(`${API}/stores/${main}/stock?status=negative`).set(auth(admin));
    expect(negative.body.data.items.map((item: { variant: { id: string } }) => item.variant.id)).toEqual([variantId]);

    // Adding back above zero restarts the average at the new cost.
    await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 5, unitCost: "2.000" }] });
    expect(await stockRow(main, variantId)).toMatchObject({ quantity: 2, stockValue: "4.000", averageCost: "2.000" });
    await expectLedgerConsistent();
  });

  it("set-to-counted records the difference, and nothing when the count matches", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 8 }]);
    const res = await adjust(admin, main, { reason: "count_correction", lines: [{ variantId, countedQuantity: 5 }] });
    expect(res.body.data.adjustment.lines[0]).toMatchObject({ mode: "count", countedQuantity: 5, quantityBefore: 8, quantityChange: -3, quantityAfter: 5 });

    const same = await adjust(admin, main, { reason: "count_correction", lines: [{ variantId, countedQuantity: 5 }] });
    expect(same.status).toBe(201);
    expect(same.body.data.adjustment.lines[0]).toMatchObject({ quantityChange: 0, quantityAfter: 5, valueChange: "0.000" });
    expect(await StockMovement.countDocuments({ type: "adjustment" })).toBe(1);
  });

  it("opening_balance writes opening movements and refuses a count below the current stock", async () => {
    const { variantId } = await coffee();
    const res = await adjust(admin, main, { reason: "opening_balance", lines: [{ variantId, countedQuantity: 12, unitCost: "1.200" }] });
    expect(res.status).toBe(201);
    const movement = await StockMovement.findOne({ variantId });
    expect(movement).toMatchObject({ type: "opening", reason: "opening_balance" });

    const lower = await adjust(admin, main, { reason: "opening_balance", lines: [{ variantId, countedQuantity: 3 }] });
    expect(lower.status).toBe(400);
    expect(lower.body.errors[0].field).toBe("lines[0].countedQuantity");
  });

  it("refuses unknown, deleted and untracked variants and fractional pcs quantities", async () => {
    const { variantId } = await coffee();
    const service = await createProduct({ name: "Wrap", type: "service", sales: { sellingPrice: "0.500" } });
    const unknown = new mongoose.Types.ObjectId().toString();

    const res = await adjust(admin, main, {
      reason: "found",
      lines: [
        { variantId: unknown, quantityChange: 1 },
        { variantId: service.variants[0].id, quantityChange: 1 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VARIANT_NOT_FOUND");
    expect(res.body.errors.map((e: { field: string; code: string }) => [e.field, e.code])).toEqual([
      ["lines[0].variantId", "VARIANT_NOT_FOUND"],
      ["lines[1].variantId", "VARIANT_NOT_STOCKED"],
    ]);

    const fractional = await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 1.5 }] });
    expect(fractional.status).toBe(400);
    expect(fractional.body.errors[0].field).toBe("lines[0].quantityChange");

    const cost = await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 1, unitCost: "1.0001" }] });
    expect(cost.status).toBe(400);
  });

  it("lists and fetches adjustments, newest first, filtered by reason", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 10 }]);
    const first = await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] });
    await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 2 }] });

    const list = await request.get(`${API}/stores/${main}/stock-adjustments`).set(auth(admin));
    expect(list.body.data.adjustments.map((a: { reason: string }) => a.reason)).toEqual(["found", "damaged"]);
    expect(list.body.data.adjustments[0]).toMatchObject({ lineCount: 1 });
    expect(list.body.data.adjustments[0].lines).toBeUndefined();

    const damagedOnly = await request.get(`${API}/stores/${main}/stock-adjustments?reason=damaged`).set(auth(admin));
    expect(damagedOnly.body.data.pagination.total).toBe(1);

    const id = first.body.data.adjustment.id;
    const one = await request.get(`${API}/stores/${main}/stock-adjustments/${id}`).set(auth(admin));
    expect(one.body.data.adjustment.lines).toHaveLength(1);
    // Another store's path does not find it.
    const elsewhere = await request.get(`${API}/stores/${mall}/stock-adjustments/${id}`).set(auth(admin));
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.body.code).toBe("ADJUSTMENT_NOT_FOUND");
  });
});

// ---------- idempotency ----------

describe("Idempotency-Key", () => {
  it("replays a retry with the same key and body, applying the change once", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 10 }]);
    const body = { reason: "damaged", lines: [{ variantId, quantityChange: -2 }] };
    const key = newKey();

    const first = await adjust(admin, main, body, key);
    const retry = await adjust(admin, main, body, key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(retry.body).toEqual(first.body);
    expect((await stockRow(main, variantId)).quantity).toBe(8);
  });

  it("refuses the same key with a different body, path or user, and requires a key", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 10 }]);
    const key = newKey();
    await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] }, key);

    const otherBody = await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -2 }] }, key);
    expect(otherBody.status).toBe(409);
    expect(otherBody.body.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const otherUser = await adjust(clerk, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] }, key);
    expect(otherUser.status).toBe(409);
    expect(otherUser.body.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const missing = await request.post(`${API}/stores/${main}/stock-adjustments`).set(auth(admin)).send({ reason: "found", lines: [{ variantId, quantityChange: 1 }] });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VALIDATION_FAILED");
    expect((await stockRow(main, variantId)).quantity).toBe(9);
  });

  it("applies concurrent retries with one key exactly once", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 10 }]);
    const body = { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] };
    const key = newKey();
    const results = await Promise.all([adjust(admin, main, body, key), adjust(admin, main, body, key), adjust(admin, main, body, key)]);
    for (const res of results) expect([201, 409]).toContain(res.status);
    expect(results.some((res) => res.status === 201)).toBe(true);
    expect((await stockRow(main, variantId)).quantity).toBe(9);
    expect(await StockMovement.countDocuments({ type: "adjustment" })).toBe(1);
  });
});

// ---------- concurrency ----------

describe("concurrent stock changes", () => {
  it("never sells the last unit twice", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 1 }]);
    const body = { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] };
    const results = await Promise.all([adjust(admin, main, body), adjust(admin, main, body), adjust(admin, main, body)]);
    expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409).every((res) => res.body.code === "INSUFFICIENT_STOCK")).toBe(true);
    expect((await stockRow(main, variantId)).quantity).toBe(0);
    await expectLedgerConsistent();
  });

  it("keeps every concurrent addition (no lost updates), including the first-ever level row", async () => {
    const { variantId } = await coffee();
    const body = { reason: "found", lines: [{ variantId, quantityChange: 1, unitCost: "1.000" }] };
    const results = await Promise.all(Array.from({ length: 5 }, () => adjust(admin, main, body)));
    expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
    expect(await stockRow(main, variantId)).toMatchObject({ quantity: 5, stockValue: "5.000" });
    await expectLedgerConsistent();
  });
});

// ---------- transfers ----------

describe("stock transfers", () => {
  it("moves stock at the source's average cost and recalculates the destination's", async () => {
    const { variantId } = await coffee([
      { storeId: main, quantity: 10, unitCost: "1.000" },
      { storeId: mall, quantity: 2, unitCost: "2.000" },
    ]);
    const res = await transfer({ fromStoreId: main, toStoreId: mall, note: "Restock", lines: [{ variantId, quantity: 4 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.transfer).toMatchObject({
      fromStore: { id: main },
      toStore: { id: mall },
      note: "Restock",
      totalValue: "4.000",
      lines: [{ quantity: 4, unitCost: "1.000", fromQuantityAfter: 6, toQuantityAfter: 6 }],
    });
    expect(await stockRow(main, variantId)).toMatchObject({ quantity: 6, stockValue: "6.000" });
    // 2 × 2.000 + 4 × 1.000 = 8.000 over 6 → 1.333
    expect(await stockRow(mall, variantId)).toMatchObject({ quantity: 6, stockValue: "8.000", averageCost: "1.333" });

    const outs = await StockMovement.find({ "source.id": res.body.data.transfer.id }).sort({ type: 1 });
    expect(outs.map((m) => [m.type, m.quantityMilli])).toEqual([
      ["transfer_in", 4000],
      ["transfer_out", -4000],
    ]);
    await expectLedgerConsistent();
  });

  it("always needs stock at the source, even when negative stock is allowed", async () => {
    await allowNegative(true);
    const { variantId } = await coffee([{ storeId: main, quantity: 1 }]);
    const res = await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 2 }] });
    expect(res.status).toBe(409);
    expect(res.body.errors[0]).toMatchObject({ code: "INSUFFICIENT_STOCK", meta: { available: 1, requested: 2 } });
  });

  it("refuses unknown and inactive stores and store-level callers", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const unknown = await transfer({ fromStoreId: main, toStoreId: new mongoose.Types.ObjectId().toString(), lines: [{ variantId, quantity: 1 }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors[0]).toMatchObject({ field: "toStoreId", code: "STORE_NOT_FOUND" });

    const inactive = await transfer({ fromStoreId: main, toStoreId: closed, lines: [{ variantId, quantity: 1 }] });
    expect(inactive.status).toBe(400);
    expect(inactive.body.errors[0]).toMatchObject({ field: "toStoreId", code: "STORE_INACTIVE" });

    expect((await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] }, newKey(), manager)).status).toBe(403);
    expect((await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] }, newKey(), accountant)).status).toBe(403);
  });

  it("empties a deactivated store into an active one, after which tracking can be switched off", async () => {
    const { productId, variantId } = await coffee([{ storeId: mall, quantity: 3, unitCost: "1.000" }]);
    await Store.updateOne({ _id: mall }, { $set: { isActive: false } });

    const locked = await request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ inventory: { trackInventory: false } });
    expect(locked.body.code).toBe("STOCK_ON_HAND");

    const out = await transfer({ fromStoreId: mall, toStoreId: main, lines: [{ variantId, quantity: 3 }] });
    expect(out.status).toBe(201);
    expect(out.body.data.transfer.lines[0]).toMatchObject({ fromQuantityAfter: 0, toQuantityAfter: 3, unitCost: "1.000" });
    // Still no stock may go *into* a deactivated store.
    const back = await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] });
    expect(back.body.errors[0]).toMatchObject({ field: "toStoreId", code: "STORE_INACTIVE" });

    expect((await adjust(admin, main, { reason: "count_correction", lines: [{ variantId, countedQuantity: 0 }] })).status).toBe(201);
    expect((await request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ inventory: { trackInventory: false } })).status).toBe(200);
    await expectLedgerConsistent();
  });

  it("lists transfers narrowed to the caller's stores", async () => {
    const { variantId } = await coffee([
      { storeId: main, quantity: 5 },
      { storeId: mall, quantity: 5 },
    ]);
    const third = (await createStore(org, "Souq", "SOUQ-1"))._id.toString();
    await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] });
    const unrelated = await transfer({ fromStoreId: mall, toStoreId: third, lines: [{ variantId, quantity: 1 }] });

    expect((await request.get(TRANSFERS).set(auth(admin))).body.data.pagination.total).toBe(2);
    const managerList = await request.get(TRANSFERS).set(auth(manager));
    expect(managerList.status).toBe(200);
    expect(managerList.body.data.transfers).toHaveLength(1);
    expect(managerList.body.data.transfers[0]).toMatchObject({ fromStore: { id: main }, lineCount: 1 });

    const hidden = await request.get(`${TRANSFERS}/${unrelated.body.data.transfer.id}`).set(auth(manager));
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe("TRANSFER_NOT_FOUND");
    expect((await request.get(TRANSFERS).set(auth(cashier))).status).toBe(403);
    const byStore = await request.get(`${TRANSFERS}?storeId=${third}`).set(auth(admin));
    expect(byStore.body.data.pagination.total).toBe(1);
  });
});

// ---------- reads and permissions ----------

describe("stock reads and permissions", () => {
  it("lists never-stocked variants with zero and flags low stock", async () => {
    const { variantId } = await coffee(); // reorder point 5, no stock
    const res = await request.get(`${API}/stores/${main}/stock`).set(auth(admin));
    expect(res.body.data.store).toMatchObject({ id: main, name: "Main" });
    expect(res.body.data.items[0]).toMatchObject({
      variant: { id: variantId, name: "Coffee", isActive: true },
      product: { name: "Coffee", unit: "pcs" },
      quantity: 0,
      reorderPoint: 5,
      isLow: true,
      averageCost: null,
      stockValue: "0.000",
      lastMovementAt: null,
    });
    const low = await request.get(`${API}/stores/${main}/stock?status=low`).set(auth(admin));
    expect(low.body.data.items).toHaveLength(1);
    const inStock = await request.get(`${API}/stores/${main}/stock?status=in_stock`).set(auth(admin));
    expect(inStock.body.data.items).toHaveLength(0);
  });

  it("shows quantities to cashiers but hides costs, and gates history by inventory:read", async () => {
    const { productId, variantId } = await coffee([{ storeId: main, quantity: 3, unitCost: "1.000" }]);

    const asCashier = await stockRow(main, variantId, cashier);
    expect(asCashier).toMatchObject({ quantity: 3, averageCost: null, stockValue: null });
    expect((await stockRow(main, variantId, clerk)).averageCost).toBe("1.000");

    expect((await request.get(`${API}/stores/${main}/stock-movements`).set(auth(cashier))).status).toBe(403);
    expect((await request.get(`${API}/stores/${main}/stock-movements`).set(auth(clerk))).status).toBe(200);
    expect((await request.get(`${API}/stores/${main}/stock-movements`).set(auth(accountant))).status).toBe(200);

    // The catalog's cost price follows the same rule.
    expect((await request.get(`${PRODUCTS}/${productId}`).set(auth(cashier))).body.data.product.variants[0].costPrice).toBeNull();
    expect((await request.get(`${PRODUCTS}/${productId}`).set(auth(accountant))).body.data.product.variants[0].costPrice).toBe("1.600");
  });

  it("limits store staff to their own store", async () => {
    const { variantId } = await coffee([{ storeId: mall, quantity: 3 }]);
    expect((await request.get(`${API}/stores/${mall}/stock`).set(auth(manager))).status).toBe(403);
    expect((await adjust(clerk, mall, { reason: "found", lines: [{ variantId, quantityChange: 1 }] })).status).toBe(403);
    expect((await adjust(cashier, main, { reason: "found", lines: [{ variantId, quantityChange: 1 }] })).status).toBe(403);
    expect((await adjust(clerk, main, { reason: "found", lines: [{ variantId, quantityChange: 1 }] })).status).toBe(201);
  });

  it("shows a product's stock per accessible store", async () => {
    const { productId } = await coffee([
      { storeId: main, quantity: 3, unitCost: "1.000" },
      { storeId: mall, quantity: 4, unitCost: "1.000" },
    ]);
    const asAdmin = await request.get(`${PRODUCTS}/${productId}/stock`).set(auth(admin));
    expect(asAdmin.body.data.product).toMatchObject({ name: "Coffee", trackInventory: true });
    expect(asAdmin.body.data.variants[0].totalQuantity).toBe(7);
    expect(asAdmin.body.data.variants[0].stores.map((s: { store: { name: string } }) => s.store.name)).toEqual(["Main", "Mall"]);

    const asCashier = await request.get(`${PRODUCTS}/${productId}/stock`).set(auth(cashier));
    expect(asCashier.body.data.variants[0]).toMatchObject({ totalQuantity: 3, stores: [{ quantity: 3, averageCost: null, stockValue: null }] });
  });

  it("filters history by type, variant and local dates", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 3 }]);
    const tea = await coffee([{ storeId: main, quantity: 2 }], { name: "Tea" });
    await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] });

    const get = (query: string) => request.get(`${API}/stores/${main}/stock-movements?${query}`).set(auth(admin));
    expect((await get("type=adjustment")).body.data.pagination.total).toBe(1);
    expect((await get(`variantId=${tea.variantId}`)).body.data.pagination.total).toBe(1);
    expect((await get("variantId=nonsense")).body.data.pagination.total).toBe(0);

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bahrain" }).format(new Date());
    expect((await get(`from=${today}&to=${today}`)).body.data.pagination.total).toBe(3);
    expect((await get("to=2000-01-01")).body.data.pagination.total).toBe(0);
  });
});

describe("the ledger is append-only", () => {
  it("refuses updates and deletes of movements", async () => {
    await coffee([{ storeId: main, quantity: 1 }]);
    await expect(StockMovement.updateOne({}, { $set: { quantityMilli: 5 } })).rejects.toThrow(/append-only/);
    await expect(StockMovement.deleteMany({})).rejects.toThrow(/append-only/);
  });
});
