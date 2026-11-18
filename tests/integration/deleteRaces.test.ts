/**
 * Purpose: catalog deletes racing writes that add a reference (catalogClaims.service). Each case
 * fires the delete and the write together several times and checks the outcome in the database:
 * never both succeed, and nothing is left pointing at a deleted category, tax rate or variant.
 * The cases: category and tax rate vs product create/update; product and variant delete vs a
 * purchase order, a receipt without a PO (untracked goods), a first stock movement and a service
 * bill line.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Category } from "../../src/models/category.model";
import { TaxRate } from "../../src/models/taxRate.model";
import { Product } from "../../src/models/product.model";
import { ProductVariant } from "../../src/models/productVariant.model";
import { PurchaseOrder } from "../../src/models/purchaseOrder.model";
import { GoodsReceipt } from "../../src/models/goodsReceipt.model";
import { StockMovement } from "../../src/models/stockMovement.model";
import { Bill } from "../../src/models/bill.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { singleExample, serviceExample } from "../../src/docs/product.openapi";

const PRODUCTS = "/api/v1/products";
const CATEGORIES = "/api/v1/categories";
const TAX_RATES = "/api/v1/tax-rates";
const VENDORS = "/api/v1/vendors";
const BILLS = "/api/v1/bills";
const ROUNDS = 6;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let keySeq = 0;
const newKey = () => `race-key-${Date.now()}-${(keySeq += 1)}`;
const anyState = { $in: [true, false] };

let org: { _id: unknown };
let storeId: unknown;
let admin: string;
let vendorId: string;

beforeEach(async () => {
  org = await Organization.create({
    name: "racers",
    slug: "racers",
    contactEmail: "owner@racers.test",
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    taxRegistrationNumber: "220000111100003",
    settings: { currency: "BHD", timezone: "Asia/Bahrain" },
  });
  await seedDefaultRolesForOrganization(org._id as never);
  await seedDefaultTaxRates(org._id as never, "BHD");
  const orgAdmin = await Role.findOne({ organizationId: org._id, slug: "org_admin" });
  const store = await Store.create({
    organizationId: org._id,
    name: "Main",
    code: "RACE-1",
    address: { line1: "Road 1", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
    countryCode: "BH",
    timezone: "Asia/Bahrain",
  });
  storeId = store._id;
  const user = await User.create({
    organizationId: org._id,
    email: "admin@racers.test",
    passwordHash: "SecurePassword123",
    firstName: "Test",
    lastName: "Admin",
    isActive: true,
    orgRoleId: orgAdmin!._id,
  });
  admin = generateAccessToken({ userId: user._id.toString(), organizationId: String(org._id), isSuperAdmin: false });
  const vendor = await request.post(VENDORS).set(auth(admin)).send({ name: "Gulf Roasters", taxRegistrationNumber: "220000987600003" });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  vendorId = vendor.body.data.vendor.id;
});

const goods = (name: string, overrides: Record<string, unknown> = {}) => ({
  ...singleExample,
  categoryId: undefined,
  taxRateId: undefined,
  barcodes: undefined,
  name,
  sku: `${name.toUpperCase()}-${keySeq += 1}`,
  ...overrides,
});

async function createProduct(body: Record<string, unknown>) {
  const res = await request.post(PRODUCTS).set(auth(admin)).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const product = res.body.data.product;
  return { productId: product.id as string, variantId: product.variants[0].id as string, variants: product.variants as { id: string }[] };
}

async function createCategory(name: string): Promise<string> {
  const res = await request.post(CATEGORIES).set(auth(admin)).send({ name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.category.id;
}

async function createRate(name: string): Promise<string> {
  const res = await request.post(TAX_RATES).set(auth(admin)).send({ name, components: [{ name: "VAT", rate: 5 }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.taxRate.id;
}

const ok = (status: number) => status >= 200 && status < 300;
const deleteProduct = (productId: string) => request.delete(`${PRODUCTS}/${productId}`).set(auth(admin));

/** The product is deleted, or nothing was saved against it; never both. */
async function expectOneSide(deleted: { status: number }, write: { status: number; body: unknown }, productId: string) {
  expect(ok(deleted.status) && ok(write.status), `both succeeded: ${JSON.stringify(write.body)}`).toBe(false);
  if (!ok(deleted.status)) expect(deleted.status).toBe(409);
  const product = await Product.findOne({ _id: productId, isDelete: anyState });
  expect(product!.isDelete).toBe(ok(deleted.status));
}

describe("category and tax rate deletes racing product saves", () => {
  it("a product created into a category being deleted: the category stays, or the product is refused", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const categoryId = await createCategory(`Beans ${round}`);
      const [deleted, created] = await Promise.all([
        request.delete(`${CATEGORIES}/${categoryId}`).set(auth(admin)),
        request.post(PRODUCTS).set(auth(admin)).send(goods(`Coffee${round}`, { categoryId })),
      ]);
      expect(ok(deleted.status) && ok(created.status), "both succeeded").toBe(false);
      if (!ok(created.status)) expect([created.status, created.body.code]).toEqual([400, "CATEGORY_NOT_FOUND"]);
      if (!ok(deleted.status)) expect([deleted.status, deleted.body.code]).toEqual([409, "CATEGORY_IN_USE"]);
      const orphans = await Product.countDocuments({ organizationId: org._id, categoryId });
      const category = await Category.findOne({ _id: categoryId, isDelete: anyState });
      expect(category!.isDelete ? orphans : 0).toBe(0);
    }
  });

  it("a product moved into a category being deleted: same outcome", async () => {
    const { productId } = await createProduct(goods("Tea"));
    for (let round = 0; round < ROUNDS; round += 1) {
      const categoryId = await createCategory(`Leaves ${round}`);
      const [deleted, moved] = await Promise.all([
        request.delete(`${CATEGORIES}/${categoryId}`).set(auth(admin)),
        request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ categoryId }),
      ]);
      expect(ok(deleted.status) && ok(moved.status), "both succeeded").toBe(false);
      const product = await Product.findById(productId);
      const category = await Category.findOne({ _id: categoryId, isDelete: anyState });
      expect(category!.isDelete && product!.categoryId?.toString() === categoryId).toBe(false);
    }
  });

  it("a product created on a tax rate being deleted: the rate stays, or the product is refused", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const taxRateId = await createRate(`Special ${round}`);
      const [deleted, created] = await Promise.all([
        request.delete(`${TAX_RATES}/${taxRateId}`).set(auth(admin)),
        request.post(PRODUCTS).set(auth(admin)).send(goods(`Juice${round}`, { taxPreference: "standard", taxRateId })),
      ]);
      expect(ok(deleted.status) && ok(created.status), "both succeeded").toBe(false);
      if (!ok(created.status)) expect([created.status, created.body.code]).toEqual([400, "TAX_RATE_NOT_FOUND"]);
      if (!ok(deleted.status)) expect([deleted.status, deleted.body.code]).toEqual([409, "TAX_RATE_IN_USE"]);
      const rate = await TaxRate.findOne({ _id: taxRateId, isDelete: anyState });
      const users = await Product.countDocuments({ organizationId: org._id, taxRateId });
      expect(rate!.isDelete ? users : 0).toBe(0);
    }
  });

  it("a product switched to a tax rate being deleted: same outcome", async () => {
    const { productId } = await createProduct(goods("Water", { taxPreference: "standard" }));
    for (let round = 0; round < ROUNDS; round += 1) {
      const taxRateId = await createRate(`Other ${round}`);
      const [deleted, moved] = await Promise.all([
        request.delete(`${TAX_RATES}/${taxRateId}`).set(auth(admin)),
        request.patch(`${PRODUCTS}/${productId}`).set(auth(admin)).send({ taxRateId }),
      ]);
      expect(ok(deleted.status) && ok(moved.status), "both succeeded").toBe(false);
      const product = await Product.findById(productId);
      const rate = await TaxRate.findOne({ _id: taxRateId, isDelete: anyState });
      expect(rate!.isDelete && product!.taxRateId?.toString() === taxRateId).toBe(false);
    }
  });

  it("the response never shows the internal claim counters", async () => {
    const taxRateId = await createRate("Shown");
    const { productId } = await createProduct(goods("Milk", { taxPreference: "standard", taxRateId }));
    const rate = await request.get(`${TAX_RATES}/${taxRateId}`).set(auth(admin));
    const product = await request.get(`${PRODUCTS}/${productId}`).set(auth(admin));
    expect(JSON.stringify(rate.body)).not.toContain("claimVersion");
    expect(JSON.stringify(product.body)).not.toContain("claimVersion");
    expect((await TaxRate.findById(taxRateId))!.claimVersion).toBeGreaterThan(0);
  });
});

describe("product and variant deletes racing purchase documents and stock", () => {
  it("a purchase order created with a product being deleted", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { productId, variantId } = await createProduct(goods(`Sugar${round}`));
      const [deleted, po] = await Promise.all([
        deleteProduct(productId),
        request
          .post(`/api/v1/stores/${storeId}/purchase-orders`)
          .set(auth(admin))
          .set("Idempotency-Key", newKey())
          .send({ vendorId, lines: [{ variantId, quantity: 5, unitCost: "1.000" }] }),
      ]);
      await expectOneSide(deleted, po, productId);
      if (!ok(po.status)) expect([po.status, po.body.code]).toEqual([400, "VARIANT_NOT_FOUND"]);
      if (ok(deleted.status)) expect(await PurchaseOrder.countDocuments({ organizationId: org._id, "lines.variantId": variantId })).toBe(0);
    }
  });

  it("a receipt without a PO of untracked goods (no stock trail) and a product being deleted", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { productId, variantId } = await createProduct(goods(`Cups${round}`, { inventory: { trackInventory: false } }));
      const [deleted, grn] = await Promise.all([
        deleteProduct(productId),
        request
          .post(`/api/v1/stores/${storeId}/goods-receipts`)
          .set(auth(admin))
          .set("Idempotency-Key", newKey())
          .send({ vendorId, lines: [{ variantId, quantity: 10, unitCost: "0.100" }] }),
      ]);
      await expectOneSide(deleted, grn, productId);
      if (ok(deleted.status)) expect(await GoodsReceipt.countDocuments({ organizationId: org._id, "lines.variantId": variantId })).toBe(0);
    }
  });

  it("a first stock movement and a product being deleted", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { productId, variantId } = await createProduct(goods(`Rice${round}`));
      const [deleted, adjusted] = await Promise.all([
        deleteProduct(productId),
        request
          .post(`/api/v1/stores/${storeId}/stock-adjustments`)
          .set(auth(admin))
          .set("Idempotency-Key", newKey())
          .send({ reason: "found", lines: [{ variantId, quantityChange: 10, unitCost: "1.000" }] }),
      ]);
      await expectOneSide(deleted, adjusted, productId);
      if (ok(deleted.status)) expect(await StockMovement.countDocuments({ organizationId: org._id, variantId })).toBe(0);
    }
  });

  it("a bill's service line and a service being deleted", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { productId, variantId } = await createProduct({ ...serviceExample, name: `Delivery ${round}` });
      const [deleted, bill] = await Promise.all([
        deleteProduct(productId),
        request
          .post(BILLS)
          .set(auth(admin))
          .set("Idempotency-Key", newKey())
          .send({ vendorId, vendorInvoiceNumber: `INV-${round}`, lines: [{ variantId, quantity: 1, unitCost: "1.000" }] }),
      ]);
      await expectOneSide(deleted, bill, productId);
      if (ok(deleted.status)) expect(await Bill.countDocuments({ organizationId: org._id, "lines.variantId": variantId })).toBe(0);
    }
  });

  it("a variant being deleted and a purchase order created with it", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { productId, variants } = await createProduct({
        name: `Tee${round}`,
        type: "goods",
        itemType: "variant",
        unit: "pcs",
        taxPreference: "standard",
        attributes: [{ name: "Size", options: ["S", "M"] }],
        variants: [
          { attributeValues: { Size: "S" }, sellingPrice: "4.000", costPrice: "2.000" },
          { attributeValues: { Size: "M" }, sellingPrice: "4.000", costPrice: "2.000" },
        ],
      });
      const variantId = variants[1].id;
      const [deleted, po] = await Promise.all([
        request.delete(`${PRODUCTS}/${productId}/variants/${variantId}`).set(auth(admin)),
        request
          .post(`/api/v1/stores/${storeId}/purchase-orders`)
          .set(auth(admin))
          .set("Idempotency-Key", newKey())
          .send({ vendorId, lines: [{ variantId, quantity: 5, unitCost: "1.000" }] }),
      ]);
      expect(ok(deleted.status) && ok(po.status), "both succeeded").toBe(false);
      const variant = await ProductVariant.findOne({ _id: variantId, isDelete: anyState });
      const onPos = await PurchaseOrder.countDocuments({ organizationId: org._id, "lines.variantId": variantId });
      expect(variant!.isDelete ? onPos : 0).toBe(0);
    }
  });
});
