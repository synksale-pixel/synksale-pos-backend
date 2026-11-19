/**
 * Purpose: Phase 4a-1 implementation: store receipt identity (own TRN/GSTIN, invoice prefix,
 * receipt texts, India state codes, `effective` values), organization sales settings (fiscal year,
 * payment methods, cash rounding, discount cap), product nameAr/hsnOrSac, per-store yearly sale
 * counters and the data migration. Rules with no database are in tests/unit/phase4a1Validator.test.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { DocumentCounter } from "../../src/models/documentCounter.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { nextDocumentNumber } from "../../src/services/documentNumber.service";
import { migratePhase4a1 } from "../../src/services/phase4a1Migration.service";
import { gstinCheckCharacter } from "../../src/utils/taxId";
import { singleExample, serviceExample } from "../../src/docs/product.openapi";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const gstin = (state: string, pan = "ABCDE1234F") => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const BH_TRN = "220000123400002";

async function makeOrg(slug: string, currency: string, extra: Record<string, unknown> = {}) {
  const org = await Organization.create({
    name: `${slug} Trading`,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency, timezone: currency === "INR" ? "Asia/Kolkata" : "Asia/Bahrain" },
    ...extra,
  });
  await seedDefaultRolesForOrganization(org._id);
  await seedDefaultTaxRates(org._id, currency);
  const orgAdmin = await Role.findOne({ organizationId: org._id, slug: "org_admin" });
  const user = await User.create({
    organizationId: org._id,
    email: `admin@${slug}.test`,
    passwordHash: "SecurePassword123",
    firstName: "Test",
    lastName: "Admin",
    isActive: true,
    orgRoleId: orgAdmin!._id,
  });
  const token = generateAccessToken({ userId: user._id.toString(), organizationId: org._id.toString(), isSuperAdmin: false });
  return { org, token };
}

const bhStore = (code: string, extra: Record<string, unknown> = {}) => ({
  name: code,
  code,
  address: { line1: "Road 2", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "324" },
  countryCode: "BH",
  timezone: "Asia/Bahrain",
  ...extra,
});

const inStore = (code: string, stateCode: string | undefined, extra: Record<string, unknown> = {}) => ({
  name: code,
  code,
  address: { line1: "12 MG Road", city: "Bengaluru", state: "Karnataka", country: "India", postalCode: "560001", stateCode },
  countryCode: "IN",
  timezone: "Asia/Kolkata",
  ...extra,
});

const fieldError = (res: { status: number; body: { code: string; errors: { field: string }[] } }) => [
  res.status,
  res.body.code,
  res.body.errors?.[0]?.field,
];

let admin: string;
let orgId: mongoose.Types.ObjectId;
let storeId: string;
const STORES = "/api/v1/stores";
const ORG = "/api/v1/organization";

beforeEach(async () => {
  const made = await makeOrg("alnoor", "BHD");
  admin = made.token;
  orgId = made.org._id;
  const res = await request.post(STORES).set(auth(admin)).send(bhStore("SEEF-1"));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  storeId = res.body.data.store._id;
});

describe("stores: receipt identity", () => {
  it("returns every new field (null when unset) and effective values from the organization", async () => {
    const store = (await request.get(`${STORES}/${storeId}`).set(auth(admin))).body.data.store;
    expect(store).toMatchObject({
      legalName: null,
      legalNameAr: null,
      taxRegistrationNumber: null,
      phone: null,
      email: null,
      invoicePrefix: null,
      receipt: { headerText: null, footerText: null },
      address: { stateCode: null },
      // No legal name anywhere: the organization's name.
      effective: { legalName: "alnoor Trading", legalNameAr: null, taxRegistrationNumber: null },
    });

    await request.patch(ORG).set(auth(admin)).send({ legalName: "Al Noor W.L.L.", legalNameAr: "النور", taxRegistrationNumber: BH_TRN }).expect(200);
    const list = (await request.get(STORES).set(auth(admin))).body.data.stores;
    expect(list[0].effective).toEqual({ legalName: "Al Noor W.L.L.", legalNameAr: "النور", taxRegistrationNumber: BH_TRN });
  });

  it("stores and clears the store's own values, which win over the organization's", async () => {
    await request.patch(ORG).set(auth(admin)).send({ legalName: "Al Noor W.L.L.", taxRegistrationNumber: BH_TRN }).expect(200);
    const own = "220000999900001";
    const res = await request
      .patch(`${STORES}/${storeId}`)
      .set(auth(admin))
      .send({
        legalName: "Al Noor - Seef",
        taxRegistrationNumber: "2200-0099 9900001",
        phone: "+973 1700 0001",
        email: "Seef@AlNoor.bh",
        invoicePrefix: "seef",
        receipt: { headerText: "Welcome", footerText: "Thank you" },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.store).toMatchObject({
      legalName: "Al Noor - Seef",
      taxRegistrationNumber: own,
      email: "seef@alnoor.bh",
      invoicePrefix: "SEEF",
      receipt: { headerText: "Welcome", footerText: "Thank you" },
      effective: { legalName: "Al Noor - Seef", taxRegistrationNumber: own },
    });

    // receipt is partial; null clears a field and falls back to the organization's value
    const cleared = await request
      .patch(`${STORES}/${storeId}`)
      .set(auth(admin))
      .send({ receipt: { headerText: null }, taxRegistrationNumber: null });
    expect(cleared.body.data.store.receipt).toEqual({ headerText: null, footerText: "Thank you" });
    expect(cleared.body.data.store.effective.taxRegistrationNumber).toBe(BH_TRN);
  });

  it("checks the store's TRN against its stored country", async () => {
    // The body has no countryCode, so only the service knows the store is in Bahrain.
    const res = await request.patch(`${STORES}/${storeId}`).set(auth(admin)).send({ taxRegistrationNumber: "ABC12345" });
    expect(fieldError(res)).toEqual([400, "VALIDATION_FAILED", "taxRegistrationNumber"]);
    expect(res.body.errors[0].message).toMatch(/15 digits/);
  });

  it("invoicePrefix is unique in the organization and fixed once the store has a sale", async () => {
    await request.patch(`${STORES}/${storeId}`).set(auth(admin)).send({ invoicePrefix: "SEEF" }).expect(200);
    // Sending the same prefix again is not a change.
    await request.patch(`${STORES}/${storeId}`).set(auth(admin)).send({ invoicePrefix: "seef" }).expect(200);

    const taken = await request.post(STORES).set(auth(admin)).send(bhStore("JUF-1", { invoicePrefix: "Seef" }));
    expect(fieldError(taken)).toEqual([409, "INVOICE_PREFIX_TAKEN", "invoicePrefix"]);
    const other = await request.post(STORES).set(auth(admin)).send(bhStore("JUF-1", { invoicePrefix: "JUF" }));
    expect(other.status).toBe(201);
    const takenOnUpdate = await request.patch(`${STORES}/${other.body.data.store._id}`).set(auth(admin)).send({ invoicePrefix: "SEEF" });
    expect(fieldError(takenOnUpdate)).toEqual([409, "INVOICE_PREFIX_TAKEN", "invoicePrefix"]);

    // Another organization may use the same prefix.
    const b = await makeOrg("bravo", "BHD");
    expect((await request.post(STORES).set(auth(b.token)).send(bhStore("B-1", { invoicePrefix: "SEEF" }))).status).toBe(201);

    // Before any sale it can change; after the first sale number it cannot.
    await request.patch(`${STORES}/${storeId}`).set(auth(admin)).send({ invoicePrefix: "SEEF2" }).expect(200);
    await DocumentCounter.create({ organizationId: orgId, type: "sale_invoice", storeId, fiscalYear: 2026, seq: 1 });
    const locked = await request.patch(`${STORES}/${storeId}`).set(auth(admin)).send({ invoicePrefix: "SEEF3" });
    expect(fieldError(locked)).toEqual([409, "INVOICE_PREFIX_LOCKED", "invoicePrefix"]);
    // A store without sales is unaffected.
    await request.patch(`${STORES}/${other.body.data.store._id}`).set(auth(admin)).send({ invoicePrefix: "JUF2" }).expect(200);
  });

  it("the unique index catches two stores racing for one prefix", async () => {
    const results = await Promise.all(
      ["R-1", "R-2", "R-3"].map((code) => request.post(STORES).set(auth(admin)).send(bhStore(code, { invoicePrefix: "RACE" })))
    );
    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409]);
    for (const res of results.filter((r) => r.status === 409)) expect(res.body.code).toBe("INVOICE_PREFIX_TAKEN");
  });
});

describe("stores in India", () => {
  let token: string;
  let inOrgId: mongoose.Types.ObjectId;
  beforeEach(async () => {
    const made = await makeOrg("sharma", "INR", { taxRegistrationNumber: gstin("29") });
    token = made.token;
    inOrgId = made.org._id;
  });

  it("needs a GST state code, and uses the organization's GSTIN only in its own state", async () => {
    const missing = await request.post(STORES).set(auth(token)).send(inStore("BLR-1", undefined));
    expect(fieldError(missing)).toEqual([400, "VALIDATION_FAILED", "address.stateCode"]);

    const blr = await request.post(STORES).set(auth(token)).send(inStore("BLR-1", "29"));
    expect(blr.status, JSON.stringify(blr.body)).toBe(201);
    expect(blr.body.data.store.address.stateCode).toBe("29");
    expect(blr.body.data.store.effective.taxRegistrationNumber).toBe(gstin("29"));

    // Mumbai (27) cannot print the Karnataka GSTIN...
    const mum = await request.post(STORES).set(auth(token)).send(inStore("MUM-1", "27"));
    expect(fieldError(mum)).toEqual([400, "VALIDATION_FAILED", "taxRegistrationNumber"]);
    expect(mum.body.errors[0].message).toMatch(/GSTIN is per state/);
    // ...so it brings its own, which must start with 27.
    const wrong = await request.post(STORES).set(auth(token)).send(inStore("MUM-1", "27", { taxRegistrationNumber: gstin("29", "ZZZZZ9999Z") }));
    expect(fieldError(wrong)).toEqual([400, "VALIDATION_FAILED", "taxRegistrationNumber"]);
    const ok = await request.post(STORES).set(auth(token)).send(inStore("MUM-1", "27", { taxRegistrationNumber: gstin("27") }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.store.effective.taxRegistrationNumber).toBe(gstin("27"));

    // Moving Bengaluru's store code to another state without a GSTIN is refused too.
    const moved = await request.patch(`${STORES}/${blr.body.data.store._id}`).set(auth(token)).send({ address: { stateCode: "32" } });
    expect(fieldError(moved)).toEqual([400, "VALIDATION_FAILED", "taxRegistrationNumber"]);
  });

  it("an organization GSTIN change is refused while a store in another state relies on it", async () => {
    await request.post(STORES).set(auth(token)).send(inStore("BLR-1", "29")).expect(201);
    const res = await request.patch(ORG).set(auth(token)).send({ taxRegistrationNumber: gstin("27") });
    expect(fieldError(res)).toEqual([400, "VALIDATION_FAILED", "taxRegistrationNumber"]);
    expect(res.body.errors[0].message).toMatch(/BLR-1 \(29\)/);
    // A bad check character is caught before that.
    const typo = await request.patch(ORG).set(auth(token)).send({ taxRegistrationNumber: "29ABCDE1234F1ZX" });
    expect(typo.body.errors[0].message).toMatch(/check character/);
  });

  it("an older Indian store without a state code must get one on its next update", async () => {
    const legacy = await Store.create({
      organizationId: inOrgId,
      name: "Old",
      code: "OLD-1",
      address: { line1: "1", city: "Kochi", state: "Kerala", country: "India", postalCode: "682001" },
      countryCode: "IN",
      timezone: "Asia/Kolkata",
    });
    const res = await request.patch(`${STORES}/${legacy._id}`).set(auth(token)).send({ name: "Old Store" });
    expect(fieldError(res)).toEqual([400, "VALIDATION_FAILED", "address.stateCode"]);
    // Kerala (32) needs its own GSTIN, since the organization's is Karnataka's.
    const fixed = await request
      .patch(`${STORES}/${legacy._id}`)
      .set(auth(token))
      .send({ name: "Old Store", address: { stateCode: "32" }, taxRegistrationNumber: gstin("32") });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
  });
});

describe("organization sales settings", () => {
  it("returns the defaults and the currency's rounding steps", async () => {
    const profile = (await request.get(ORG).set(auth(admin))).body.data.organization;
    expect(profile.legalNameAr).toBeNull();
    expect(profile.settings.fiscalYearStartMonth).toBe(1);
    expect(profile.settings.sales).toEqual({
      pricesIncludeTax: true,
      paymentMethods: ["cash", "card", "wallet", "bank_transfer"],
      cashRounding: null,
      maxDiscountPercent: null,
    });
    expect(profile.cashRoundingSteps).toEqual(["0.005", "0.010", "0.050", "0.100"]);
    expect(profile.currency).toEqual({ code: "BHD", name: "Bahraini Dinar", decimals: 3 });
  });

  it("stores the Arabic name, fiscal year, methods (in fixed order), rounding step and discount cap", async () => {
    const res = await request
      .patch(ORG)
      .set(auth(admin))
      .send({
        legalNameAr: "شركة النور",
        settings: {
          fiscalYearStartMonth: 4,
          sales: { paymentMethods: ["wallet", "cash"], cashRounding: "0.1", maxDiscountPercent: 12.5 },
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const organization = res.body.data.organization;
    expect(organization.legalNameAr).toBe("شركة النور");
    expect(organization.settings.fiscalYearStartMonth).toBe(4);
    expect(organization.settings.sales).toMatchObject({
      paymentMethods: ["cash", "wallet"],
      cashRounding: "0.100",
      maxDiscountPercent: 12.5,
    });

    const off = await request.patch(ORG).set(auth(admin)).send({ settings: { sales: { cashRounding: null, maxDiscountPercent: null } } });
    expect(off.body.data.organization.settings.sales).toMatchObject({ cashRounding: null, maxDiscountPercent: null, paymentMethods: ["cash", "wallet"] });
  });

  it("refuses a rounding step the currency does not allow", async () => {
    const res = await request.patch(ORG).set(auth(admin)).send({ settings: { sales: { cashRounding: "0.25" } } });
    expect(fieldError(res)).toEqual([400, "VALIDATION_FAILED", "settings.sales.cashRounding"]);
    expect(res.body.errors[0].message).toMatch(/0\.005, 0\.010, 0\.050, 0\.100/);
  });

  it("checks the TRN against the currency's country", async () => {
    const res = await request.patch(ORG).set(auth(admin)).send({ taxRegistrationNumber: "ABC12345" });
    expect(fieldError(res)).toEqual([400, "VALIDATION_FAILED", "taxRegistrationNumber"]);
    await request.patch(ORG).set(auth(admin)).send({ taxRegistrationNumber: BH_TRN }).expect(200);
  });

  it("the fiscal year is fixed once a store has made a sale", async () => {
    await request.patch(ORG).set(auth(admin)).send({ settings: { fiscalYearStartMonth: 7 } }).expect(200);
    await DocumentCounter.create({ organizationId: orgId, type: "sale_credit_note", storeId, fiscalYear: 2026, seq: 1 });
    const res = await request.patch(ORG).set(auth(admin)).send({ settings: { fiscalYearStartMonth: 1 } });
    expect(fieldError(res)).toEqual([409, "FISCAL_YEAR_LOCKED", "settings.fiscalYearStartMonth"]);
    // Sending the current value is not a change.
    await request.patch(ORG).set(auth(admin)).send({ settings: { fiscalYearStartMonth: 7 } }).expect(200);
  });

  it("a currency change brings the new country's fiscal year and drops a rounding step it does not allow", async () => {
    const fresh = await makeOrg("fresh", "BHD");
    await request.patch(ORG).set(auth(fresh.token)).send({ settings: { sales: { cashRounding: "0.050" } } }).expect(200);
    const res = await request.patch(ORG).set(auth(fresh.token)).send({ settings: { currency: "INR" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.organization.settings.fiscalYearStartMonth).toBe(4);
    expect(res.body.data.organization.settings.sales.cashRounding).toBeNull();
    expect(res.body.data.organization.cashRoundingSteps).toEqual(["0.50", "1.00"]);
  });
});

describe("products: nameAr and hsnOrSac", () => {
  const goods = { ...singleExample, categoryId: undefined, taxRateId: undefined, barcodes: undefined };

  it("are stored, returned and cleared", async () => {
    const created = await request.post("/api/v1/products").set(auth(admin)).send({ ...goods, nameAr: "قهوة عربية", hsnOrSac: "09012100" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.product).toMatchObject({ nameAr: "قهوة عربية", hsnOrSac: "09012100" });
    const id = created.body.data.product.id;

    const cleared = await request.patch(`/api/v1/products/${id}`).set(auth(admin)).send({ nameAr: null, hsnOrSac: null });
    expect(cleared.body.data.product).toMatchObject({ nameAr: null, hsnOrSac: null });
  });

  it("an update checks the code against the stored type", async () => {
    const product = (await request.post("/api/v1/products").set(auth(admin)).send(goods)).body.data.product;
    const sac = await request.patch(`/api/v1/products/${product.id}`).set(auth(admin)).send({ hsnOrSac: "998313" });
    expect(fieldError(sac)).toEqual([400, "VALIDATION_FAILED", "hsnOrSac"]);

    const service = (await request.post("/api/v1/products").set(auth(admin)).send(serviceExample)).body.data.product;
    const hsn = await request.patch(`/api/v1/products/${service.id}`).set(auth(admin)).send({ hsnOrSac: "0901" });
    expect(fieldError(hsn)).toEqual([400, "VALIDATION_FAILED", "hsnOrSac"]);
    await request.patch(`/api/v1/products/${service.id}`).set(auth(admin)).send({ hsnOrSac: "998313" }).expect(200);
  });
});

describe("document counters", () => {
  const take = (key: Parameters<typeof nextDocumentNumber>[0]) =>
    mongoose.connection.transaction((session) => nextDocumentNumber(key, session)).then(() =>
      DocumentCounter.findOne({
        organizationId: key.organizationId,
        type: key.type,
        storeId: key.storeId ?? null,
        fiscalYear: key.fiscalYear ?? null,
      })
    );

  it("sale series count per store and fiscal year; organization series are untouched", async () => {
    const otherStore = new mongoose.Types.ObjectId();
    expect((await take({ organizationId: orgId, type: "sale_invoice", storeId, fiscalYear: 2026 }))!.seq).toBe(1);
    expect((await take({ organizationId: orgId, type: "sale_invoice", storeId, fiscalYear: 2026 }))!.seq).toBe(2);
    expect((await take({ organizationId: orgId, type: "sale_invoice", storeId, fiscalYear: 2027 }))!.seq).toBe(1);
    expect((await take({ organizationId: orgId, type: "sale_invoice", storeId: otherStore, fiscalYear: 2026 }))!.seq).toBe(1);
    expect((await take({ organizationId: orgId, type: "sale_credit_note", storeId, fiscalYear: 2026 }))!.seq).toBe(1);
    expect((await take({ organizationId: orgId, type: "purchase_order" }))!.seq).toBe(1);
  });

  it("a counter saved before storeId/fiscalYear existed carries on its sequence", async () => {
    await DocumentCounter.collection.insertOne({ organizationId: orgId, type: "bill", seq: 41 });
    expect((await take({ organizationId: orgId, type: "bill" }))!.seq).toBe(42);
    expect(await DocumentCounter.countDocuments({ organizationId: orgId, type: "bill" })).toBe(1);
  });
});

describe("Phase 4a-1 migration", () => {
  it("stores sales defaults on older organizations and works out Indian store state codes", async () => {
    const { org } = await makeOrg("legacy-in", "INR", { taxRegistrationNumber: gstin("29") });
    await Organization.collection.updateOne(
      { _id: org._id as never },
      { $unset: { "settings.fiscalYearStartMonth": "", "settings.sales.paymentMethods": "" } }
    );
    const noGstin = await makeOrg("legacy-in2", "INR");
    const address = (state: string) => ({ line1: "1", city: "X", state, country: "India", postalCode: "1" });
    const store = (organizationId: mongoose.Types.ObjectId, code: string, state: string, extra: Record<string, unknown> = {}) => ({
      organizationId,
      code,
      name: code,
      countryCode: "IN",
      timezone: "Asia/Kolkata",
      address: address(state),
      ...extra,
    });
    const [ownGstin, byName, byOrgGstin, unknown] = await Store.insertMany([
      store(org._id, "A", "Kerala", { taxRegistrationNumber: gstin("27") }), // own GSTIN wins
      store(org._id, "B", " kerala "), // the state name beats the organization's GSTIN
      store(org._id, "C", "Bangalore Urban"), // no match: the organization's GSTIN
      store(noGstin.org._id, "D", "Atlantis"), // nothing to go on
    ]);

    const result = await migratePhase4a1();
    expect(result.storesUpdated).toBe(3);
    expect(result.unresolvedStores.map((s) => s.code)).toEqual(["D"]);
    const code = async (id: mongoose.Types.ObjectId) => (await Store.findById(id))!.address.stateCode;
    expect([await code(ownGstin._id), await code(byName._id), await code(byOrgGstin._id), await code(unknown._id)]).toEqual([
      "27",
      "32",
      "29",
      null,
    ]);
    const migrated = await Organization.findById(org._id);
    expect(migrated!.settings.fiscalYearStartMonth).toBe(4);
    expect(migrated!.settings.sales.paymentMethods).toEqual(["cash", "card", "wallet", "bank_transfer"]);

    // Safe to run again.
    expect((await migratePhase4a1()).storesUpdated).toBe(0);
  });
});

describe("OpenAPI document", () => {
  it("shows the Phase 4a-1 request and response fields as always present", async () => {
    const res = await request.get("/api-docs.json");
    expect(res.status).toBe(200);
    const schemas = res.body.components.schemas;
    expect(schemas.Store.required).toEqual(
      expect.arrayContaining(["legalName", "legalNameAr", "taxRegistrationNumber", "effective", "phone", "email", "invoicePrefix", "receipt"])
    );
    expect(schemas.OrganizationProfile.required).toEqual(expect.arrayContaining(["legalNameAr", "cashRoundingSteps"]));
    expect(schemas.OrganizationProfile.properties.settings.properties.sales.required).toEqual(
      expect.arrayContaining(["paymentMethods", "cashRounding", "maxDiscountPercent"])
    );
    expect(schemas.OrganizationProfile.properties.settings.properties.sales.properties.paymentMethods.items.enum).toEqual([
      "cash",
      "card",
      "wallet",
      "bank_transfer",
    ]);
    expect(schemas.Product.required).toEqual(expect.arrayContaining(["nameAr", "hsnOrSac"]));

    const storePath = Object.keys(res.body.paths).find((path) => path.endsWith("/v1/stores"))!;
    const createBody = JSON.stringify(res.body.paths[storePath].post.requestBody);
    for (const field of ["invoicePrefix", "taxRegistrationNumber", "legalNameAr", "receipt", "stateCode"]) expect(createBody).toContain(field);
    expect(JSON.stringify(res.body)).not.toMatch(/contract preview/);
  });
});
