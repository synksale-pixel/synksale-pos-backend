/**
 * Purpose: Phase 4a-2 customers over HTTP: create (shape, phone uniqueness by normalised number,
 * the duplicate's meta, tax number country rules, India stateCode), the till's phone lookup,
 * list search and filters, update, delete (saleCount guard, number freed), bulk import, the
 * permissions of each role and tenant isolation.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Customer } from "../../src/models/customer.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";
import {
  businessCustomerExample,
  customerExample,
  importCustomersExample,
  indiaBusinessCustomerExample,
} from "../../src/docs/customer.openapi";

const CUSTOMERS = "/api/v1/customers";
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

beforeEach(async () => {
  ctx = await setup("alnoor");
  admin = await tokenFor(ctx.org._id, "admin@alnoor.test", { orgRoleId: ctx.role("org_admin")._id });
});

const storeRoleToken = (slug: string, email = `${slug}@alnoor.test`) =>
  tokenFor(ctx.org._id, email, { storeAccess: [{ storeId: ctx.store._id, roleId: ctx.role(slug)._id }] });

const create = (body: Record<string, unknown>, token = admin) => request.post(CUSTOMERS).set(auth(token)).send(body);

async function createOk(body: Record<string, unknown>, token = admin) {
  const res = await create(body, token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.customer;
}

const lookup = (phone: string, token = admin) =>
  request.get(`${CUSTOMERS}/lookup`).query({ phone }).set(auth(token));

describe("create", () => {
  it("creates a walk-in customer with the full response shape", async () => {
    const customer = await createOk(customerExample);
    expect(customer).toMatchObject({
      name: "Fatima Al Khalifa",
      phone: "+973 3600 1234",
      email: null,
      address: { line1: null, line2: null, city: null, state: null, postalCode: null },
      taxRegistrationNumber: null,
      stateCode: null,
      notes: null,
      isActive: true,
      saleCount: 0,
    });
    expect(customer.id).toBe(customer._id);
    expect(customer.phoneKey).toBeUndefined();
    expect(customer.nameKey).toBeUndefined();
  });

  it("creates a B2B customer with a normalised TRN and address", async () => {
    const customer = await createOk({ ...businessCustomerExample, taxRegistrationNumber: "2200-0055 5500003" });
    expect(customer.taxRegistrationNumber).toBe("220000555500003");
    expect(customer.address.city).toBe("Seef");
    expect(customer.stateCode).toBeNull();
  });

  it("refuses a tax number that is not valid for the organization's country", async () => {
    const res = await create({ ...customerExample, taxRegistrationNumber: "12345" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors[0].field).toBe("taxRegistrationNumber");
  });

  it("India: reads stateCode from the GSTIN and checks its check character", async () => {
    const india = await setup("sharma", "INR");
    const token = await tokenFor(india.org._id, "admin@sharma.test", { orgRoleId: india.role("org_admin")._id });
    const customer = await createOk(indiaBusinessCustomerExample, token);
    expect(customer.stateCode).toBe("29");

    const typo = await create({ ...indiaBusinessCustomerExample, phone: "9845012346", taxRegistrationNumber: "29ABCDE1234F1ZX" }, token);
    expect(typo.status).toBe(400);
    expect(typo.body.errors[0].field).toBe("taxRegistrationNumber");
  });

  it("treats every form of one number as the same customer, with meta naming them", async () => {
    const first = await createOk(customerExample);
    for (const phone of ["36001234", "0097336001234", "973 3600 1234", "+973-3600-1234"]) {
      const res = await create({ name: "Someone else", phone });
      expect(res.status, phone).toBe(409);
      expect(res.body.code).toBe("CUSTOMER_PHONE_EXISTS");
      expect(res.body.errors[0]).toMatchObject({
        field: "phone",
        code: "CUSTOMER_PHONE_EXISTS",
        meta: { customerId: first._id, isActive: true, name: "Fatima Al Khalifa" },
      });
    }
  });

  it("a deactivated customer still holds the number (meta.isActive false)", async () => {
    const first = await createOk({ ...customerExample, isActive: false });
    const res = await create({ name: "Other", phone: "36001234" });
    expect(res.status).toBe(409);
    expect(res.body.errors[0].meta).toMatchObject({ customerId: first._id, isActive: false });
  });

  it("a foreign number is kept whole and never collides with a national one", async () => {
    await createOk({ name: "Visitor", phone: "+44 7700 900123" });
    await createOk({ name: "Local", phone: "77009001" });
    const res = await create({ name: "Visitor again", phone: "0044 7700 900123" });
    expect(res.status).toBe(409);
  });

  it("the same number can exist in another organization", async () => {
    await createOk(customerExample);
    const other = await setup("other");
    const token = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    await createOk(customerExample, token);
  });

  it("validates the body", async () => {
    const res = await create({ name: "", phone: "12" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    const unknown = await create({ ...customerExample, loyaltyPoints: 10 });
    expect(unknown.status).toBe(400);
  });
});

describe("lookup", () => {
  beforeEach(async () => {
    await createOk({ name: "Exact", phone: "36001234" });
    await createOk({ name: "Longer", phone: "+44 3600 12345" }); // foreign: key "+44360012345", not a prefix match
    await createOk({ name: "Same prefix A", phone: "36005555" });
    await createOk({ name: "Same prefix B", phone: "36009999" });
    await createOk({ name: "Inactive", phone: "36001111", isActive: false });
  });

  it("returns the exact active match and other starts-with suggestions", async () => {
    const res = await lookup("+973 3600 1234");
    expect(res.status).toBe(200);
    expect(res.body.data.match.name).toBe("Exact");
    expect(res.body.data.suggestions).toEqual([]);
  });

  it("partial input gives suggestions only, shortest first, never inactive customers", async () => {
    const res = await lookup("3600");
    expect(res.status).toBe(200);
    expect(res.body.data.match).toBeNull();
    const names = res.body.data.suggestions.map((c: { name: string }) => c.name);
    expect(names).toEqual(["Exact", "Same prefix A", "Same prefix B"]);
  });

  it("caps suggestions at 4 and sorts shorter numbers first", async () => {
    await createOk({ name: "Short", phone: "3600123" });
    await createOk({ name: "Extra", phone: "36007777" });
    const res = await lookup("3600");
    const names = res.body.data.suggestions.map((c: { name: string }) => c.name);
    expect(names).toHaveLength(4);
    expect(names[0]).toBe("Short");
  });

  it("an exact match on an inactive customer is not returned", async () => {
    const res = await lookup("36001111");
    expect(res.body.data.match).toBeNull();
    expect(res.body.data.suggestions).toEqual([]);
  });

  it("needs at least 4 digits", async () => {
    for (const phone of ["360", "+973", ""]) {
      const res = await lookup(phone);
      expect(res.status, phone).toBe(400);
      expect(res.body.errors[0].field).toBe("phone");
    }
    const missing = await request.get(`${CUSTOMERS}/lookup`).set(auth(admin));
    expect(missing.status).toBe(400);
  });

  it("is not confused by regex characters", async () => {
    const res = await lookup("3600.*");
    expect(res.status).toBe(200);
  });
});

describe("list", () => {
  beforeEach(async () => {
    await createOk({ name: "Fatima Al Khalifa", phone: "36001234", email: "fatima@example.bh" });
    await createOk({ ...businessCustomerExample });
    await createOk({ name: "Ali Hassan", phone: "39998888", isActive: false });
  });

  const list = (query: Record<string, string> = {}) => request.get(CUSTOMERS).query(query).set(auth(admin));
  const names = (res: { body: { data: { customers: { name: string }[] } } }) => res.body.data.customers.map((c) => c.name);

  it("lists newest first with pagination", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["Ali Hassan", "Gulf Traders W.L.L.", "Fatima Al Khalifa"]);
    expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 20, total: 3, totalPages: 1 });
  });

  it("searches a prefix of any word of the name, the phone, email and TRN", async () => {
    expect(names(await list({ search: "kha" }))).toEqual(["Fatima Al Khalifa"]);
    expect(names(await list({ search: "traders" }))).toEqual(["Gulf Traders W.L.L."]);
    expect(names(await list({ search: "+973 3600" }))).toEqual(["Fatima Al Khalifa"]);
    expect(names(await list({ search: "fatima@" }))).toEqual(["Fatima Al Khalifa"]);
    expect(names(await list({ search: "2200-0055" }))).toEqual(["Gulf Traders W.L.L."]);
    expect(names(await list({ search: "alif" }))).toEqual([]);
  });

  it("filters by isActive and hasTaxRegistrationNumber", async () => {
    expect(names(await list({ isActive: "false" }))).toEqual(["Ali Hassan"]);
    expect(names(await list({ hasTaxRegistrationNumber: "true" }))).toEqual(["Gulf Traders W.L.L."]);
    expect(names(await list({ hasTaxRegistrationNumber: "false" }))).toHaveLength(2);
  });
});

describe("get, update, delete", () => {
  it("reads one; an unknown, foreign or malformed id is 404/400", async () => {
    const customer = await createOk(customerExample);
    const res = await request.get(`${CUSTOMERS}/${customer._id}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.customer.name).toBe("Fatima Al Khalifa");

    const missing = await request.get(`${CUSTOMERS}/665f1c2e8a4b3c0012ab4399`).set(auth(admin));
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("CUSTOMER_NOT_FOUND");

    const malformed = await request.get(`${CUSTOMERS}/not-an-id`).set(auth(admin));
    expect(malformed.status).toBe(400);

    const other = await setup("other");
    const token = await tokenFor(other.org._id, "admin@other.test", { orgRoleId: other.role("org_admin")._id });
    const foreign = await request.get(`${CUSTOMERS}/${customer._id}`).set(auth(token));
    expect(foreign.status).toBe(404);
  });

  it("updates sent fields, merges the address and clears with null", async () => {
    const customer = await createOk(businessCustomerExample);
    const res = await request
      .patch(`${CUSTOMERS}/${customer._id}`)
      .set(auth(admin))
      .send({ address: { city: "Riffa" }, notes: null, taxRegistrationNumber: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updated = res.body.data.customer;
    expect(updated.address).toMatchObject({ line1: "Office 12, Building 2050", city: "Riffa" });
    expect(updated.notes).toBeNull();
    expect(updated.taxRegistrationNumber).toBeNull();
  });

  it("a changed phone is checked for duplicates; keeping one's own number is fine", async () => {
    const a = await createOk(customerExample);
    const b = await createOk({ name: "Ali", phone: "39998888" });

    const same = await request.patch(`${CUSTOMERS}/${a._id}`).set(auth(admin)).send({ phone: "36001234" });
    expect(same.status).toBe(200);
    expect(same.body.data.customer.phone).toBe("36001234");

    const taken = await request.patch(`${CUSTOMERS}/${b._id}`).set(auth(admin)).send({ phone: "+973 3600 1234" });
    expect(taken.status).toBe(409);
    expect(taken.body.errors[0].meta.customerId).toBe(a._id);
  });

  it("deletes a customer without sales and frees the number", async () => {
    const customer = await createOk(customerExample);
    const res = await request.delete(`${CUSTOMERS}/${customer._id}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect((await request.get(`${CUSTOMERS}/${customer._id}`).set(auth(admin))).status).toBe(404);
    await createOk(customerExample);
  });

  it("refuses to delete a customer with sales", async () => {
    const customer = await createOk(customerExample);
    await Customer.updateOne({ _id: customer._id }, { $set: { saleCount: 2 } });
    const res = await request.delete(`${CUSTOMERS}/${customer._id}`).set(auth(admin));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CUSTOMER_HAS_SALES");
    expect(res.body.errors[0].meta.saleCount).toBe(2);
  });
});

describe("import", () => {
  const importRows = (rows: unknown[], token = admin) => request.post(`${CUSTOMERS}/import`).set(auth(token)).send({ rows });

  it("reports created, duplicate (of an earlier row) and invalid rows", async () => {
    const res = await importRows(importCustomersExample.rows);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { summary, results } = res.body.data;
    expect(summary).toEqual({ received: 4, created: 2, duplicate: 1, invalid: 1 });
    expect(results.map((r: { status: string }) => r.status)).toEqual(["created", "created", "duplicate", "invalid"]);
    // Row 3 ("3600 1234") is row 1's number.
    expect(results[2].customerId).toBe(results[0].customerId);
    expect(results[3].customerId).toBeNull();
    expect(results[3].errors.map((e: { field: string }) => e.field)).toEqual(expect.arrayContaining(["name", "phone"]));
    expect(await Customer.countDocuments({ organizationId: ctx.org._id })).toBe(2);
  });

  it("re-sending the same file reports every valid row as a duplicate and changes nothing", async () => {
    const first = await importRows(importCustomersExample.rows);
    const again = await importRows(importCustomersExample.rows);
    expect(again.body.data.summary).toEqual({ received: 4, created: 0, duplicate: 3, invalid: 1 });
    expect(again.body.data.results[0].customerId).toBe(first.body.data.results[0].customerId);
  });

  it("an existing customer is a duplicate and is not changed", async () => {
    const existing = await createOk({ name: "Original", phone: "36001234" });
    const res = await importRows([{ name: "Renamed", phone: "+973 3600 1234", email: "x@example.bh" }]);
    expect(res.body.data.results[0]).toMatchObject({ status: "duplicate", customerId: existing._id });
    const after = await request.get(`${CUSTOMERS}/${existing._id}`).set(auth(admin));
    expect(after.body.data.customer).toMatchObject({ name: "Original", email: null });
  });

  it("checks each row's tax number for the country", async () => {
    const res = await importRows([{ name: "Bad TRN", phone: "36001234", taxRegistrationNumber: "12345" }]);
    expect(res.body.data.results[0]).toMatchObject({
      status: "invalid",
      errors: [{ field: "taxRegistrationNumber", code: "VALIDATION_FAILED" }],
    });
  });

  it("refuses a malformed body", async () => {
    expect((await importRows([])).status).toBe(400);
    expect((await request.post(`${CUSTOMERS}/import`).set(auth(admin)).send({})).status).toBe(400);
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ name: `C${i}`, phone: `3${String(i).padStart(7, "0")}` }));
    expect((await importRows(tooMany)).status).toBe(400);
  });
});

describe("permissions", () => {
  it("a cashier can look up, read and add customers, but not edit, import or delete", async () => {
    const cashier = await storeRoleToken("cashier");
    const customer = await createOk(customerExample, cashier);
    expect((await request.get(CUSTOMERS).set(auth(cashier))).status).toBe(200);
    expect((await lookup("3600", cashier)).status).toBe(200);
    expect((await request.get(`${CUSTOMERS}/${customer._id}`).set(auth(cashier))).status).toBe(200);

    expect((await request.patch(`${CUSTOMERS}/${customer._id}`).set(auth(cashier)).send({ name: "X" })).status).toBe(403);
    expect((await request.post(`${CUSTOMERS}/import`).set(auth(cashier)).send({ rows: [customerExample] })).status).toBe(403);
    expect((await request.delete(`${CUSTOMERS}/${customer._id}`).set(auth(cashier))).status).toBe(403);
  });

  it("a store manager can manage customers", async () => {
    const manager = await storeRoleToken("store_manager");
    const customer = await createOk(customerExample, manager);
    expect((await request.patch(`${CUSTOMERS}/${customer._id}`).set(auth(manager)).send({ name: "X" })).status).toBe(200);
    expect((await request.post(`${CUSTOMERS}/import`).set(auth(manager)).send({ rows: [{ name: "Y", phone: "39990000" }] })).status).toBe(200);
    expect((await request.delete(`${CUSTOMERS}/${customer._id}`).set(auth(manager))).status).toBe(200);
  });

  it("an accountant can only read; an inventory clerk cannot read", async () => {
    const accountant = await storeRoleToken("accountant");
    expect((await request.get(CUSTOMERS).set(auth(accountant))).status).toBe(200);
    expect((await create(customerExample, accountant)).status).toBe(403);

    const clerk = await storeRoleToken("inventory_clerk");
    expect((await request.get(CUSTOMERS).set(auth(clerk))).status).toBe(403);
    expect((await lookup("3600", clerk)).status).toBe(403);
  });

  it("needs a token", async () => {
    expect((await request.get(CUSTOMERS)).status).toBe(401);
  });
});
