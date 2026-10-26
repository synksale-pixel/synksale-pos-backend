/**
 * Purpose: Review tests for Phase 3a vendors: response shapes against the Zod response schemas,
 * hostile input (no 500s), cross-tenant isolation, RBAC edges, delete atomicity and the migration's
 * edge cases.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { generateSuperAdminAccessToken } from "../../src/services/platformAuth.service";
import { migratePreferredVendorNames } from "../../src/services/preferredVendorNameMigration.service";
import { singleExample } from "../../src/docs/product.openapi";
import { vendorExample } from "../../src/docs/vendor.openapi";
import { VendorDataSchema, VendorListDataSchema, ProductDataSchema } from "../../src/validators/responses";

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
    countryCode: "BH",
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
let other: Awaited<ReturnType<typeof setup>>;
let otherAdmin: string;

beforeEach(async () => {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
  other = await setup("other");
  otherAdmin = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
});

const createVendor = (body: unknown, token = admin) => request.post(VENDORS).set(auth(token)).send(body as object);
const product = (purchase: Record<string, unknown> = {}) => ({
  ...singleExample,
  categoryId: undefined,
  taxRateId: undefined,
  purchase: { costPrice: "1.600", ...purchase },
});

describe("responses match the Zod response schemas", () => {
  it("create, get, update and list parse as VendorSchema", async () => {
    const created = await createVendor(vendorExample);
    expect(VendorDataSchema.safeParse(created.body.data).success, JSON.stringify(created.body.data)).toBe(true);
    const id = created.body.data.vendor._id;
    const got = await request.get(`${VENDORS}/${id}`).set(auth(admin));
    expect(VendorDataSchema.safeParse(got.body.data).success).toBe(true);
    const patched = await request.patch(`${VENDORS}/${id}`).set(auth(admin)).send({ address: null, email: null, phone: null });
    expect(VendorDataSchema.safeParse(patched.body.data).success).toBe(true);
    await createVendor({ name: "Min" });
    const list = await request.get(VENDORS).set(auth(admin));
    expect(VendorListDataSchema.safeParse(list.body.data).success).toBe(true);
  });

  it("product with and without a preferred vendor parses as ProductSchema", async () => {
    const vendorId = (await createVendor({ name: "V" })).body.data.vendor._id;
    const withV = await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: vendorId }));
    expect(ProductDataSchema.safeParse(withV.body.data).success).toBe(true);
    const without = await request.post(PRODUCTS).set(auth(admin)).send({ ...product(), name: "N2", sku: "N2", barcodes: undefined });
    expect(without.status).toBe(201);
    expect(without.body.data.product.purchase.preferredVendor).toBeNull();
    expect(ProductDataSchema.safeParse(without.body.data).success).toBe(true);
  });
});

describe("hostile input never returns 500", () => {
  const get = (q: string) => request.get(`${VENDORS}${q}`).set(auth(admin));

  beforeEach(async () => {
    await createVendor({ name: "Alpha" });
    await createVendor({ name: "Beta" });
  });

  it.each([
    "?search[]=x",
    "?search[a]=b",
    "?search=a&search=b",
    "?isActive=garbage",
    "?isActive[]=true",
    "?countryCode[]=BH",
    "?countryCode[$ne]=BH",
    "?vatTreatment[$ne]=x",
    "?page=abc",
    "?page=-3",
    "?page=0",
    "?page=99999999999999999999",
    "?page=1e400",
    "?page=Infinity",
    "?limit=1000",
    "?limit=0",
    "?limit=-1",
    "?limit=abc",
    "?limit=Infinity",
    "?limit=1.5",
    "?page[]=1",
    "?search=%00",
    `?search=${"a".repeat(5000)}`,
    "?search=%5C",
    "?search=%5B",
    "?search=%2B%2B",
  ])("GET %s is a 200", async (q) => {
    const res = await get(q);
    expect(res.status, q).toBe(200);
  });

  it("limit above 100 is capped and a huge page is empty, not an error", async () => {
    expect((await get("?limit=1000")).body.data.pagination.limit).toBe(100);
    const far = await get("?page=99999999999999999999");
    expect(far.body.data.vendors).toEqual([]);
  });

  it("isActive=garbage is lenient (returns all vendors)", async () => {
    expect((await get("?isActive=garbage")).body.data.vendors).toHaveLength(2);
  });

  it.each(["abc", "123", "%00", "zzzzzzzzzzzzzzzzzzzzzzzz"])("path id %s is a coded 4xx", async (id) => {
    for (const res of [
      await request.get(`${VENDORS}/${id}`).set(auth(admin)),
      await request.patch(`${VENDORS}/${id}`).set(auth(admin)).send({ notes: "x" }),
      await request.delete(`${VENDORS}/${id}`).set(auth(admin)),
    ]) {
      expect([400, 404], `${id} -> ${res.status}`).toContain(res.status);
    }
  });

  it.each([
    [{ name: { $ne: null } }],
    [{ name: ["a"] }],
    [{ name: 5 }],
    [{ name: "x", countryCode: { $ne: "BH" } }],
    [{ name: "x", countryCode: ["BH"] }],
    [{ name: "x", paymentTermsDays: "30" }],
    [{ name: "x", paymentTermsDays: 1.5 }],
    [{ name: "x", paymentTermsDays: 366 }],
    [{ name: "x", paymentTermsDays: -1 }],
    [{ name: "x", paymentTermsDays: null }],
    [{ name: "x", email: "nope" }],
    [{ name: "x", phone: "abc" }],
    [{ name: "x", address: "street" }],
    [{ name: "x", address: { country: "BH" } }],
    [{ name: "x", isActive: "yes" }],
    [{ name: "x", vatTreatment: "bogus" }],
    [{ name: "   " }],
    [{ name: "x".repeat(121) }],
    [{ name: "x", organizationId: "665f1c2e8a4b3c0012ab3300" }],
    [{ name: "x", isDelete: true }],
    [{ name: "x", nameKey: "y" }],
    [["a"]],
    [null],
    ["str"],
  ])("POST %j is a 400", async (body) => {
    const res = await createVendor(body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|node_modules|passwordHash/);
  });

  it("malformed JSON is a 4xx", async () => {
    const res = await request.post(VENDORS).set(auth(admin)).set("Content-Type", "application/json").send('{"name": ');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it.each(["abc", 123, { $ne: null }, ["x"], "", "665f1c2e8a4b3c0012ab39zz"])("product preferredVendorId %j is a 400", async (value) => {
    const res = await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: value }));
    expect(res.status).toBe(400);
  });

  it("an unknown but well-formed preferredVendorId is VENDOR_NOT_FOUND 400, on update too", async () => {
    const pid = (await request.post(PRODUCTS).set(auth(admin)).send(product())).body.data.product._id;
    const res = await request.patch(`${PRODUCTS}/${pid}`).set(auth(admin)).send({ purchase: { preferredVendorId: String(new mongoose.Types.ObjectId()) } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VENDOR_NOT_FOUND");
  });

  it("the removed preferredVendorName field is rejected on products", async () => {
    const res = await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorName: "Old" }));
    expect(res.status).toBe(400);
  });
});

describe("cross-tenant isolation", () => {
  let vendorId: string;
  beforeEach(async () => {
    vendorId = (await createVendor({ name: "Mine" })).body.data.vendor._id;
  });

  it("another org cannot patch or delete the vendor, and nothing changes", async () => {
    expect((await request.patch(`${VENDORS}/${vendorId}`).set(auth(otherAdmin)).send({ name: "Hacked" })).status).toBe(404);
    expect((await request.delete(`${VENDORS}/${vendorId}`).set(auth(otherAdmin))).status).toBe(404);
    const v = await Vendor.findById(vendorId);
    expect(v?.name).toBe("Mine");
    expect(v?.isDelete).toBe(false);
  });

  it("a product in another org naming this vendor id is neither counted nor cleared by delete", async () => {
    const mine = (await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: vendorId }))).body.data.product._id;
    const theirs = (await request.post(PRODUCTS).set(auth(otherAdmin)).send(product())).body.data.product._id;
    // Forge a cross-org reference straight in the DB (the API refuses to create one).
    await Product.collection.updateOne({ _id: new mongoose.Types.ObjectId(theirs) }, { $set: { "purchase.preferredVendorId": new mongoose.Types.ObjectId(vendorId) } });

    expect((await request.get(`${VENDORS}/${vendorId}`).set(auth(admin))).body.data.vendor.productCount).toBe(1);
    expect((await request.get(`${PRODUCTS}/${theirs}`).set(auth(otherAdmin))).body.data.product.purchase.preferredVendor).toBeNull();

    expect((await request.delete(`${VENDORS}/${vendorId}`).set(auth(admin))).status).toBe(200);
    const raw = await Product.collection.findOne({ _id: new mongoose.Types.ObjectId(theirs) });
    expect(String(raw?.purchase.preferredVendorId)).toBe(vendorId);
    expect((await Product.findById(mine))!.purchase.preferredVendorId).toBeNull();
  });

  it("another org cannot set the vendor as preferred on update either", async () => {
    const pid = (await request.post(PRODUCTS).set(auth(otherAdmin)).send(product())).body.data.product._id;
    const res = await request.patch(`${PRODUCTS}/${pid}`).set(auth(otherAdmin)).send({ purchase: { preferredVendorId: vendorId } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VENDOR_NOT_FOUND");
  });

  it("productCount ignores soft-deleted products", async () => {
    const pid = (await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: vendorId }))).body.data.product._id;
    await Product.updateOne({ _id: pid }, { $set: { isDelete: true } });
    expect((await request.get(`${VENDORS}/${vendorId}`).set(auth(admin))).body.data.vendor.productCount).toBe(0);
  });

  it("organizationId cannot be sent in the body", async () => {
    expect((await request.patch(`${VENDORS}/${vendorId}`).set(auth(admin)).send({ organizationId: String(other.org._id) })).status).toBe(400);
  });
});

describe("auth boundary and RBAC", () => {
  it("a platform token is refused on vendor routes", async () => {
    const platform = generateSuperAdminAccessToken({ userId: String(new mongoose.Types.ObjectId()) });
    expect((await request.get(VENDORS).set(auth(platform))).status).toBe(401);
    expect((await createVendor({ name: "x" }, platform)).status).toBe(401);
  });

  it("garbage and tampered tokens are 401", async () => {
    expect((await request.get(VENDORS).set(auth("abc.def.ghi"))).status).toBe(401);
    expect((await request.get(VENDORS).set(auth(admin.slice(0, -3) + "xxx"))).status).toBe(401);
  });

  it("an org role with only vendor:manage may write but not read (the documented read gate)", async () => {
    const role = await request.post(ROLES).set(auth(admin)).send({ name: "Vendor writer", scope: "organization", permissions: ["vendor:manage"] });
    expect(role.status).toBe(201);
    const token = await tokenFor(ctx.org._id, "w@alnoor.test", { orgRoleId: role.body.data.role._id });
    expect((await createVendor({ name: "W" }, token)).status).toBe(201);
    expect((await request.get(VENDORS).set(auth(token))).status).toBe(403);
  });

  it("a user with no role at all is 403 on reads and writes", async () => {
    const token = await tokenFor(ctx.org._id, "none@alnoor.test", {});
    expect((await request.get(VENDORS).set(auth(token))).status).toBe(403);
    expect((await createVendor({ name: "x" }, token)).status).toBe(403);
  });

  it("product:create alone (org role) reads but cannot patch or delete", async () => {
    const role = await request.post(ROLES).set(auth(admin)).send({ name: "Creator", scope: "organization", permissions: ["product:create"] });
    const token = await tokenFor(ctx.org._id, "c@alnoor.test", { orgRoleId: role.body.data.role._id });
    const id = (await createVendor({ name: "V" })).body.data.vendor._id;
    expect((await request.get(`${VENDORS}/${id}`).set(auth(token))).status).toBe(200);
    expect((await request.patch(`${VENDORS}/${id}`).set(auth(token)).send({ notes: "x" })).status).toBe(403);
    expect((await request.delete(`${VENDORS}/${id}`).set(auth(token))).status).toBe(403);
  });
});

describe("correctness edges", () => {
  it("normalises TRN and lowercases email on create; name boundary 120 ok", async () => {
    const res = await createVendor({ name: "x".repeat(120), taxRegistrationNumber: "2200-0098 7600003", email: "A@B.COM" });
    expect(res.status).toBe(201);
    expect(res.body.data.vendor).toMatchObject({ taxRegistrationNumber: "220000987600003", email: "a@b.com", vatTreatment: "vat_registered" });
  });

  it("vat_registered with a stored TRN can be updated without resending the TRN; a deleted vendor is 404 on patch and a second delete", async () => {
    const id = (await createVendor(vendorExample)).body.data.vendor._id;
    expect((await request.patch(`${VENDORS}/${id}`).set(auth(admin)).send({ vatTreatment: "vat_registered", notes: "n" })).status).toBe(200);
    expect((await request.delete(`${VENDORS}/${id}`).set(auth(admin))).status).toBe(200);
    expect((await request.patch(`${VENDORS}/${id}`).set(auth(admin)).send({ notes: "n" })).status).toBe(404);
    expect((await request.delete(`${VENDORS}/${id}`).set(auth(admin))).status).toBe(404);
  });

  it("two concurrent renames to one name leave one winner; a deleted vendor's name is reusable by rename", async () => {
    const a = (await createVendor({ name: "A" })).body.data.vendor._id;
    const b = (await createVendor({ name: "B" })).body.data.vendor._id;
    const c = (await createVendor({ name: "C" })).body.data.vendor._id;
    const results = await Promise.all([a, b].map((id) => request.patch(`${VENDORS}/${id}`).set(auth(admin)).send({ name: "Same" })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await request.delete(`${VENDORS}/${c}`).set(auth(admin));
    const winner = results[0].status === 200 ? a : b;
    expect((await request.patch(`${VENDORS}/${winner}`).set(auth(admin)).send({ name: "C" })).status).toBe(200);
  });

  it("name is trimmed and an empty-after-trim update name is 400", async () => {
    const id = (await createVendor({ name: "  Padded  " })).body.data.vendor._id;
    expect((await request.get(`${VENDORS}/${id}`).set(auth(admin))).body.data.vendor.name).toBe("Padded");
    expect((await request.patch(`${VENDORS}/${id}`).set(auth(admin)).send({ name: "  " })).status).toBe(400);
  });

  it("phone search needs 4 digits and a cleared phone no longer matches", async () => {
    const id = (await createVendor({ name: "P", phone: "+973 1700 1234" })).body.data.vendor._id;
    expect((await request.get(`${VENDORS}?search=170`).set(auth(admin))).body.data.vendors).toHaveLength(0);
    expect((await request.get(`${VENDORS}?search=1700`).set(auth(admin))).body.data.vendors).toHaveLength(1);
    await request.patch(`${VENDORS}/${id}`).set(auth(admin)).send({ phone: null });
    expect((await request.get(`${VENDORS}?search=1700`).set(auth(admin))).body.data.vendors).toHaveLength(0);
  });

  it("TRN search is case-insensitive via normalisation", async () => {
    await createVendor({ name: "T", taxRegistrationNumber: "ab12345" });
    expect((await request.get(`${VENDORS}?search=ab-123`).set(auth(admin))).body.data.vendors).toHaveLength(1);
  });

  it("pagination totals are consistent with filters", async () => {
    for (let i = 0; i < 5; i++) await createVendor({ name: `V${i}`, isActive: i % 2 === 0 });
    const res = await request.get(`${VENDORS}?isActive=true&limit=2&page=2`).set(auth(admin));
    expect(res.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(res.body.data.vendors).toHaveLength(1);
  });
});

describe("delete atomicity", () => {
  it("a failure clearing products rolls the soft delete back", async () => {
    const vendorId = (await createVendor({ name: "Keep" })).body.data.vendor._id;
    await request.post(PRODUCTS).set(auth(admin)).send(product({ preferredVendorId: vendorId }));
    const spy = vi.spyOn(Product, "updateMany").mockRejectedValueOnce(new Error("boom"));
    const res = await request.delete(`${VENDORS}/${vendorId}`).set(auth(admin));
    spy.mockRestore();
    expect(res.status).toBe(500);
    const v = await Vendor.findById(vendorId);
    expect(v?.isDelete).toBe(false);
  });
});

describe("migration edge cases", () => {
  const mk = async (token: string, name: string, sku: string) =>
    new mongoose.Types.ObjectId(
      (await request.post(PRODUCTS).set(auth(token)).send({ ...product(), name, sku, barcodes: undefined })).body.data.product._id as string
    );
  const raw = async (id: mongoose.Types.ObjectId) => (await Product.collection.findOne({ _id: id }))!.purchase;

  it("handles several orgs, soft-deleted products and non-string values", async () => {
    const a = await mk(admin, "A", "A1");
    const b = await mk(otherAdmin, "B", "B1");
    const c = await mk(admin, "C", "C1");
    const d = await mk(admin, "D", "D1");
    await Product.collection.updateOne({ _id: a }, { $set: { "purchase.preferredVendorName": "Va" } });
    await Product.collection.updateOne({ _id: b }, { $set: { "purchase.preferredVendorName": "Vb" } });
    await Product.collection.updateOne({ _id: c }, { $set: { "purchase.preferredVendorName": "Vc", isDelete: true } });
    await Product.collection.updateOne({ _id: d }, { $set: { "purchase.preferredVendorName": 42 } });
    expect(await migratePreferredVendorNames()).toEqual({ migrated: 3, cleared: 1 });
    expect((await raw(a)).description).toBe("Preferred vendor: Va");
    expect((await raw(b)).description).toBe("Preferred vendor: Vb");
    expect((await raw(c)).description).toBe("Preferred vendor: Vc");
    expect(await raw(d)).not.toHaveProperty("preferredVendorName");
  });

  it("a whitespace-only name leaves no 'Preferred vendor: ' stub", async () => {
    const a = await mk(admin, "A", "A1");
    await Product.collection.updateOne({ _id: a }, { $set: { "purchase.preferredVendorName": "   " } });
    await migratePreferredVendorNames();
    const purchase = await raw(a);
    expect(purchase).not.toHaveProperty("preferredVendorName");
    expect(purchase.description ?? null).not.toBe("Preferred vendor: ");
  });

  it("does not silently lose the vendor name when the description is at the 1000 limit", async () => {
    const a = await mk(admin, "A", "A1");
    await Product.collection.updateOne({ _id: a }, { $set: { "purchase.description": "x".repeat(1000), "purchase.preferredVendorName": "Gulf Roasters" } });
    await migratePreferredVendorNames();
    const purchase = await raw(a);
    expect(purchase.description.length).toBeLessThanOrEqual(1000);
    expect(purchase.description).toContain("Gulf Roasters");
  });
});
