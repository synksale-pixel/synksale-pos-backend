/**
 * Purpose: Phase 3a vendors over HTTP: create defaults (country, VAT treatment), uniqueness,
 * updates and their VAT rules, search and filters, permissions for each role, tenant isolation,
 * the preferred vendor on products (selection rules, productCount, delete clearing), and the
 * one-off migration of the old free-text vendor names.
 */

import { beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Product } from "../../src/models/product.model";
import { Vendor } from "../../src/models/vendor.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { mergedDescription, migratePreferredVendorNames } from "../../src/services/preferredVendorNameMigration.service";
import { singleExample } from "../../src/docs/product.openapi";
import { vendorExample } from "../../src/docs/vendor.openapi";

const VENDORS = "/api/v1/vendors";
const PRODUCTS = "/api/v1/products";
const ROLES = "/api/v1/roles";
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function setup(slug: string, currency = "BHD") {
  const org = await Organization.create({
    name: slug,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency, timezone: "Asia/Bahrain" },
  });
  await seedDefaultRolesForOrganization(org._id);
  await seedDefaultTaxRates(org._id, currency);
  const roles = await Role.find({ organizationId: org._id });
  const role = (s: string) => roles.find((r) => r.slug === s)!;
  const store = await Store.create({
    organizationId: org._id,
    name: "Main",
    code: `${slug.toUpperCase()}-1`,
    address: { line1: "Road 1", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
    countryCode: currency === "AED" ? "AE" : "BH",
    timezone: "Asia/Bahrain",
  });
  return { org, role, store };
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
    firstName: "T",
    lastName: "U",
    isActive: true,
    orgRoleId: opts.orgRoleId ?? null,
    storeAccess: opts.storeAccess ?? [],
  });
  return generateAccessToken({ userId: user._id.toString(), organizationId: String(orgId), isSuperAdmin: false });
}

let ctx: Awaited<ReturnType<typeof setup>>;
let admin: string;

beforeEach(async () => {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
});

const createVendor = (body: Record<string, unknown>, token = admin) => request.post(VENDORS).set(auth(token)).send(body);

const product = (purchase: Record<string, unknown> = {}) => ({
  ...singleExample,
  categoryId: undefined,
  taxRateId: undefined,
  purchase: { costPrice: "1.600", ...purchase },
});

describe("create", () => {
  it("creates the documented vendor and returns the full shape", async () => {
    const res = await createVendor(vendorExample);
    expect(res.status).toBe(201);
    const vendor = res.body.data.vendor;
    expect(vendor).toMatchObject({
      name: "Gulf Roasters W.L.L.",
      taxRegistrationNumber: "220000987600003",
      countryCode: "BH",
      vatTreatment: "vat_registered",
      paymentTermsDays: 30,
      isActive: true,
      productCount: 0,
      address: { line1: "Building 1180, Road 3621", city: "Manama", postalCode: "436" },
    });
    expect(vendor._id).toBe(vendor.id);
    expect(vendor).not.toHaveProperty("nameKey");
    expect(vendor).not.toHaveProperty("phoneKey");
    expect(vendor).not.toHaveProperty("isDelete");
  });

  it("fills defaults for a name-only vendor: home country, not_registered, terms 0, null fields", async () => {
    const vendor = (await createVendor({ name: "Al Safa Wholesale" })).body.data.vendor;
    expect(vendor).toMatchObject({
      countryCode: "BH",
      vatTreatment: "not_registered",
      paymentTermsDays: 0,
      legalName: null,
      taxRegistrationNumber: null,
      email: null,
      phone: null,
      notes: null,
      address: { line1: null, line2: null, city: null, state: null, postalCode: null },
    });
  });

  it("derives the home country from the organization's currency", async () => {
    const uae = await setup("dubai", "AED");
    const token = await tokenFor(uae.org._id, "admin@dubai.test", { orgRoleId: uae.role("org_admin")._id });
    const vendor = (await createVendor({ name: "Local" }, token)).body.data.vendor;
    expect(vendor.countryCode).toBe("AE");
    expect(vendor.vatTreatment).toBe("not_registered");
  });

  it("derives overseas for a foreign vendor without a TRN, and vat_registered whenever there is a TRN", async () => {
    expect((await createVendor({ name: "Shenzhen", countryCode: "cn" })).body.data.vendor).toMatchObject({
      countryCode: "CN",
      vatTreatment: "overseas",
    });
    expect((await createVendor({ name: "Dubai Co", countryCode: "AE", taxRegistrationNumber: "100123456700003" })).body.data.vendor.vatTreatment).toBe(
      "vat_registered"
    );
  });

  it("keeps an explicit VAT treatment", async () => {
    const res = await createVendor({ name: "Zone Co", countryCode: "BH", vatTreatment: "overseas" });
    expect(res.body.data.vendor.vatTreatment).toBe("overseas");
  });

  it("refuses vat_registered without a TRN", async () => {
    const res = await createVendor({ name: "V", vatTreatment: "vat_registered" });
    expect(res.status).toBe(400);
  });

  it("refuses a duplicate name, case-insensitively, and frees it after delete", async () => {
    const first = await createVendor({ name: "Gulf Roasters" });
    const dup = await createVendor({ name: "  gulf ROASTERS " });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("VENDOR_NAME_TAKEN");
    expect(dup.body.errors[0]).toMatchObject({ field: "name", code: "VENDOR_NAME_TAKEN" });

    await request.delete(`${VENDORS}/${first.body.data.vendor._id}`).set(auth(admin));
    expect((await createVendor({ name: "Gulf Roasters" })).status).toBe(201);
  });

  it("allows the same name in another organization", async () => {
    await createVendor({ name: "Shared Name" });
    const other = await setup("other");
    const token = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    expect((await createVendor({ name: "Shared Name" }, token)).status).toBe(201);
  });

  it("concurrent creates with one name produce exactly one vendor", async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => createVendor({ name: "Race Co" })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "VENDOR_NAME_TAKEN")).toBe(true);
    expect(await Vendor.countDocuments({ organizationId: ctx.org._id })).toBe(1);
  });

  it("refuses unknown fields and a bad country", async () => {
    expect((await createVendor({ name: "V", currency: "USD" })).status).toBe(400);
    expect((await createVendor({ name: "V", countryCode: "UK" })).status).toBe(400);
  });
});

describe("read", () => {
  it("gets a vendor; unknown, malformed and other organizations' ids are 404/400", async () => {
    const id = (await createVendor({ name: "V" })).body.data.vendor._id;
    expect((await request.get(`${VENDORS}/${id}`).set(auth(admin))).body.data.vendor.name).toBe("V");

    const missing = await request.get(`${VENDORS}/${new mongoose.Types.ObjectId()}`).set(auth(admin));
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("VENDOR_NOT_FOUND");
    expect((await request.get(`${VENDORS}/abc`).set(auth(admin))).status).toBe(400);

    const other = await setup("other");
    const token = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    expect((await request.get(`${VENDORS}/${id}`).set(auth(token))).status).toBe(404);
    expect((await request.patch(`${VENDORS}/${id}`).set(auth(token)).send({ notes: "x" })).status).toBe(404);
    expect((await request.delete(`${VENDORS}/${id}`).set(auth(token))).status).toBe(404);
  });

  it("a deleted vendor is 404", async () => {
    const id = (await createVendor({ name: "V" })).body.data.vendor._id;
    await request.delete(`${VENDORS}/${id}`).set(auth(admin));
    expect((await request.get(`${VENDORS}/${id}`).set(auth(admin))).status).toBe(404);
  });
});

describe("list, search and filters", () => {
  beforeEach(async () => {
    await createVendor(vendorExample);
    await createVendor({ name: "Al Safa Wholesale", email: "sales@alsafa.bh", phone: "+973 3999 0001", isActive: false });
    await createVendor({ name: "Shenzhen Bright Packaging Co.", countryCode: "CN", legalName: "Bright Packaging Ltd" });
  });

  const list = (query: string) => request.get(`${VENDORS}?${query}`).set(auth(admin));
  const names = async (query: string) => (await list(query)).body.data.vendors.map((v: { name: string }) => v.name);

  it("lists by name with pagination", async () => {
    const res = await list("limit=2");
    expect(res.status).toBe(200);
    expect(res.body.data.vendors.map((v: { name: string }) => v.name)).toEqual(["Al Safa Wholesale", "Gulf Roasters W.L.L."]);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(await names("page=2&limit=2")).toEqual(["Shenzhen Bright Packaging Co."]);
  });

  it("searches name and legal name prefixes, case-insensitively", async () => {
    expect(await names("search=gulf")).toEqual(["Gulf Roasters W.L.L."]);
    expect(await names("search=BRIGHT")).toEqual(["Shenzhen Bright Packaging Co."]);
    expect(await names("search=roasters")).toEqual([]); // prefix, not substring
  });

  it("searches the TRN with spaces or hyphens in the term", async () => {
    expect(await names("search=2200-0098")).toEqual(["Gulf Roasters W.L.L."]);
    expect(await names(`search=${encodeURIComponent("220000 9876")}`)).toEqual(["Gulf Roasters W.L.L."]);
  });

  it("searches email prefixes case-insensitively", async () => {
    expect(await names("search=ORDERS@")).toEqual(["Gulf Roasters W.L.L."]);
  });

  it("searches phone digits anywhere, from 4 digits, ignoring formatting", async () => {
    expect(await names("search=17001234")).toEqual(["Gulf Roasters W.L.L."]);
    expect(await names(`search=${encodeURIComponent("1700-1234")}`)).toEqual(["Gulf Roasters W.L.L."]);
    expect(await names("search=39990001")).toEqual(["Al Safa Wholesale"]);
    // "+973" alone would match every local vendor; under 4 digits the phone is not searched.
    expect(await names(`search=${encodeURIComponent("+973")}`)).toEqual([]);
  });

  it("treats regex characters in the term literally", async () => {
    expect((await list(`search=${encodeURIComponent(".*")}`)).body.data.vendors).toEqual([]);
    expect((await list(`search=${encodeURIComponent("(")}`)).status).toBe(200);
  });

  it("filters by isActive, country (any case) and VAT treatment; unknown values match nothing", async () => {
    expect(await names("isActive=true")).toEqual(["Gulf Roasters W.L.L.", "Shenzhen Bright Packaging Co."]);
    expect(await names("isActive=false")).toEqual(["Al Safa Wholesale"]);
    expect(await names("countryCode=cn")).toEqual(["Shenzhen Bright Packaging Co."]);
    expect(await names("vatTreatment=vat_registered")).toEqual(["Gulf Roasters W.L.L."]);
    expect(await names("vatTreatment=overseas")).toEqual(["Shenzhen Bright Packaging Co."]);
    expect(await names("countryCode=UK")).toEqual([]);
    expect(await names("vatTreatment=bogus")).toEqual([]);
  });

  it("never shows another organization's vendors", async () => {
    const other = await setup("other");
    const token = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    expect((await request.get(VENDORS).set(auth(token))).body.data.vendors).toEqual([]);
  });
});

describe("update", () => {
  let id: string;
  beforeEach(async () => {
    id = (await createVendor(vendorExample)).body.data.vendor._id;
  });
  const patch = (body: Record<string, unknown>) => request.patch(`${VENDORS}/${id}`).set(auth(admin)).send(body);

  it("changes only the sent fields and merges the address field by field", async () => {
    const res = await patch({ paymentTermsDays: 45, address: { city: "Muharraq", line2: null } });
    expect(res.status).toBe(200);
    expect(res.body.data.vendor).toMatchObject({
      paymentTermsDays: 45,
      name: "Gulf Roasters W.L.L.",
      address: { line1: "Building 1180, Road 3621", line2: null, city: "Muharraq", postalCode: "436" },
    });
  });

  it("address null clears every address field", async () => {
    const res = await patch({ address: null });
    expect(res.body.data.vendor.address).toEqual({ line1: null, line2: null, city: null, state: null, postalCode: null });
  });

  it("clearing the TRN of a vat_registered vendor needs the treatment changed too", async () => {
    const refused = await patch({ taxRegistrationNumber: null });
    expect(refused.status).toBe(400);
    expect(refused.body.errors[0]).toMatchObject({ field: "taxRegistrationNumber" });

    const ok = await patch({ taxRegistrationNumber: null, vatTreatment: "not_registered" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.vendor).toMatchObject({ taxRegistrationNumber: null, vatTreatment: "not_registered" });
  });

  it("vat_registered is refused while the stored TRN is empty", async () => {
    await patch({ taxRegistrationNumber: null, vatTreatment: "not_registered" });
    expect((await patch({ vatTreatment: "vat_registered" })).status).toBe(400);
    expect((await patch({ vatTreatment: "vat_registered", taxRegistrationNumber: "220000987600003" })).status).toBe(200);
  });

  it("does not re-derive the VAT treatment when the country changes", async () => {
    const res = await patch({ countryCode: "CN" });
    expect(res.body.data.vendor).toMatchObject({ countryCode: "CN", vatTreatment: "vat_registered" });
  });

  it("renames, refusing a name another vendor has but allowing a case change of its own", async () => {
    await createVendor({ name: "Al Safa" });
    const taken = await patch({ name: "AL SAFA" });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("VENDOR_NAME_TAKEN");
    expect((await patch({ name: "GULF ROASTERS W.L.L." })).status).toBe(200);
  });

  it("re-derives the phone search key when the phone changes", async () => {
    await patch({ phone: "+973 3600 9999" });
    const found = await request.get(`${VENDORS}?search=36009999`).set(auth(admin));
    expect(found.body.data.vendors).toHaveLength(1);
    expect((await request.get(`${VENDORS}?search=17001234`).set(auth(admin))).body.data.vendors).toHaveLength(0);
  });

  it("deactivates and reactivates", async () => {
    expect((await patch({ isActive: false })).body.data.vendor.isActive).toBe(false);
    expect((await patch({ isActive: true })).body.data.vendor.isActive).toBe(true);
  });

  it("refuses an empty update", async () => {
    expect((await patch({})).status).toBe(400);
  });
});

describe("permissions", () => {
  const storeToken = async (email: string, slug: string) =>
    tokenFor(ctx.org._id, email, { storeAccess: [{ storeId: ctx.store._id, roleId: ctx.role(slug)._id }] });

  it("store managers and inventory clerks read but cannot write; cashiers cannot read", async () => {
    const id = (await createVendor({ name: "V" })).body.data.vendor._id;
    for (const slug of ["store_manager", "inventory_clerk"]) {
      const token = await storeToken(`${slug}@alnoor.test`, slug);
      expect((await request.get(VENDORS).set(auth(token))).status, slug).toBe(200);
      expect((await request.get(`${VENDORS}/${id}`).set(auth(token))).status, slug).toBe(200);
      expect((await createVendor({ name: `By ${slug}` }, token)).status, slug).toBe(403);
      expect((await request.delete(`${VENDORS}/${id}`).set(auth(token))).status, slug).toBe(403);
    }
    const cashier = await storeToken("cashier@alnoor.test", "cashier");
    expect((await request.get(VENDORS).set(auth(cashier))).status).toBe(403);
  });

  it("the accountant manages vendors", async () => {
    const token = await tokenFor(ctx.org._id, "acc@alnoor.test", { orgRoleId: ctx.role("accountant")._id });
    const res = await createVendor({ name: "By accountant" }, token);
    expect(res.status).toBe(201);
    expect((await request.patch(`${VENDORS}/${res.body.data.vendor._id}`).set(auth(token)).send({ notes: "ok" })).status).toBe(200);
  });

  it("a catalog editor without purchase:read can load the picker but not write", async () => {
    const role = await request.post(ROLES).set(auth(admin)).send({ name: "Catalog editor", scope: "organization", permissions: ["product:update"] });
    expect(role.status).toBe(201);
    const token = await tokenFor(ctx.org._id, "editor@alnoor.test", { orgRoleId: role.body.data.role._id });
    expect((await request.get(VENDORS).set(auth(token))).status).toBe(200);
    expect((await createVendor({ name: "V" }, token)).status).toBe(403);
  });

  it("vendor:manage on an organization role is enough to write; reads alone are not", async () => {
    const readOnly = await request.post(ROLES).set(auth(admin)).send({ name: "Purchase viewer", scope: "organization", permissions: ["purchase:read"] });
    const token = await tokenFor(ctx.org._id, "viewer@alnoor.test", { orgRoleId: readOnly.body.data.role._id });
    expect((await request.get(VENDORS).set(auth(token))).status).toBe(200);
    expect((await createVendor({ name: "V" }, token)).status).toBe(403);
  });

  it("no token is 401", async () => {
    expect((await request.get(VENDORS)).status).toBe(401);
  });
});

describe("preferred vendor on products", () => {
  let vendorId: string;
  beforeEach(async () => {
    vendorId = (await createVendor({ name: "Gulf Roasters W.L.L." })).body.data.vendor._id;
  });

  it("shows the preferred vendor on the product and counts the product on the vendor", async () => {
    const created = await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: vendorId }));
    expect(created.status).toBe(201);
    expect(created.body.data.product.purchase.preferredVendor).toEqual({ id: vendorId, name: "Gulf Roasters W.L.L.", isActive: true });
    expect((await request.get(`${VENDORS}/${vendorId}`).set(auth(admin))).body.data.vendor.productCount).toBe(1);
    expect((await request.get(VENDORS).set(auth(admin))).body.data.vendors[0].productCount).toBe(1);
  });

  it("sets, changes and clears it on update", async () => {
    const id = (await request.post(PRODUCTS).set(auth(admin)).send(product())).body.data.product._id;
    const set = await request.patch(`${PRODUCTS}/${id}`).set(auth(admin)).send({ purchase: { preferredVendorId: vendorId } });
    expect(set.body.data.product.purchase.preferredVendor.id).toBe(vendorId);
    const cleared = await request.patch(`${PRODUCTS}/${id}`).set(auth(admin)).send({ purchase: { preferredVendorId: null } });
    expect(cleared.body.data.product.purchase.preferredVendor).toBeNull();
  });

  it("refuses an inactive vendor, but an unrelated edit of a product whose vendor was deactivated still works", async () => {
    const id = (await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: vendorId }))).body.data.product._id;
    await request.patch(`${VENDORS}/${vendorId}`).set(auth(admin)).send({ isActive: false });

    const refused = await request.post(PRODUCTS).set(auth(admin)).send({ ...product({ preferredVendorId: vendorId }), name: "Other" });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("VENDOR_INACTIVE");
    expect(refused.body.errors[0]).toMatchObject({ field: "purchase.preferredVendorId" });

    const edit = await request.patch(`${PRODUCTS}/${id}`).set(auth(admin)).send({ name: "Arabic Coffee 500g" });
    expect(edit.status).toBe(200);
    expect(edit.body.data.product.purchase.preferredVendor).toMatchObject({ id: vendorId, isActive: false });
  });

  it("refuses another organization's vendor as if it did not exist", async () => {
    const other = await setup("other");
    const token = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    const res = await request.post(PRODUCTS).set(auth(token)).send(product({ preferredVendorId: vendorId }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VENDOR_NOT_FOUND");
  });

  it("deleting the vendor clears it from products", async () => {
    const id = (await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: vendorId }))).body.data.product._id;
    expect((await request.delete(`${VENDORS}/${vendorId}`).set(auth(admin))).status).toBe(200);
    expect((await request.get(`${PRODUCTS}/${id}`).set(auth(admin))).body.data.product.purchase.preferredVendor).toBeNull();
    expect((await Product.findById(id))!.purchase.preferredVendorId).toBeNull();
  });

  it("a dangling reference (delete racing a save) reads as null", async () => {
    const id = (await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: vendorId }))).body.data.product._id;
    await Vendor.updateOne({ _id: vendorId }, { $set: { isDelete: true } }); // without clearing products
    expect((await request.get(`${PRODUCTS}/${id}`).set(auth(admin))).body.data.product.purchase.preferredVendor).toBeNull();
  });

  it("cashiers see the preferred vendor's name on products", async () => {
    const id = (await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: vendorId }))).body.data.product._id;
    const cashier = await tokenFor(ctx.org._id, "cashier@alnoor.test", {
      storeAccess: [{ storeId: ctx.store._id, roleId: ctx.role("cashier")._id }],
    });
    const res = await request.get(`${PRODUCTS}/${id}`).set(auth(cashier));
    expect(res.body.data.product.purchase.preferredVendor.name).toBe("Gulf Roasters W.L.L.");
  });
});

describe("migration of the old free-text vendor names", () => {
  it("appends the name to the purchase description, drops empty ones, and is idempotent", async () => {
    const created = await request.post(PRODUCTS).set(auth(admin)).send(product({ description: "Carton of 24." }));
    const bare = await request.post(PRODUCTS).set(auth(admin)).send({ ...product(), name: "Bare", sku: "BARE", barcodes: undefined });
    const empty = await request.post(PRODUCTS).set(auth(admin)).send({ ...product(), name: "Empty", sku: "EMPTY", barcodes: undefined });
    const ids = [created, bare, empty].map((res) => new mongoose.Types.ObjectId(res.body.data.product._id as string));
    // Simulate products saved before vendors existed.
    await Product.collection.updateOne({ _id: ids[0] }, { $set: { "purchase.preferredVendorName": " Gulf Roasters W.L.L. " } });
    await Product.collection.updateOne({ _id: ids[1] }, { $set: { "purchase.preferredVendorName": "Al Safa" } });
    await Product.collection.updateOne({ _id: ids[2] }, { $set: { "purchase.preferredVendorName": null } });

    expect(await migratePreferredVendorNames()).toEqual({ migrated: 2, cleared: 1 });

    const raw = await Product.collection.find({ _id: { $in: ids } }).toArray();
    const byId = new Map(raw.map((doc) => [doc._id.toString(), doc.purchase]));
    expect(byId.get(ids[0].toString())).toMatchObject({ description: "Carton of 24.\nPreferred vendor: Gulf Roasters W.L.L." });
    expect(byId.get(ids[1].toString())).toMatchObject({ description: "Preferred vendor: Al Safa" });
    for (const purchase of byId.values()) {
      expect(purchase).not.toHaveProperty("preferredVendorName");
    }

    expect(await migratePreferredVendorNames()).toEqual({ migrated: 0, cleared: 0 });
  });

  it("keeps the description within its 1000-character limit", () => {
    expect(mergedDescription("x".repeat(995), "Gulf Roasters")).toHaveLength(1000);
    expect(mergedDescription(null, "V")).toBe("Preferred vendor: V");
  });
});
