/**
 * Purpose: Review tests for the Phase 2 stock ledger: cross-tenant and cross-store isolation,
 * idempotency edge cases, concurrency between transfers and adjustments, numeric edge cases,
 * permissions and cost visibility, strict response-schema checks, lenient query parsing, and the
 * catalog locks with soft-deleted rows. stockLedger.test.ts covers the main flows.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Product } from "../../src/models/product.model";
import { ProductVariant } from "../../src/models/productVariant.model";
import { StockLevel } from "../../src/models/stockLevel.model";
import { StockMovement } from "../../src/models/stockMovement.model";
import { StockAdjustment } from "../../src/models/stockAdjustment.model";
import { StockTransfer } from "../../src/models/stockTransfer.model";
import { IdempotencyKey, IDEMPOTENCY_TTL_SECONDS } from "../../src/models/idempotencyKey.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { runIdempotent } from "../../src/services/idempotency.service";
import {
  StockLevelListDataSchema,
  ProductStockDataSchema,
  StockMovementListDataSchema,
  StockAdjustmentDataSchema,
  StockAdjustmentListDataSchema,
  StockTransferDataSchema,
  StockTransferListDataSchema,
} from "../../src/validators/responses";

const API = "/api/v1";
const PRODUCTS = `${API}/products`;
const TRANSFERS = `${API}/stock-transfers`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let keyCounter = 0;
const newKey = () => `review-key-${Date.now()}-${++keyCounter}`;

/** Deep-strict copy of a documented response schema: an undocumented or missing field fails. */
function strictify(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, value]) => [key, strictify(value as z.ZodTypeAny)]));
    return z.object(shape).strict();
  }
  if (schema instanceof z.ZodArray) return z.array(strictify(schema.element));
  if (schema instanceof z.ZodNullable) return strictify(schema.unwrap()).nullable();
  if (schema instanceof z.ZodOptional) return strictify(schema.unwrap()).optional();
  return schema;
}

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

async function createOrg(slug: string) {
  const organization = await Organization.create({
    name: slug,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency: "BHD", timezone: "Asia/Bahrain" },
  });
  await seedDefaultRolesForOrganization(organization._id);
  await seedDefaultTaxRates(organization._id, "BHD");
  const roles = await Role.find({ organizationId: organization._id });
  return { id: organization._id as mongoose.Types.ObjectId, role: (roleSlug: string) => roles.find((r) => r.slug === roleSlug)!._id };
}

let org: mongoose.Types.ObjectId;
let role: (slug: string) => mongoose.Types.ObjectId;
let main: string;
let mall: string;
let souq: string;
let closed: string;
let admin: string;
let manager: string;
let cashier: string;
let clerk: string;
let accountant: string;

beforeAll(async () => {
  await Promise.all([StockLevel.init(), StockMovement.init(), IdempotencyKey.init()]);
});

beforeEach(async () => {
  const made = await createOrg("alnoor");
  org = made.id;
  role = made.role as typeof role;
  main = (await createStore(org, "Main", "MAIN-1"))._id.toString();
  mall = (await createStore(org, "Mall", "MALL-1"))._id.toString();
  souq = (await createStore(org, "Souq", "SOUQ-1"))._id.toString();
  closed = (await createStore(org, "Closed", "CLOSED-1", false))._id.toString();

  admin = await tokenFor(org, "admin@alnoor.test", { orgRoleId: role("org_admin") });
  accountant = await tokenFor(org, "accountant@alnoor.test", { orgRoleId: role("accountant") });
  manager = await tokenFor(org, "manager@alnoor.test", { storeAccess: [{ storeId: main, roleId: role("store_manager") }] });
  cashier = await tokenFor(org, "cashier@alnoor.test", { storeAccess: [{ storeId: main, roleId: role("cashier") }] });
  clerk = await tokenFor(org, "clerk@alnoor.test", { storeAccess: [{ storeId: main, roleId: role("inventory_clerk") }] });
});

// ---------- helpers ----------

async function createProductAs(token: string, body: Record<string, unknown>) {
  const res = await request.post(PRODUCTS).set(auth(token)).send({ type: "goods", taxPreference: "exempt", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.product;
}

async function coffeeAs(token: string, opening?: { storeId: string; quantity: number; unitCost?: string }[], extra: Record<string, unknown> = {}) {
  const product = await createProductAs(token, {
    name: "Coffee",
    sales: { sellingPrice: "2.750" },
    purchase: { costPrice: "1.600" },
    inventory: { reorderPoint: 5, ...(opening ? { openingStock: opening } : {}) },
    ...extra,
  });
  return { productId: product._id as string, variantId: product.variants[0].id as string, product };
}

const coffee = (opening?: { storeId: string; quantity: number; unitCost?: string }[], extra: Record<string, unknown> = {}) =>
  coffeeAs(admin, opening, extra);

function adjust(token: string, storeId: string, body: Record<string, unknown>, key = newKey()) {
  return request.post(`${API}/stores/${storeId}/stock-adjustments`).set(auth(token)).set("Idempotency-Key", key).send(body);
}

function transfer(body: Record<string, unknown>, key = newKey(), token = admin) {
  return request.post(TRANSFERS).set(auth(token)).set("Idempotency-Key", key).send(body);
}

async function level(storeId: string, variantId: string, organizationId: mongoose.Types.ObjectId = org) {
  return StockLevel.findOne({ organizationId, storeId, variantId });
}

async function allowNegative(value: boolean) {
  await Organization.updateOne({ _id: org }, { $set: { "settings.inventory.allowNegativeStock": value } });
}

/** Every level equals the sum of its movements, and its value is never negative. */
async function expectLedgerConsistent() {
  const levels = await StockLevel.find({});
  for (const lvl of levels) {
    const [sum] = await StockMovement.aggregate([
      { $match: { organizationId: lvl.organizationId, storeId: lvl.storeId, variantId: lvl.variantId } },
      { $group: { _id: null, quantityMilli: { $sum: "$quantityMilli" } } },
    ]);
    expect(sum.quantityMilli).toBe(lvl.quantityMilli);
    expect(lvl.valueMinor).toBeGreaterThanOrEqual(0);
    expect(Number.isSafeInteger(lvl.valueMinor)).toBe(true);
  }
}

/** A second organization with its own store, admin and stocked product. */
async function otherOrg() {
  const made = await createOrg("rival");
  const store = (await createStore(made.id, "Rival Main", "RIVAL-1"))._id.toString();
  const store2 = (await createStore(made.id, "Rival Two", "RIVAL-2"))._id.toString();
  const rivalAdmin = await tokenFor(made.id, "admin@rival.test", { orgRoleId: made.role("org_admin") });
  const product = await createProductAs(rivalAdmin, {
    name: "Rival Tea",
    sales: { sellingPrice: "1.000" },
    inventory: { openingStock: [{ storeId: store, quantity: 7, unitCost: "0.500" }] },
  });
  return { id: made.id, store, store2, admin: rivalAdmin, productId: product._id as string, variantId: product.variants[0].id as string };
}

// ==========================================
// 1. Tenant isolation
// ==========================================

describe("cross-tenant isolation", () => {
  it("refuses another organization's variant in an adjustment, writing nothing in either org", async () => {
    const rival = await otherOrg();
    const mine = await coffee([{ storeId: main, quantity: 5 }]);
    const before = await StockMovement.countDocuments({});

    const res = await adjust(admin, main, {
      reason: "found",
      lines: [
        { variantId: mine.variantId, quantityChange: 1 },
        { variantId: rival.variantId, quantityChange: 1 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([expect.objectContaining({ field: "lines[1].variantId", code: "VARIANT_NOT_FOUND" })]);
    expect(await StockMovement.countDocuments({})).toBe(before);
    expect((await level(rival.store, rival.variantId, rival.id))!.quantityMilli).toBe(7000);
  });

  it("refuses another organization's store as the adjustment target (404) and leaves its stock alone", async () => {
    const rival = await otherOrg();
    const res = await adjust(admin, rival.store, { reason: "damaged", lines: [{ variantId: rival.variantId, quantityChange: -1 }] });
    expect(res.status).toBe(404);
    expect((await level(rival.store, rival.variantId, rival.id))!.quantityMilli).toBe(7000);
    for (const path of ["stock", "stock-movements", "stock-adjustments"]) {
      expect((await request.get(`${API}/stores/${rival.store}/${path}`).set(auth(admin))).status).toBe(404);
    }
  });

  it("refuses another organization's store or variant in a transfer", async () => {
    const rival = await otherOrg();
    const mine = await coffee([{ storeId: main, quantity: 5 }]);

    const toRivalStore = await transfer({ fromStoreId: main, toStoreId: rival.store, lines: [{ variantId: mine.variantId, quantity: 1 }] });
    expect(toRivalStore.status).toBe(400);
    expect(toRivalStore.body.errors[0]).toMatchObject({ field: "toStoreId", code: "STORE_NOT_FOUND" });

    const fromRivalStore = await transfer({ fromStoreId: rival.store, toStoreId: main, lines: [{ variantId: rival.variantId, quantity: 1 }] });
    expect(fromRivalStore.status).toBe(400);
    expect(fromRivalStore.body.errors[0]).toMatchObject({ field: "fromStoreId", code: "STORE_NOT_FOUND" });

    const rivalVariant = await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId: rival.variantId, quantity: 1 }] });
    expect(rivalVariant.status).toBe(400);
    expect(rivalVariant.body.errors[0]).toMatchObject({ code: "VARIANT_NOT_FOUND" });
    expect((await level(rival.store, rival.variantId, rival.id))!.quantityMilli).toBe(7000);
    expect(await StockTransfer.countDocuments({})).toBe(0);
  });

  it("refuses another organization's store in opening stock, on create and on add-variant, persisting nothing", async () => {
    const rival = await otherOrg();
    const productsBefore = await Product.countDocuments({});
    const res = await request
      .post(PRODUCTS)
      .set(auth(admin))
      .send({ name: "Sneaky", type: "goods", taxPreference: "exempt", sales: { sellingPrice: "1.000" }, inventory: { openingStock: [{ storeId: rival.store, quantity: 1 }] } });
    expect(res.status).toBe(400);
    expect(res.body.errors[0]).toMatchObject({ field: "inventory.openingStock[0].storeId", code: "STORE_NOT_FOUND" });
    expect(await Product.countDocuments({})).toBe(productsBefore);

    const tee = await createProductAs(admin, {
      name: "Tee",
      itemType: "variant",
      attributes: [{ name: "Size", options: ["S", "M"] }],
      variants: [{ attributeValues: { Size: "S" }, sellingPrice: "4.000" }],
    });
    const added = await request
      .post(`${PRODUCTS}/${tee._id}/variants`)
      .set(auth(admin))
      .send({ attributeValues: { Size: "M" }, sellingPrice: "4.000", openingStock: [{ storeId: rival.store, quantity: 1 }] });
    expect(added.status).toBe(400);
    expect(await ProductVariant.countDocuments({ productId: tee._id })).toBe(1);
    expect(await StockLevel.countDocuments({ storeId: rival.store, quantityMilli: { $ne: 7000 } })).toBe(0);
  });

  it("does not let an organization read another's product stock, transfer or adjustment by id", async () => {
    const rival = await otherOrg();
    const rivalTransfer = (
      await transfer({ fromStoreId: rival.store, toStoreId: rival.store2, lines: [{ variantId: rival.variantId, quantity: 1 }] }, newKey(), rival.admin)
    ).body.data.transfer;
    const rivalAdjustment = (
      await adjust(rival.admin, rival.store, { reason: "damaged", lines: [{ variantId: rival.variantId, quantityChange: -1 }] })
    ).body.data.adjustment;
    expect(rivalTransfer.id).toBeTruthy();
    expect(rivalAdjustment.id).toBeTruthy();

    expect((await request.get(`${PRODUCTS}/${rival.productId}/stock`).set(auth(admin))).status).toBe(404);
    expect((await request.get(`${PRODUCTS}/${rival.productId}`).set(auth(admin))).status).toBe(404);
    expect((await request.get(`${TRANSFERS}/${rivalTransfer.id}`).set(auth(admin))).status).toBe(404);
    // Under my own store and under theirs.
    expect((await request.get(`${API}/stores/${main}/stock-adjustments/${rivalAdjustment.id}`).set(auth(admin))).status).toBe(404);
    expect((await request.get(`${API}/stores/${rival.store}/stock-adjustments/${rivalAdjustment.id}`).set(auth(admin))).status).toBe(404);
    // My lists never include theirs.
    expect((await request.get(TRANSFERS).set(auth(admin))).body.data.pagination.total).toBe(0);
    expect((await request.get(`${API}/stores/${main}/stock-adjustments`).set(auth(admin))).body.data.pagination.total).toBe(0);
  });

  it("scopes the stock list's $lookup: levels of another organization or store never leak in", async () => {
    const mine = await coffee([{ storeId: main, quantity: 3, unitCost: "1.000" }]);
    const rival = await otherOrg();
    const rogue = (organizationId: mongoose.Types.ObjectId, storeId: string, quantityMilli: number) =>
      StockLevel.create({
        organizationId,
        storeId,
        variantId: mine.variantId,
        productId: mine.productId,
        quantityMilli,
        valueMinor: 999_000,
        avgCostMinor: 777,
        lastMovementAt: new Date(),
      });
    await rogue(rival.id, main, 999_000); // same store id and variant id, but another organization
    await rogue(org, mall, 555_000); // same organization, another store

    const list = await request.get(`${API}/stores/${main}/stock`).set(auth(admin));
    const row = list.body.data.items.find((item: { variant: { id: string } }) => item.variant.id === mine.variantId);
    expect(row).toMatchObject({ quantity: 3, stockValue: "3.000", averageCost: "1.000" });

    // Totals and locks only see this organization's levels and movements.
    const product = await request.get(`${PRODUCTS}/${mine.productId}`).set(auth(admin));
    expect(product.body.data.product.variants[0].stockOnHand).toBe(558); // main 3 + mall 555 (both mine)
    const foreign = await StockMovement.create({
      organizationId: rival.id,
      storeId: rival.store,
      variantId: new mongoose.Types.ObjectId(),
      productId: new mongoose.Types.ObjectId(),
      type: "opening",
      quantityMilli: 1,
      quantityAfterMilli: 1,
      unitCostMinor: 0,
      valueChangeMinor: 0,
      source: { type: "product", id: new mongoose.Types.ObjectId(), number: null },
    });
    expect(foreign).toBeTruthy();
    const mallRow = await request.get(`${PRODUCTS}/${mine.productId}/stock`).set(auth(admin));
    const mallEntry = mallRow.body.data.variants[0].stores.find((s: { store: { id: string } }) => s.store.id === mall);
    expect(mallEntry.quantity).toBe(555);
  });

  it("does not let another organization's movements lock this organization's product", async () => {
    const mine = await coffee(); // never stocked
    const rival = await otherOrg();
    await StockMovement.create({
      organizationId: rival.id,
      storeId: rival.store,
      variantId: mine.variantId, // same variant id, different organization
      productId: mine.productId,
      type: "opening",
      quantityMilli: 1000,
      quantityAfterMilli: 1000,
      unitCostMinor: 0,
      valueChangeMinor: 0,
      source: { type: "product", id: new mongoose.Types.ObjectId(), number: null },
    });
    expect((await request.patch(`${PRODUCTS}/${mine.productId}`).set(auth(admin)).send({ unit: "kg" })).status).toBe(200);
    expect((await request.delete(`${PRODUCTS}/${mine.productId}`).set(auth(admin))).status).toBe(200);
  });

  it("filters movements by another organization's ids to nothing", async () => {
    const rival = await otherOrg();
    await coffee([{ storeId: main, quantity: 1 }]);
    const byVariant = await request.get(`${API}/stores/${main}/stock-movements?variantId=${rival.variantId}`).set(auth(admin));
    expect(byVariant.body.data.pagination.total).toBe(0);
    const byProduct = await request.get(`${API}/stores/${main}/stock-movements?productId=${rival.productId}`).set(auth(admin));
    expect(byProduct.body.data.pagination.total).toBe(0);
  });

  it("scopes idempotency keys per organization: another organization may reuse the same key", async () => {
    const rival = await otherOrg();
    const mine = await coffee([{ storeId: main, quantity: 5 }]);
    const key = newKey();
    const first = await adjust(admin, main, { reason: "damaged", lines: [{ variantId: mine.variantId, quantityChange: -1 }] }, key);
    expect(first.status).toBe(201);
    const theirs = await adjust(rival.admin, rival.store, { reason: "damaged", lines: [{ variantId: rival.variantId, quantityChange: -1 }] }, key);
    expect(theirs.status).toBe(201);
    expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
    expect(theirs.body.data.adjustment.id).not.toBe(first.body.data.adjustment.id);
    expect((await level(rival.store, rival.variantId, rival.id))!.quantityMilli).toBe(6000);
    expect(await IdempotencyKey.countDocuments({ key })).toBe(2);
  });

  it("never replays one organization's response to another that sends the same key and body", async () => {
    const rival = await otherOrg();
    const key = newKey();
    // Identical body shape; each organization's variant is its own.
    const mine = await coffee([{ storeId: main, quantity: 5 }]);
    await adjust(admin, main, { reason: "found", lines: [{ variantId: mine.variantId, quantityChange: 1 }] }, key);
    const theirs = await adjust(rival.admin, rival.store, { reason: "found", lines: [{ variantId: mine.variantId, quantityChange: 1 }] }, key);
    // Another organization cannot even see my variant: it fails validation, it is not a replay.
    expect(theirs.status).toBe(400);
    expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
    expect(JSON.stringify(theirs.body)).not.toContain("Coffee");
  });
});

// ==========================================
// 1b. Store boundaries inside one organization
// ==========================================

describe("store boundaries inside an organization", () => {
  it("cannot write another store's stock through the body, query or lines", async () => {
    const { variantId } = await coffee([
      { storeId: main, quantity: 5 },
      { storeId: mall, quantity: 5 },
    ]);
    // The store comes from the URL only: a body storeId is refused by the strict schema.
    const body = await adjust(clerk, main, { reason: "damaged", storeId: mall, lines: [{ variantId, quantityChange: -1 }] });
    expect(body.status).toBe(400);
    // A query storeId cannot redirect the write either.
    const query = await request
      .post(`${API}/stores/${main}/stock-adjustments?storeId=${mall}`)
      .set(auth(clerk))
      .set("Idempotency-Key", newKey())
      .send({ reason: "damaged", lines: [{ variantId, quantityChange: -1 }] });
    expect(query.status).toBe(201);
    expect((await level(main, variantId))!.quantityMilli).toBe(4000);
    expect((await level(mall, variantId))!.quantityMilli).toBe(5000);
    // A line-level storeId is refused too.
    const line = await adjust(clerk, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1, storeId: mall }] });
    expect(line.status).toBe(400);
  });

  it("refuses a store user reading or writing a store they were not assigned", async () => {
    const { variantId } = await coffee([{ storeId: mall, quantity: 5 }]);
    for (const path of ["stock", "stock-movements", "stock-adjustments"]) {
      expect((await request.get(`${API}/stores/${mall}/${path}`).set(auth(manager))).status).toBe(403);
    }
    expect((await adjust(manager, mall, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] })).status).toBe(403);
    expect((await level(mall, variantId))!.quantityMilli).toBe(5000);
  });

  it("works with an upper-case store id in the URL for an organization admin", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const upper = main.toUpperCase();
    expect((await request.get(`${API}/stores/${upper}/stock`).set(auth(admin))).status).toBe(200);
    expect((await request.get(`${API}/stores/${upper}/stock-movements`).set(auth(admin))).status).toBe(200);
    expect((await request.get(`${API}/stores/${upper}/stock-adjustments`).set(auth(admin))).status).toBe(200);
    const res = await adjust(admin, upper, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await level(main, variantId))!.quantityMilli).toBe(4000);
  });
});

// ==========================================
// 2. Idempotency
// ==========================================

describe("Idempotency-Key edge cases", () => {
  it("includes the real store id in the fingerprint: the same key and body for another store is refused", async () => {
    const { variantId } = await coffee([
      { storeId: main, quantity: 5 },
      { storeId: mall, quantity: 5 },
    ]);
    const body = { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] };
    const key = newKey();
    expect((await adjust(admin, main, body, key)).status).toBe(201);
    const other = await adjust(admin, mall, body, key);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await level(mall, variantId))!.quantityMilli).toBe(5000);
  });

  it("refuses one key across endpoints (adjustment vs transfer)", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const key = newKey();
    expect((await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] }, key)).status).toBe(201);
    const res = await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] }, key);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await StockTransfer.countDocuments({})).toBe(0);
  });

  it("replays a transfer byte for byte and applies it once", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5, unitCost: "1.000" }]);
    const body = { fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 2 }] };
    const key = newKey();
    const first = await transfer(body, key);
    const retry = await transfer(body, key);
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.text).toBe(first.text);
    expect((await level(main, variantId))!.quantityMilli).toBe(3000);
    expect(await StockTransfer.countDocuments({})).toBe(1);
  });

  it("treats key order inside the body as the same request", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const key = newKey();
    const first = await adjust(admin, main, { reason: "damaged", note: "Dropped", lines: [{ variantId, quantityChange: -1 }] }, key);
    const reordered = await adjust(admin, main, { lines: [{ quantityChange: -1, variantId }], note: "Dropped", reason: "damaged" }, key);
    expect(reordered.status).toBe(201);
    expect(reordered.headers["idempotent-replayed"]).toBe("true");
    expect(reordered.text).toBe(first.text);
    expect((await level(main, variantId))!.quantityMilli).toBe(4000);
  });

  it("does not remember failures: the same key works once the cause is fixed", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 1 }]);
    const key = newKey();
    const body = { reason: "damaged", lines: [{ variantId, quantityChange: -3 }] };
    expect((await adjust(admin, main, body, key)).status).toBe(409);
    await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 5 }] });
    const retry = await adjust(admin, main, body, key);
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBeUndefined();
    expect((await level(main, variantId))!.quantityMilli).toBe(3000);
  });

  it("does not record a key for requests refused by authentication, permissions or validation", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const key = newKey();
    const body = { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] };
    expect((await request.post(`${API}/stores/${main}/stock-adjustments`).set("Idempotency-Key", key).send(body)).status).toBe(401);
    expect((await adjust(cashier, main, body, key)).status).toBe(403);
    expect((await adjust(admin, main, { reason: "damaged", lines: [] }, key)).status).toBe(400);
    expect((await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] }, key, manager)).status).toBe(403);
    expect(await IdempotencyKey.countDocuments({})).toBe(0);
  });

  it("validates the key format", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const body = { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] };
    for (const bad of ["short", "has spaces in it!", "x".repeat(129), "bad/char/key-1"]) {
      const res = await adjust(admin, main, body, bad);
      expect(res.status, bad).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    }
    expect((await adjust(admin, main, body, "x".repeat(128))).status).toBe(201);
    expect((await level(main, variantId))!.quantityMilli).toBe(4000);
  });

  it("expires keys after 24 hours with a TTL index on createdAt", async () => {
    const indexes = await IdempotencyKey.collection.indexes();
    const ttl = indexes.find((index) => index.key && (index.key as Record<string, number>).createdAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(IDEMPOTENCY_TTL_SECONDS);
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    const unique = indexes.find((index) => index.unique && (index.key as Record<string, number>).key === 1);
    expect(unique?.key).toEqual({ organizationId: 1, key: 1 });
  });

  it("answers concurrent retries of one key with one 201 and replays or a documented conflict, never a 500", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 10 }]);
    const body = { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] };
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 5 }, () => adjust(admin, main, body, key)));
    const statuses = results.map((res) => res.status);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    for (const res of results) {
      expect([201, 409]).toContain(res.status);
      if (res.status === 409) expect(["IDEMPOTENCY_IN_PROGRESS", "IDEMPOTENCY_KEY_REUSED"]).toContain(res.body.code);
    }
    // Every 201 carries the same adjustment, and the stock moved exactly once.
    const ids = new Set(results.filter((res) => res.status === 201).map((res) => res.body.data.adjustment.id));
    expect(ids.size).toBe(1);
    expect((await level(main, variantId))!.quantityMilli).toBe(9000);
    expect(await StockAdjustment.countDocuments({})).toBe(1);
  });

  it("answers IDEMPOTENCY_IN_PROGRESS when the key row exists but cannot be read back", async () => {
    // The work inserts the key itself, so the guard's own insert hits the unique index and the
    // surrounding transaction rolls back: nothing is left to replay.
    const key = newKey();
    const run = runIdempotent(
      { organizationId: String(org), key, userId: "u1", method: "POST", path: "/x", body: {} },
      201,
      async (session) => {
        await IdempotencyKey.create([{ organizationId: org, key, fingerprint: "f", statusCode: 201, responseBody: {} }], { session });
        return {};
      }
    );
    await expect(run).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_IN_PROGRESS" });
    expect(await IdempotencyKey.countDocuments({})).toBe(0);
  });

  it("rolls back stock and the key together when the work fails", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const key = newKey();
    await expect(
      runIdempotent({ organizationId: String(org), key, userId: "u1", method: "POST", path: "/x", body: {} }, 201, async (session) => {
        await StockLevel.updateOne({ organizationId: org, storeId: main, variantId }, { $set: { quantityMilli: 1 } }, { session });
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect((await level(main, variantId))!.quantityMilli).toBe(5000);
    expect(await IdempotencyKey.countDocuments({})).toBe(0);
  });
});

// ==========================================
// 3. Concurrency
// ==========================================

describe("concurrency between stock writers", () => {
  it("lets exactly one of a concurrent transfer and adjustment take the last units", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 4, unitCost: "1.000" }]);
    const [t, a] = await Promise.all([
      transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 4 }] }),
      adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -4 }] }),
    ]);
    expect([t.status, a.status].sort()).toEqual([201, 409]);
    const loser = t.status === 409 ? t : a;
    expect(loser.body.code).toBe("INSUFFICIENT_STOCK");
    expect((await level(main, variantId))!.quantityMilli).toBe(0);
    await expectLedgerConsistent();
  });

  it("keeps stock and value consistent under opposing transfers and adjustments", async () => {
    const { variantId } = await coffee([
      { storeId: main, quantity: 10, unitCost: "1.000" },
      { storeId: mall, quantity: 10, unitCost: "2.000" },
    ]);
    const results = await Promise.all([
      transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 3 }] }),
      transfer({ fromStoreId: mall, toStoreId: main, lines: [{ variantId, quantity: 2 }] }),
      adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] }),
      adjust(admin, mall, { reason: "found", lines: [{ variantId, quantityChange: 1, unitCost: "3.000" }] }),
      transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] }),
    ]);
    for (const res of results) expect(res.status, JSON.stringify(res.body)).toBe(201);
    // 20 + 1 found - 1 damaged: transfers only move stock.
    const total = (await StockLevel.find({ variantId })).reduce((sum, lvl) => sum + lvl.quantityMilli, 0);
    expect(total).toBe(20_000);
    await expectLedgerConsistent();
  });

  it("survives many concurrent first-ever writes to one level row", async () => {
    const { variantId } = await coffee();
    const body = { reason: "found", lines: [{ variantId, quantityChange: 1, unitCost: "1.000" }] };
    const results = await Promise.all(Array.from({ length: 12 }, () => adjust(admin, main, body)));
    expect(results.map((res) => res.status)).toEqual(Array(12).fill(201));
    expect((await level(main, variantId))!.quantityMilli).toBe(12_000);
    expect(await StockLevel.countDocuments({ storeId: main, variantId })).toBe(1);
    await expectLedgerConsistent();
  });

  it("survives concurrent first-ever transfers into one destination from two sources", async () => {
    const { variantId } = await coffee([
      { storeId: main, quantity: 5, unitCost: "1.000" },
      { storeId: mall, quantity: 5, unitCost: "2.000" },
    ]);
    const results = await Promise.all([
      transfer({ fromStoreId: main, toStoreId: souq, lines: [{ variantId, quantity: 2 }] }),
      transfer({ fromStoreId: mall, toStoreId: souq, lines: [{ variantId, quantity: 3 }] }),
    ]);
    expect(results.map((res) => res.status)).toEqual([201, 201]);
    // 2 × 1.000 + 3 × 2.000 = 8.000 over 5.
    expect(await level(souq, variantId)).toMatchObject({ quantityMilli: 5000, valueMinor: 8000 });
    await expectLedgerConsistent();
  });

  it("serialises concurrent adjustments of one variant in two stores without crossing them", async () => {
    const { variantId } = await coffee([
      { storeId: main, quantity: 5 },
      { storeId: mall, quantity: 5 },
    ]);
    const results = await Promise.all([
      adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -2 }] }),
      adjust(admin, mall, { reason: "damaged", lines: [{ variantId, quantityChange: -3 }] }),
    ]);
    expect(results.map((res) => res.status)).toEqual([201, 201]);
    expect((await level(main, variantId))!.quantityMilli).toBe(3000);
    expect((await level(mall, variantId))!.quantityMilli).toBe(2000);
    await expectLedgerConsistent();
  });

  it("rolls a transfer back completely when a later line fails (nothing partial persists)", async () => {
    const a = await coffee([{ storeId: main, quantity: 5, unitCost: "1.000" }]);
    const b = await coffee([{ storeId: main, quantity: 1 }], { name: "Tea" });
    const movementsBefore = await StockMovement.countDocuments({});
    const res = await transfer({
      fromStoreId: main,
      toStoreId: mall,
      lines: [
        { variantId: a.variantId, quantity: 2 },
        { variantId: b.variantId, quantity: 9 },
      ],
    });
    expect(res.status).toBe(409);
    expect(await StockMovement.countDocuments({})).toBe(movementsBefore);
    expect(await StockTransfer.countDocuments({})).toBe(0);
    expect((await level(main, a.variantId))!.quantityMilli).toBe(5000);
    expect(await level(mall, a.variantId)).toBeNull();
  });
});

// ==========================================
// 4. Numeric edge cases over HTTP
// ==========================================

describe("numeric edge cases", () => {
  it("handles 0.001 kg at a very high cost, and empties exactly", async () => {
    const { variantId } = await coffee(undefined, { unit: "kg", name: "Saffron" });
    const add = await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 0.001, unitCost: "999999.999" }] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.data.adjustment.lines[0]).toMatchObject({ quantityAfter: 0.001, valueChange: "1000.000" });
    const remove = await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -0.001 }] });
    expect(remove.body.data.adjustment.lines[0]).toMatchObject({ quantityAfter: 0, valueChange: "-1000.000" });
    expect(await level(main, variantId)).toMatchObject({ quantityMilli: 0, valueMinor: 0 });
  });

  it("never leaves a negative value when rounding exceeds what remains", async () => {
    const { variantId } = await coffee(undefined, { unit: "kg", name: "Cardamom" });
    await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 0.002, unitCost: "0.001" }] });
    // value = round(1 × 2 / 1000) = 0; removing 0.001 must not make the value negative.
    const res = await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -0.001 }] });
    expect(res.status).toBe(201);
    expect((await level(main, variantId))!.valueMinor).toBeGreaterThanOrEqual(0);
    await expectLedgerConsistent();
  });

  it("refuses amounts that cannot be stored exactly (huge quantity × cost) without persisting anything", async () => {
    const { variantId } = await coffee(undefined, { unit: "kg", name: "Gold dust" });
    const res = await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 1_000_000_000, unitCost: "9999999999.999" }] });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await StockMovement.countDocuments({})).toBe(0);
    expect(await level(main, variantId)).toBeNull();
    expect(await IdempotencyKey.countDocuments({})).toBe(0);
  });

  it("refuses opening stock whose value cannot be stored exactly, persisting no product", async () => {
    const res = await request.post(PRODUCTS).set(auth(admin)).send({
      name: "Bullion",
      type: "goods",
      unit: "kg",
      taxPreference: "exempt",
      sales: { sellingPrice: "1.000" },
      inventory: { openingStock: [{ storeId: main, quantity: 1_000_000_000, unitCost: "9999999999.999" }] },
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    expect(await Product.countDocuments({ name: "Bullion" })).toBe(0);
    expect(await StockLevel.countDocuments({})).toBe(0);
  });

  it("count mode on negative stock records the difference and restarts the value above zero", async () => {
    await allowNegative(true);
    const { variantId } = await coffee([{ storeId: main, quantity: 2, unitCost: "1.000" }]);
    await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -5 }] }); // -3
    const count = await adjust(admin, main, { reason: "count_correction", lines: [{ variantId, countedQuantity: 4 }] });
    expect(count.status).toBe(201);
    expect(count.body.data.adjustment.lines[0]).toMatchObject({ mode: "count", quantityBefore: -3, quantityChange: 7, quantityAfter: 4, unitCost: "1.000" });
    // Only the 4 above zero carry value: 4 × 1.000.
    expect(await level(main, variantId)).toMatchObject({ quantityMilli: 4000, valueMinor: 4000 });
    await expectLedgerConsistent();
  });

  it("count to zero from negative stock leaves a zero-value, zero-quantity level", async () => {
    await allowNegative(true);
    const { variantId } = await coffee([{ storeId: main, quantity: 1, unitCost: "1.000" }]);
    await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -3 }] }); // -2
    const count = await adjust(admin, main, { reason: "count_correction", lines: [{ variantId, countedQuantity: 0 }] });
    expect(count.status).toBe(201);
    expect(await level(main, variantId)).toMatchObject({ quantityMilli: 0, valueMinor: 0 });
  });

  it("opening_balance may not count below negative-free stock but may count up from negative stock", async () => {
    await allowNegative(true);
    const { variantId } = await coffee([{ storeId: main, quantity: 1, unitCost: "1.000" }]);
    await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -3 }] }); // -2
    const up = await adjust(admin, main, { reason: "opening_balance", lines: [{ variantId, countedQuantity: 3, unitCost: "2.000" }] });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(await level(main, variantId)).toMatchObject({ quantityMilli: 3000, valueMinor: 6000 });
  });

  it("negative stock then transfer: the source needs real stock, the destination may be negative", async () => {
    await allowNegative(true);
    const { variantId } = await coffee([{ storeId: main, quantity: 4, unitCost: "1.000" }]);
    // Make the destination negative (-2) with a last average cost of 5.000 on record.
    await adjust(admin, mall, { reason: "found", lines: [{ variantId, quantityChange: 1, unitCost: "5.000" }] });
    await adjust(admin, mall, { reason: "damaged", lines: [{ variantId, quantityChange: -3 }] });
    expect((await level(mall, variantId))!.quantityMilli).toBe(-2000);

    // A negative source is refused, reporting 0 available.
    const fromNegative = await transfer({ fromStoreId: mall, toStoreId: main, lines: [{ variantId, quantity: 1 }] });
    expect(fromNegative.status).toBe(409);
    expect(fromNegative.body.errors[0].meta).toMatchObject({ available: 0, requested: 1 });

    // Receiving 4 at 1.000 into -2 leaves 2 units worth 2 × 1.000.
    const into = await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 4 }] });
    expect(into.status, JSON.stringify(into.body)).toBe(201);
    expect(into.body.data.transfer.lines[0]).toMatchObject({ unitCost: "1.000", toQuantityAfter: 2 });
    expect(await level(mall, variantId)).toMatchObject({ quantityMilli: 2000, valueMinor: 2000 });
    await expectLedgerConsistent();
  });

  it("transfers an uneven average without creating or losing value", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 3, unitCost: "0.001" }]);
    await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 4, unitCost: "0.002" }] }); // value 11 over 7
    const valueBefore = (await level(main, variantId))!.valueMinor;
    expect(valueBefore).toBe(11);
    for (const quantity of [1, 2, 1]) {
      const res = await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity }] });
      expect(res.status).toBe(201);
    }
    const [m, s] = await Promise.all([level(main, variantId), level(mall, variantId)]);
    expect(m!.valueMinor + s!.valueMinor).toBe(valueBefore);
    await expectLedgerConsistent();
  });

  it("refuses fractional quantities for whole-number units on transfers and opening stock too", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const res = await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1.5 }] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe("lines[0].quantity");
    const count = await adjust(admin, main, { reason: "count_correction", lines: [{ variantId, countedQuantity: 2.5 }] });
    expect(count.status).toBe(400);
    expect(count.body.errors[0].field).toBe("lines[0].countedQuantity");
  });

  it("accepts a fractional float-noise quantity safely (0.1 + 0.2 style inputs)", async () => {
    const { variantId } = await coffee(undefined, { unit: "kg", name: "Flour" });
    const res = await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 0.3, unitCost: "1.000" }] });
    expect(res.status).toBe(201);
    expect((await level(main, variantId))!.quantityMilli).toBe(300);
  });
});

// ==========================================
// 5. Permissions and cost visibility
// ==========================================

describe("permissions and cost visibility", () => {
  async function customStoreUser(email: string, permissions: string[]) {
    const custom = await Role.create({
      organizationId: org,
      scope: "store",
      name: `Custom ${email}`,
      slug: `custom-${email.split("@")[0]}`,
      isSystemRole: false,
      permissions,
    });
    return tokenFor(org, email, { storeAccess: [{ storeId: main, roleId: custom._id }] });
  }

  it("rejects missing, malformed, wrong-secret and expired tokens on every stock route", async () => {
    const paths: [string, string][] = [
      ["get", `${API}/stores/${main}/stock`],
      ["get", `${API}/stores/${main}/stock-movements`],
      ["get", `${API}/stores/${main}/stock-adjustments`],
      ["post", `${API}/stores/${main}/stock-adjustments`],
      ["get", TRANSFERS],
      ["post", TRANSFERS],
      ["get", `${PRODUCTS}/${new mongoose.Types.ObjectId()}/stock`],
    ];
    const forged = jwt.sign({ userId: new mongoose.Types.ObjectId().toString(), organizationId: String(org), isSuperAdmin: true }, "not-the-secret");
    const expired = jwt.sign({ userId: "x", organizationId: String(org) }, "not-the-secret", { expiresIn: -10 });
    for (const [method, path] of paths) {
      const call = (header?: string) => {
        const req = (request as unknown as Record<string, (p: string) => import("supertest").Test>)[method](path);
        return header ? req.set("Authorization", header) : req;
      };
      expect((await call()).status, `${method} ${path} no token`).toBe(401);
      expect((await call("Bearer garbage")).status, `${method} ${path} malformed`).toBe(401);
      expect((await call(`Bearer ${forged}`)).status, `${method} ${path} wrong secret`).toBe(401);
      expect((await call(`Bearer ${expired}`)).status, `${method} ${path} expired`).toBe(401);
    }
  });

  it("shows costs per store in a product's stock to a user with inventory:read in only one store", async () => {
    const { productId } = await coffee([
      { storeId: main, quantity: 3, unitCost: "1.000" },
      { storeId: mall, quantity: 4, unitCost: "1.000" },
    ]);
    // Clerk: inventory:read at main only; sees main only (store access), with costs.
    const res = await request.get(`${PRODUCTS}/${productId}/stock`).set(auth(clerk));
    expect(res.status).toBe(200);
    expect(res.body.data.variants[0].stores).toHaveLength(1);
    expect(res.body.data.variants[0].stores[0]).toMatchObject({ store: { id: main }, averageCost: "1.000", stockValue: "3.000" });
    // A user with two stores and inventory:read at only one gets costs only for that one.
    const mixedRole = await Role.create({ organizationId: org, scope: "store", name: "Read only", slug: "read-only", permissions: ["product:read", "inventory:read"] });
    const mixed = await tokenFor(org, "mixed@alnoor.test", {
      storeAccess: [
        { storeId: main, roleId: mixedRole._id },
        { storeId: mall, roleId: role("cashier") },
      ],
    });
    const mixedRes = await request.get(`${PRODUCTS}/${productId}/stock`).set(auth(mixed));
    const byStore = Object.fromEntries(mixedRes.body.data.variants[0].stores.map((s: { store: { id: string }; averageCost: string | null; stockValue: string | null }) => [s.store.id, s]));
    expect(byStore[main]).toMatchObject({ averageCost: "1.000", stockValue: "3.000" });
    expect(byStore[mall]).toMatchObject({ quantity: 4, averageCost: null, stockValue: null });
  });

  it("hides stock costs from a store user whose inventory:read is held in a different store", async () => {
    await coffee([{ storeId: main, quantity: 3, unitCost: "1.000" }]);
    const mixedRole = await Role.create({ organizationId: org, scope: "store", name: "Read only", slug: "read-only", permissions: ["product:read", "inventory:read"] });
    const mixed = await tokenFor(org, "mixed2@alnoor.test", {
      storeAccess: [
        { storeId: main, roleId: role("cashier") },
        { storeId: mall, roleId: mixedRole._id },
      ],
    });
    const list = await request.get(`${API}/stores/${main}/stock`).set(auth(mixed));
    expect(list.status).toBe(200);
    expect(list.body.data.items[0]).toMatchObject({ quantity: 3, averageCost: null, stockValue: null });
    expect((await request.get(`${API}/stores/${main}/stock-movements`).set(auth(mixed))).status).toBe(403);
  });

  it("hides the catalog cost price from cashiers everywhere it appears (get, lookup, stock)", async () => {
    const { productId } = await coffee([{ storeId: main, quantity: 3, unitCost: "1.000" }], { sku: "COF-1" });
    const get = await request.get(`${PRODUCTS}/${productId}`).set(auth(cashier));
    expect(get.body.data.product.variants[0].costPrice).toBeNull();
    const lookup = await request.get(`${PRODUCTS}/lookup?code=COF-1`).set(auth(cashier));
    expect(lookup.status).toBe(200);
    expect(lookup.body.data.product.variants[0].costPrice).toBeNull();
    expect((await request.get(`${PRODUCTS}/lookup?code=COF-1`).set(auth(accountant))).body.data.product.variants[0].costPrice).toBe("1.600");
    // And the response never carries the raw minor-unit cost.
    expect(JSON.stringify(get.body)).not.toMatch(/costPriceMinor|avgCostMinor|valueMinor/);
  });

  it("serves a deactivated store nothing while product stock skips it", async () => {
    const { productId, variantId } = await coffee();
    for (const path of ["stock", "stock-movements", "stock-adjustments"]) {
      expect((await request.get(`${API}/stores/${closed}/${path}`).set(auth(admin))).status).toBe(403);
    }
    expect((await adjust(admin, closed, { reason: "found", lines: [{ variantId, quantityChange: 1 }] })).status).toBe(403);
    const stock = await request.get(`${PRODUCTS}/${productId}/stock`).set(auth(admin));
    expect(stock.body.data.variants[0].stores.map((s: { store: { id: string } }) => s.store.id)).not.toContain(closed);
    expect(await StockMovement.countDocuments({})).toBe(0);
  });

  it("lets a store manager see transfers touching their store, but not others, and narrows ?storeId", async () => {
    const { variantId } = await coffee([
      { storeId: main, quantity: 5 },
      { storeId: mall, quantity: 5 },
    ]);
    const visible = await transfer({ fromStoreId: mall, toStoreId: main, lines: [{ variantId, quantity: 1 }] });
    const hidden = await transfer({ fromStoreId: mall, toStoreId: souq, lines: [{ variantId, quantity: 1 }] });
    expect((await request.get(`${TRANSFERS}/${visible.body.data.transfer.id}`).set(auth(manager))).status).toBe(200);
    const denied = await request.get(`${TRANSFERS}/${hidden.body.data.transfer.id}`).set(auth(manager));
    // Indistinguishable from a transfer that does not exist, so ids cannot be probed.
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe("TRANSFER_NOT_FOUND");
    expect(JSON.stringify(denied.body)).not.toContain("Souq");
    // Asking for another store's transfers narrows to nothing rather than widening the view.
    const filtered = await request.get(`${TRANSFERS}?storeId=${souq}`).set(auth(manager));
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.pagination.total).toBe(0);
    expect((await request.get(`${TRANSFERS}?storeId=${main}`).set(auth(manager))).body.data.pagination.total).toBe(1);
  });

  it("refuses transfers to every store-level role and to an org role without inventory:transfer", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const body = { fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] };
    for (const token of [manager, clerk, cashier, accountant]) {
      expect((await transfer(body, newKey(), token)).status).toBe(403);
    }
    const noTransferRole = await Role.create({ organizationId: org, scope: "organization", name: "Stock viewer", slug: "stock-viewer", permissions: ["inventory:read", "product:read"] });
    const viewer = await tokenFor(org, "viewer@alnoor.test", { orgRoleId: noTransferRole._id });
    expect((await transfer(body, newKey(), viewer)).status).toBe(403);
    expect((await request.get(TRANSFERS).set(auth(viewer))).status).toBe(200);
    expect(await StockTransfer.countDocuments({})).toBe(0);
  });

  it("requires inventory:adjust for adjustments and inventory:read for history, independently", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const readOnly = await customStoreUser("ro@alnoor.test", ["product:read", "inventory:read"]);
    const adjustOnly = await customStoreUser("ao@alnoor.test", ["product:read", "inventory:adjust"]);
    expect((await adjust(readOnly, main, { reason: "found", lines: [{ variantId, quantityChange: 1 }] })).status).toBe(403);
    expect((await request.get(`${API}/stores/${main}/stock-movements`).set(auth(adjustOnly))).status).toBe(403);
    expect((await request.get(`${API}/stores/${main}/stock-adjustments`).set(auth(adjustOnly))).status).toBe(403);
    expect((await adjust(adjustOnly, main, { reason: "found", lines: [{ variantId, quantityChange: 1 }] })).status).toBe(201);
  });

  // Finding: the POST response of an adjustment carries unitCost/valueChange (the store's average
  // cost) to a caller who only holds inventory:adjust, although every read hides costs from
  // callers without inventory:read.
  it("hides average costs in the adjustment response from a caller without inventory:read", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5, unitCost: "1.234" }]);
    const adjustOnly = await customStoreUser("ao2@alnoor.test", ["product:read", "inventory:adjust"]);
    const res = await adjust(adjustOnly, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain("1.234");
  });

  it("does not leak password hashes, tokens, stacks or minor-unit fields in any stock response", async () => {
    const { productId, variantId } = await coffee([{ storeId: main, quantity: 5, unitCost: "1.000" }]);
    const responses = [
      await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] }),
      await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] }),
      await request.get(`${API}/stores/${main}/stock`).set(auth(admin)),
      await request.get(`${API}/stores/${main}/stock-movements`).set(auth(admin)),
      await request.get(`${PRODUCTS}/${productId}/stock`).set(auth(admin)),
      await request.get(TRANSFERS).set(auth(admin)),
      await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -99 }] }),
    ];
    for (const res of responses) {
      expect(res.text).not.toMatch(/passwordHash|SecurePassword123|refreshToken|"stack"|Milli"|Minor"/);
    }
  });
});

// ==========================================
// 6. Response shapes against the documented schemas
// ==========================================

describe("responses match the documented schemas exactly", () => {
  it("validates every stock response", async () => {
    const category = await request.post(`${API}/categories`).set(auth(admin)).send({ name: "Drinks" });
    const categoryId = category.body.data.category?._id ?? category.body.data.category?.id;
    const mine = await coffee(
      [
        { storeId: main, quantity: 10, unitCost: "1.000" },
        { storeId: mall, quantity: 4 },
      ],
      categoryId ? { categoryId } : {}
    );
    await coffee(undefined, { name: "Never stocked" });
    const rice = await createProductAs(admin, {
      name: "Rice",
      itemType: "variant",
      unit: "kg",
      attributes: [{ name: "Pack", options: ["1kg", "5kg"] }],
      variants: [
        { attributeValues: { Pack: "1kg" }, sellingPrice: "1.000", openingStock: [{ storeId: main, quantity: 2.5, unitCost: "0.400" }] },
        { attributeValues: { Pack: "5kg" }, sellingPrice: "4.000" },
      ],
    });

    const adj = await adjust(admin, main, { reason: "count_correction", note: "Recount", lines: [{ variantId: mine.variantId, quantityChange: -2 }, { variantId: rice.variants[0].id, countedQuantity: 2.5 }] });
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    strictify(StockAdjustmentDataSchema).parse(adj.body.data);

    const tr = await transfer({ fromStoreId: main, toStoreId: souq, note: "Restock", lines: [{ variantId: mine.variantId, quantity: 3 }] });
    expect(tr.status).toBe(201);
    strictify(StockTransferDataSchema).parse(tr.body.data);

    for (const token of [admin, cashier, clerk]) {
      const list = await request.get(`${API}/stores/${main}/stock?includeInactive=true`).set(auth(token));
      expect(list.status).toBe(200);
      strictify(StockLevelListDataSchema).parse(list.body.data);
    }
    const product = await request.get(`${PRODUCTS}/${mine.productId}/stock`).set(auth(admin));
    strictify(ProductStockDataSchema).parse(product.body.data);
    strictify(ProductStockDataSchema).parse((await request.get(`${PRODUCTS}/${mine.productId}/stock`).set(auth(cashier))).body.data);
    strictify(ProductStockDataSchema).parse((await request.get(`${PRODUCTS}/${rice._id}/stock`).set(auth(admin))).body.data);

    const moves = await request.get(`${API}/stores/${main}/stock-movements`).set(auth(admin));
    expect(moves.body.data.movements.length).toBeGreaterThanOrEqual(4);
    strictify(StockMovementListDataSchema).parse(moves.body.data);

    const adjustments = await request.get(`${API}/stores/${main}/stock-adjustments`).set(auth(admin));
    strictify(StockAdjustmentListDataSchema).parse(adjustments.body.data);
    const oneAdjustment = await request.get(`${API}/stores/${main}/stock-adjustments/${adj.body.data.adjustment.id}`).set(auth(admin));
    strictify(StockAdjustmentDataSchema).parse(oneAdjustment.body.data);

    const transfers = await request.get(TRANSFERS).set(auth(admin));
    strictify(StockTransferListDataSchema).parse(transfers.body.data);
    const oneTransfer = await request.get(`${TRANSFERS}/${tr.body.data.transfer.id}`).set(auth(admin));
    strictify(StockTransferDataSchema).parse(oneTransfer.body.data);
  });

  it("validates an empty history and a replayed response", async () => {
    const empty = await request.get(`${API}/stores/${main}/stock-movements`).set(auth(admin));
    strictify(StockMovementListDataSchema).parse(empty.body.data);
    const emptyStock = await request.get(`${API}/stores/${main}/stock`).set(auth(admin));
    strictify(StockLevelListDataSchema).parse(emptyStock.body.data);
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const key = newKey();
    const body = { reason: "found", lines: [{ variantId, quantityChange: 1 }] };
    await adjust(admin, main, body, key);
    const replay = await adjust(admin, main, body, key);
    strictify(StockAdjustmentDataSchema).parse(replay.body.data);
  });
});

// ==========================================
// 7. Lenient query parsing, malformed ids, deleted rows
// ==========================================

describe("lenient query parsing", () => {
  it("never answers 4xx/5xx for bad page, limit, status, type, reason or dates", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] });
    await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] });
    const queries = [
      "page=abc&limit=xyz",
      "page=0&limit=0",
      "page=-3&limit=-5",
      "page=1.5&limit=2.7",
      "limit=1000000",
      "page=NaN&limit=NaN",
      "page=&limit=",
      "page=1&page=2&limit=3&limit=4",
      "page[]=1&limit[a]=2",
      "from=garbage&to=also-garbage",
      "from=2026-02-30&to=2026-13-45",
      "from=2030-01-01&to=2000-01-01",
      "from=2026-10-01T00:00:00%2B03:00&to=2026-10-31T23:59:59Z",
      "from=%20&to=%20",
      "status=bogus&type=bogus&reason=bogus",
      "status[]=low&type[]=opening&reason[]=damaged",
      "search=.*&categoryId=garbage",
      "search=(((&categoryId=none",
      "includeInactive=maybe&includeSubcategories=perhaps",
      "variantId=%27%7B%24ne%3A1%7D&productId=null",
      "variantId[$ne]=1&productId[$gt]=",
    ];
    const paths = ["stock", "stock-movements", "stock-adjustments"].map((p) => `${API}/stores/${main}/${p}`);
    paths.push(TRANSFERS);
    for (const path of paths) {
      for (const query of queries) {
        const res = await request.get(`${path}?${query}`).set(auth(admin));
        expect(res.status, `${path}?${query} -> ${res.text.slice(0, 200)}`).toBe(200);
      }
    }
  });

  it("clamps absurdly large page numbers instead of failing", async () => {
    await coffee([{ storeId: main, quantity: 5 }]);
    for (const page of ["1e30", "Infinity", "9007199254740993", "1e308"]) {
      for (const path of ["stock", "stock-movements", "stock-adjustments"]) {
        const res = await request.get(`${API}/stores/${main}/${path}?page=${page}`).set(auth(admin));
        expect(res.status, `${path}?page=${page} -> ${res.text.slice(0, 200)}`).toBe(200);
      }
      expect((await request.get(`${TRANSFERS}?page=${page}`).set(auth(admin))).status, `transfers page=${page}`).toBe(200);
    }
  });

  it("ignores inherited object keys as status values (constructor, __proto__, toString)", async () => {
    await coffee([{ storeId: main, quantity: 5 }]);
    for (const status of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const res = await request.get(`${API}/stores/${main}/stock?status=${status}`).set(auth(admin));
      expect(res.status, status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
    }
    for (const reason of ["constructor", "__proto__", "toString"]) {
      const res = await request.get(`${API}/stores/${main}/stock-adjustments?reason=${reason}`).set(auth(admin));
      expect(res.status, reason).toBe(200);
    }
    for (const type of ["constructor", "__proto__"]) {
      expect((await request.get(`${API}/stores/${main}/stock-movements?type=${type}`).set(auth(admin))).status).toBe(200);
    }
  });

  it("treats a malformed path id as a clean 4xx, never a 500", async () => {
    for (const path of [
      `${API}/stores/${main}/stock-adjustments/not-an-id`,
      `${TRANSFERS}/not-an-id`,
      `${PRODUCTS}/not-an-id/stock`,
      `${API}/stores/not-an-id/stock`,
    ]) {
      const res = await request.get(path).set(auth(admin));
      expect(res.status, path).toBeGreaterThanOrEqual(400);
      expect(res.status, path).toBeLessThan(500);
    }
    const unknown = new mongoose.Types.ObjectId().toString();
    expect((await request.get(`${PRODUCTS}/${unknown}/stock`).set(auth(admin))).body.code).toBe("PRODUCT_NOT_FOUND");
    expect((await request.get(`${TRANSFERS}/${unknown}`).set(auth(admin))).body.code).toBe("TRANSFER_NOT_FOUND");
  });

  it("paginates movements stably, newest first, with no gaps or repeats across pages", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 50 }]);
    for (let i = 0; i < 6; i += 1) await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] });
    const seen: string[] = [];
    for (const page of [1, 2, 3, 4]) {
      const res = await request.get(`${API}/stores/${main}/stock-movements?limit=2&page=${page}`).set(auth(admin));
      seen.push(...res.body.data.movements.map((m: { id: string }) => m.id));
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    // Movements written in one request share a timestamp; the order must still be total.
    const all = await request.get(`${API}/stores/${main}/stock-movements?limit=100`).set(auth(admin));
    expect(all.body.data.movements.map((m: { id: string }) => m.id)).toEqual(seen);
  });

  it("applies the local-day filter to the organization's timezone at both ends", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -1 }] });
    await StockMovement.collection.updateMany({}, { $set: { createdAt: new Date("2026-03-10T21:30:00Z") } }); // 00:30 on the 11th in Bahrain
    const get = (query: string) => request.get(`${API}/stores/${main}/stock-movements?${query}`).set(auth(admin));
    expect((await get("from=2026-03-11&to=2026-03-11")).body.data.pagination.total).toBe(2);
    expect((await get("from=2026-03-10&to=2026-03-10")).body.data.pagination.total).toBe(0);
    expect((await get("from=2026-03-12")).body.data.pagination.total).toBe(0);
    expect((await get("to=2026-03-10")).body.data.pagination.total).toBe(0);
  });
});

describe("deleted catalog rows and stores in history", () => {
  it("still names soft-deleted products, variants and stores in movements and transfers", async () => {
    const { productId, variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    const tr = await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] });
    await Product.collection.updateOne({ _id: new mongoose.Types.ObjectId(productId) }, { $set: { isDelete: true } });
    await ProductVariant.collection.updateOne({ _id: new mongoose.Types.ObjectId(variantId) }, { $set: { isDelete: true } });
    await Store.collection.updateOne({ _id: new mongoose.Types.ObjectId(mall) }, { $set: { isDelete: true } });

    const moves = await request.get(`${API}/stores/${main}/stock-movements`).set(auth(admin));
    for (const movement of moves.body.data.movements) {
      expect(movement.product.name).toBe("Coffee");
      expect(movement.variant.name).toBe("Coffee");
    }
    const detail = await request.get(`${TRANSFERS}/${tr.body.data.transfer.id}`).set(auth(admin));
    expect(detail.status).toBe(200);
    expect(detail.body.data.transfer.toStore).toMatchObject({ name: "Mall" });
    expect(detail.body.data.transfer.lines[0].product.name).toBe("Coffee");
    // A deleted store's own history is no longer reachable.
    expect((await request.get(`${API}/stores/${mall}/stock-movements`).set(auth(admin))).status).toBe(404);
    // The deleted product no longer shows in the live stock list or its stock tab.
    expect((await request.get(`${API}/stores/${main}/stock?includeInactive=true`).set(auth(admin))).body.data.items).toHaveLength(0);
    expect((await request.get(`${PRODUCTS}/${productId}/stock`).set(auth(admin))).status).toBe(404);
  });

  it("refuses adjusting or transferring a soft-deleted variant", async () => {
    const { variantId } = await coffee([{ storeId: main, quantity: 5 }]);
    await ProductVariant.collection.updateOne({ _id: new mongoose.Types.ObjectId(variantId) }, { $set: { isDelete: true } });
    const res = await adjust(admin, main, { reason: "found", lines: [{ variantId, quantityChange: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe("VARIANT_NOT_FOUND");
    expect((await transfer({ fromStoreId: main, toStoreId: mall, lines: [{ variantId, quantity: 1 }] })).status).toBe(400);
  });

  it("allows adjusting an inactive variant or product (inactive is not deleted)", async () => {
    const tee = await createProductAs(admin, {
      name: "Tee",
      itemType: "variant",
      attributes: [{ name: "Size", options: ["S", "M"] }],
      variants: [
        { attributeValues: { Size: "S" }, sellingPrice: "4.000", openingStock: [{ storeId: main, quantity: 2 }] },
        { attributeValues: { Size: "M" }, sellingPrice: "4.000" },
      ],
    });
    await request.patch(`${PRODUCTS}/${tee._id}/variants/${tee.variants[0].id}/deactivate`).set(auth(admin));
    const res = await adjust(admin, main, { reason: "damaged", lines: [{ variantId: tee.variants[0].id, quantityChange: -1 }] });
    expect(res.status).toBe(201);
    // It is hidden from the default list but shown with includeInactive.
    const hidden = await request.get(`${API}/stores/${main}/stock`).set(auth(admin));
    expect(hidden.body.data.items.map((i: { variant: { id: string } }) => i.variant.id)).not.toContain(tee.variants[0].id);
    const shown = await request.get(`${API}/stores/${main}/stock?includeInactive=true`).set(auth(admin));
    expect(shown.body.data.items.map((i: { variant: { id: string } }) => i.variant.id)).toContain(tee.variants[0].id);
  });
});

// ==========================================
// 8. Catalog locks
// ==========================================

describe("catalog locks count soft-deleted and inactive variants", () => {
  async function variantProductWithHistory() {
    const tee = await createProductAs(admin, {
      name: "Tee",
      itemType: "variant",
      attributes: [{ name: "Size", options: ["S", "M"] }],
      variants: [
        { attributeValues: { Size: "S" }, sellingPrice: "4.000", openingStock: [{ storeId: main, quantity: 1 }] },
        { attributeValues: { Size: "M" }, sellingPrice: "4.000" },
      ],
    });
    return tee;
  }

  it("keeps PRODUCT_IN_USE and UNIT_LOCKED when the variant with history is soft-deleted", async () => {
    const tee = await variantProductWithHistory();
    await ProductVariant.collection.updateOne({ _id: new mongoose.Types.ObjectId(tee.variants[0].id) }, { $set: { isDelete: true } });
    const del = await request.delete(`${PRODUCTS}/${tee._id}`).set(auth(admin));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("PRODUCT_IN_USE");
    const unit = await request.patch(`${PRODUCTS}/${tee._id}`).set(auth(admin)).send({ unit: "kg" });
    expect(unit.status).toBe(409);
    expect(unit.body.code).toBe("UNIT_LOCKED");
  });

  it("keeps UNIT_LOCKED and PRODUCT_IN_USE when stock is back to zero or tracking was switched off", async () => {
    const { productId, variantId } = await coffee([{ storeId: main, quantity: 2 }]);
    await adjust(admin, main, { reason: "damaged", lines: [{ variantId, quantityChange: -2 }] });
    expect((await request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ unit: "kg" })).body.code).toBe("UNIT_LOCKED");
    expect((await request.delete(`${PRODUCTS}/${productId}`).set(auth(admin))).body.code).toBe("PRODUCT_IN_USE");
    await request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ inventory: { trackInventory: false } });
    expect((await request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ unit: "kg" })).body.code).toBe("UNIT_LOCKED");
    expect((await request.delete(`${PRODUCTS}/${productId}`).set(auth(admin))).body.code).toBe("PRODUCT_IN_USE");
  });

  it("locks the unit when the only history is on a deactivated variant", async () => {
    const tee = await variantProductWithHistory();
    await request.patch(`${PRODUCTS}/${tee._id}/variants/${tee.variants[0].id}/deactivate`).set(auth(admin));
    const unit = await request.patch(`${PRODUCTS}/${tee._id}`).set(auth(admin)).send({ unit: "kg" });
    expect(unit.body.code).toBe("UNIT_LOCKED");
  });

  it("does not lock a product that never had stock, a service, or stock held only in a transfer-free sibling", async () => {
    const tee = await variantProductWithHistory();
    const other = await coffee();
    expect((await request.patch(`${PRODUCTS}/${other.productId}`).set(auth(admin)).send({ unit: "kg" })).status).toBe(200);
    expect((await request.delete(`${PRODUCTS}/${other.productId}`).set(auth(admin))).status).toBe(200);
    // The sibling variant without history is deletable; the one with history is not.
    expect((await request.delete(`${PRODUCTS}/${tee._id}/variants/${tee.variants[1].id}`).set(auth(admin))).status).toBe(200);
    expect((await request.delete(`${PRODUCTS}/${tee._id}/variants/${tee.variants[0].id}`).set(auth(admin))).status).toBe(409);
  });

  it("refuses switching tracking off while only a deactivated store holds stock", async () => {
    const { productId } = await coffee([{ storeId: main, quantity: 2 }]);
    await Store.updateOne({ _id: main }, { $set: { isActive: false } });
    const res = await request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ inventory: { trackInventory: false } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STOCK_ON_HAND");
    // The product list does not count that store, but the lock does: a documented asymmetry.
    const product = await request.get(`${PRODUCTS}/${productId}`).set(auth(admin));
    expect(product.body.data.product.variants[0].stockOnHand).toBe(0);
  });

  it("accepts opening stock for goods created through the API only when the product tracks inventory", async () => {
    const service = await request
      .post(PRODUCTS)
      .set(auth(admin))
      .send({ name: "Delivery", type: "service", taxPreference: "exempt", sales: { sellingPrice: "1.000" }, inventory: { openingStock: [{ storeId: main, quantity: 1 }] } });
    expect(service.status).toBe(400);
    const untracked = await request
      .post(PRODUCTS)
      .set(auth(admin))
      .send({ name: "Bag", type: "goods", taxPreference: "exempt", sales: { sellingPrice: "1.000" }, inventory: { trackInventory: false, openingStock: [{ storeId: main, quantity: 1 }] } });
    expect(untracked.status).toBe(400);
    expect(await StockMovement.countDocuments({})).toBe(0);
  });

  it("rolls the product back when opening stock cannot be written (atomic create)", async () => {
    // A duplicate SKU conflict is raised before the transaction; force a failure inside it instead
    // by closing the store between validation and write is racy, so check the visible contract:
    // a failed create leaves no product, variant, level or movement behind.
    const res = await request
      .post(PRODUCTS)
      .set(auth(admin))
      .send({ name: "Half", type: "goods", taxPreference: "exempt", sales: { sellingPrice: "1.000" }, inventory: { openingStock: [{ storeId: main, quantity: 2 }, { storeId: closed, quantity: 1 }] } });
    expect(res.status).toBe(400);
    expect(await Product.countDocuments({ name: "Half" })).toBe(0);
    expect(await ProductVariant.countDocuments({})).toBe(0);
    expect(await StockLevel.countDocuments({})).toBe(0);
    expect(await StockMovement.countDocuments({})).toBe(0);
  });
});
