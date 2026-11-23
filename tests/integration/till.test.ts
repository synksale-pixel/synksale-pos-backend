/**
 * Purpose: Phase 4a-2 till catalog reads over HTTP: the scan lookup (barcode with or without
 * hyphens, SKU, PRODUCT_NOT_FOUND, PRODUCT_INACTIVE with meta), the item list (one row per active
 * variant of active products, search, category with subcategories, paging), the TillItem shape
 * (tax rate, pricesIncludeTax, stock at THIS store, never a cost) and access rules.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { serviceExample, singleExample, variantExample } from "../../src/docs/product.openapi";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const storeBody = (code: string) => ({
  name: code,
  code,
  address: { line1: "Road 2", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "324" },
  countryCode: "BH",
  timezone: "Asia/Bahrain",
});

async function tokenFor(
  orgId: unknown,
  email: string,
  opts: { orgRoleId?: unknown; storeAccess?: { storeId: unknown; roleId: unknown }[] }
) {
  const user = await User.create({
    organizationId: orgId,
    email,
    passwordHash: "SecurePassword123",
    firstName: "T",
    lastName: "U",
    isActive: true,
    orgRoleId: opts.orgRoleId ?? null,
    storeAccess: opts.storeAccess ?? [],
  });
  return generateAccessToken({ userId: user._id.toString(), organizationId: String(orgId), isSuperAdmin: false });
}

async function post(token: string, path: string, body: Record<string, unknown>) {
  const res = await request.post(path).set(auth(token)).send(body);
  expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.data;
}

let org: InstanceType<typeof Organization>;
let role: (slug: string) => InstanceType<typeof Role>;
let admin: string;
let storeId: string;
let otherStoreId: string;
let drinksId: string;
let coffeeCatId: string;
let coffee: { _id: string; variants: { id: string }[] };
let tshirt: { _id: string; variants: { id: string; sku: string }[] };

beforeEach(async () => {
  org = await Organization.create({
    name: "alnoor",
    slug: "alnoor",
    contactEmail: "owner@alnoor.test",
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency: "BHD", timezone: "Asia/Bahrain" },
  });
  await seedDefaultRolesForOrganization(org._id);
  await seedDefaultTaxRates(org._id, "BHD");
  const roles = await Role.find({ organizationId: org._id });
  role = (s: string) => roles.find((r) => r.slug === s)!;
  admin = await tokenFor(org._id, "admin@alnoor.test", { orgRoleId: role("org_admin")._id });

  storeId = (await post(admin, "/api/v1/stores", storeBody("SEEF-1"))).store._id;
  otherStoreId = (await post(admin, "/api/v1/stores", storeBody("RIFFA-1"))).store._id;
  drinksId = (await post(admin, "/api/v1/categories", { name: "Drinks" })).category._id;
  coffeeCatId = (await post(admin, "/api/v1/categories", { name: "Coffee", parentId: drinksId })).category._id;

  coffee = (
    await post(admin, "/api/v1/products", {
      ...singleExample,
      categoryId: coffeeCatId,
      taxRateId: undefined,
      imageUrl: undefined,
      inventory: {
        trackInventory: true,
        returnable: false,
        openingStock: [
          { storeId, quantity: 24, unitCost: "1.600" },
          { storeId: otherStoreId, quantity: 5, unitCost: "1.600" },
        ],
      },
    })
  ).product;
  tshirt = (await post(admin, "/api/v1/products", { ...variantExample, categoryId: undefined })).product;
  await post(admin, "/api/v1/products", serviceExample);
});

const lookup = (code: string, token = admin, id = storeId) =>
  request.get(`/api/v1/stores/${id}/till/lookup`).query({ code }).set(auth(token));
const items = (query: Record<string, string> = {}, token = admin, id = storeId) =>
  request.get(`/api/v1/stores/${id}/till/items`).query(query).set(auth(token));
const names = (res: { body: { data: { items: { name: string }[] } } }) => res.body.data.items.map((i) => i.name);

describe("lookup", () => {
  it("finds an item by EAN and returns the full TillItem, with stock at this store only", async () => {
    const res = await lookup("6291041500213");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.matchedOn).toBe("ean");
    expect(res.body.data.item).toEqual({
      variantId: coffee.variants[0].id,
      productId: coffee._id,
      name: "Arabic Coffee 250g",
      nameAr: null,
      sku: "COF-AR-250",
      barcodes: { upc: null, ean: "6291041500213", isbn: null },
      type: "goods",
      unit: "pcs",
      hsnOrSac: null,
      category: { id: coffeeCatId, name: "Coffee" },
      imageUrl: null,
      sellingPrice: "2.750",
      pricesIncludeTax: true,
      taxPreference: "standard",
      taxRate: { id: expect.any(String), name: "VAT 10%", rate: 10, components: [{ name: "VAT", rate: 10 }] },
      trackInventory: true,
      stockOnHand: 24,
    });

    const other = await lookup("6291041500213", admin, otherStoreId);
    expect(other.body.data.item.stockOnHand).toBe(5);
  });

  it("matches a barcode with hyphens and a SKU case-insensitively", async () => {
    expect((await lookup("629-1041-500213")).body.data.matchedOn).toBe("ean");
    const sku = await lookup("tshirt-red-m");
    expect(sku.status).toBe(200);
    expect(sku.body.data.matchedOn).toBe("sku");
    expect(sku.body.data.item.name).toBe("Crew-neck T-shirt - M / Red");
    expect(sku.body.data.item.stockOnHand).toBe(0);
  });

  it("never returns a cost", async () => {
    const res = await lookup("6291041500213");
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("cost");
    expect(JSON.stringify(res.body)).not.toContain("lastPurchase");
  });

  it("an unknown code is PRODUCT_NOT_FOUND; an empty one is 400", async () => {
    const res = await lookup("0000000000000");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PRODUCT_NOT_FOUND");
    expect((await lookup("")).status).toBe(400);
    expect((await request.get(`/api/v1/stores/${storeId}/till/lookup`).set(auth(admin))).status).toBe(400);
  });

  it("a deactivated product is PRODUCT_INACTIVE with productId, variantId and name", async () => {
    await request.patch(`/api/v1/products/${coffee._id}/deactivate`).set(auth(admin)).expect(200);
    const res = await lookup("6291041500213");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRODUCT_INACTIVE");
    expect(res.body.errors[0].meta).toEqual({ productId: coffee._id, variantId: coffee.variants[0].id, name: "Arabic Coffee 250g" });
  });

  it("a deactivated variant is PRODUCT_INACTIVE too", async () => {
    const red = tshirt.variants.find((v) => v.sku === "TSHIRT-RED-M")!;
    await request.patch(`/api/v1/products/${tshirt._id}/variants/${red.id}/deactivate`).set(auth(admin)).expect(200);
    const res = await lookup("TSHIRT-RED-M");
    expect(res.status).toBe(409);
    expect(res.body.errors[0].meta).toMatchObject({ variantId: red.id, name: "Crew-neck T-shirt - M / Red" });
  });
});

describe("items", () => {
  it("lists one row per active variant of active products, by name", async () => {
    const res = await items();
    expect(res.status).toBe(200);
    expect(names(res)).toEqual([
      "Arabic Coffee 250g",
      "Crew-neck T-shirt - M / Red",
      "Crew-neck T-shirt - L / Red",
      "Gift wrapping",
    ]);
    expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 50, total: 4 });

    const gift = res.body.data.items[3];
    expect(gift).toMatchObject({ type: "service", trackInventory: false, stockOnHand: null });
  });

  it("leaves out deactivated products and variants", async () => {
    await request.patch(`/api/v1/products/${coffee._id}/deactivate`).set(auth(admin)).expect(200);
    const red = tshirt.variants.find((v) => v.sku === "TSHIRT-RED-M")!;
    await request.patch(`/api/v1/products/${tshirt._id}/variants/${red.id}/deactivate`).set(auth(admin)).expect(200);
    expect(names(await items())).toEqual(["Crew-neck T-shirt - L / Red", "Gift wrapping"]);
  });

  it("searches the product name, this variant's SKU or a barcode by prefix", async () => {
    expect(names(await items({ search: "crew" }))).toEqual(["Crew-neck T-shirt - M / Red", "Crew-neck T-shirt - L / Red"]);
    expect(names(await items({ search: "tshirt-red-l" }))).toEqual(["Crew-neck T-shirt - L / Red"]);
    expect(names(await items({ search: "629104150022" }))).toEqual(["Crew-neck T-shirt - L / Red"]);
    expect(names(await items({ search: "neck" }))).toEqual([]);
    expect((await items({ search: "(.*" })).status).toBe(200);
  });

  it("filters by category including subcategories; a malformed id matches nothing", async () => {
    expect(names(await items({ categoryId: drinksId }))).toEqual(["Arabic Coffee 250g"]);
    expect(names(await items({ categoryId: coffeeCatId }))).toEqual(["Arabic Coffee 250g"]);
    expect(names(await items({ categoryId: "nope" }))).toEqual([]);
  });

  it("paginates", async () => {
    const res = await items({ page: "2", limit: "3" });
    expect(names(res)).toEqual(["Gift wrapping"]);
    expect(res.body.data.pagination).toMatchObject({ page: 2, limit: 3, total: 4, totalPages: 2 });
  });

  it("follows pricesIncludeTax and shows no tax rate for non-standard items", async () => {
    await Organization.updateOne({ _id: org._id }, { $set: { "settings.sales.pricesIncludeTax": false } });
    await post(admin, "/api/v1/products", { ...serviceExample, name: "Zero rated", taxPreference: "zero_rated" });
    const res = await items({ search: "zero" });
    expect(res.body.data.items[0]).toMatchObject({ pricesIncludeTax: false, taxPreference: "zero_rated", taxRate: null });
  });

  it("never returns a cost", async () => {
    const res = await items();
    for (const item of res.body.data.items) {
      expect(Object.keys(item).filter((k) => /cost|purchase/i.test(k))).toEqual([]);
    }
  });
});

describe("access", () => {
  it("a cashier of the store can use the till; not at another store", async () => {
    const cashier = await tokenFor(org._id, "cashier@alnoor.test", { storeAccess: [{ storeId, roleId: role("cashier")._id }] });
    expect((await lookup("6291041500213", cashier)).status).toBe(200);
    expect((await items({}, cashier)).status).toBe(200);
    expect((await items({}, cashier, otherStoreId)).status).toBe(403);
  });

  it("needs sale:create", async () => {
    const clerk = await tokenFor(org._id, "clerk@alnoor.test", { storeAccess: [{ storeId, roleId: role("inventory_clerk")._id }] });
    expect((await items({}, clerk)).status).toBe(403);
    expect((await lookup("6291041500213", clerk)).status).toBe(403);
  });

  it("a deactivated store cannot use the till", async () => {
    await request.patch(`/api/v1/stores/${storeId}/deactivate`).set(auth(admin)).expect(200);
    expect((await items()).status).toBe(403);
  });

  it("another organization's store is not found; no token is 401", async () => {
    const other = await Organization.create({
      name: "other",
      slug: "other",
      contactEmail: "owner@other.test",
      contactPhone: "+973 1234 5678",
      approvalStatus: "approved",
      isActive: true,
      settings: { currency: "BHD", timezone: "Asia/Bahrain" },
    });
    await seedDefaultRolesForOrganization(other._id);
    const otherAdminRole = await Role.findOne({ organizationId: other._id, slug: "org_admin" });
    const otherAdmin = await tokenFor(other._id, "admin@other.test", { orgRoleId: otherAdminRole!._id });
    expect((await items({}, otherAdmin)).status).toBe(404);
    expect((await request.get(`/api/v1/stores/${storeId}/till/items`)).status).toBe(401);
  });
});
