/**
 * Purpose: Phase 4a-1 contract wiring that the validator unit tests cannot see: the new store,
 * organization and product fields are refused with 400 (not silently dropped) until the 4a-1
 * implementation, requests without them keep working, and the Swagger document shows them.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { singleExample } from "../../src/docs/product.openapi";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let admin: string;
let storeId: string;

beforeEach(async () => {
  const org = await Organization.create({
    name: "preview",
    slug: "preview",
    contactEmail: "owner@preview.test",
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency: "BHD", timezone: "Asia/Bahrain" },
  });
  await seedDefaultRolesForOrganization(org._id);
  await seedDefaultTaxRates(org._id, "BHD");
  const orgAdmin = await Role.findOne({ organizationId: org._id, slug: "org_admin" });
  const user = await User.create({
    organizationId: org._id,
    email: "admin@preview.test",
    passwordHash: "SecurePassword123",
    firstName: "Test",
    lastName: "Admin",
    isActive: true,
    orgRoleId: orgAdmin!._id,
  });
  admin = generateAccessToken({ userId: user._id.toString(), organizationId: org._id.toString(), isSuperAdmin: false });
  const store = await Store.create({
    organizationId: org._id,
    name: "Seef",
    code: "SEEF-1",
    address: { line1: "Road 1", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
    countryCode: "BH",
    timezone: "Asia/Bahrain",
  });
  storeId = store._id.toString();
});

const refused = (res: { status: number; body: { code: string; errors: { field: string; message: string }[] } }, field: string) => {
  expect([res.status, res.body.code, res.body.errors[0].field]).toEqual([400, "VALIDATION_FAILED", field]);
  expect(res.body.errors[0].message).toMatch(/Phase 4a-1 implementation/);
};

const newStore = {
  name: "Juffair",
  code: "JUF-1",
  address: { line1: "Road 2", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "324" },
  countryCode: "BH",
  timezone: "Asia/Bahrain",
};

describe("Phase 4a-1 fields are refused until implemented", () => {
  it("stores: every new field on create and update", async () => {
    refused(await request.post("/api/v1/stores").set(auth(admin)).send({ ...newStore, invoicePrefix: "JUF" }), "invoicePrefix");
    refused(await request.post("/api/v1/stores").set(auth(admin)).send({ ...newStore, taxRegistrationNumber: "220000123400002" }), "taxRegistrationNumber");
    const patch = (body: Record<string, unknown>) => request.patch(`/api/v1/stores/${storeId}`).set(auth(admin)).send(body);
    refused(await patch({ legalName: "Al Noor - Seef" }), "legalName");
    refused(await patch({ legalNameAr: "النور" }), "legalNameAr");
    refused(await patch({ phone: "+973 1700 0001" }), "phone");
    refused(await patch({ email: "seef@alnoor.bh" }), "email");
    refused(await patch({ receipt: { footerText: "Thank you" } }), "receipt");
    expect((await Store.findById(storeId))!.toObject()).not.toHaveProperty("legalName");
  });

  it("stores: requests without the new fields still work", async () => {
    expect((await request.post("/api/v1/stores").set(auth(admin)).send(newStore)).status).toBe(201);
    expect((await request.patch(`/api/v1/stores/${storeId}`).set(auth(admin)).send({ name: "Seef Mall" })).status).toBe(200);
  });

  it("organization: Arabic name, fiscal year and the sales settings", async () => {
    const patch = (body: Record<string, unknown>) => request.patch("/api/v1/organization").set(auth(admin)).send(body);
    refused(await patch({ legalNameAr: "شركة النور" }), "legalNameAr");
    refused(await patch({ settings: { fiscalYearStartMonth: 4 } }), "settings.fiscalYearStartMonth");
    refused(await patch({ settings: { sales: { paymentMethods: ["cash", "card"] } } }), "settings.sales.paymentMethods");
    refused(await patch({ settings: { sales: { cashRounding: "0.005" } } }), "settings.sales.cashRounding");
    refused(await patch({ settings: { sales: { maxDiscountPercent: 10 } } }), "settings.sales.maxDiscountPercent");
    const ok = await patch({ settings: { sales: { pricesIncludeTax: false } } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.organization.currency).toEqual({ code: "BHD", name: "Bahraini Dinar", decimals: 3 });
  });

  it("products: nameAr and hsnOrSac on create and update", async () => {
    const goods = { ...singleExample, categoryId: undefined, taxRateId: undefined, barcodes: undefined };
    refused(await request.post("/api/v1/products").set(auth(admin)).send({ ...goods, hsnOrSac: "61091000" }), "hsnOrSac");
    const created = await request.post("/api/v1/products").set(auth(admin)).send(goods);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.product.id;
    refused(await request.patch(`/api/v1/products/${id}`).set(auth(admin)).send({ nameAr: "تيشيرت" }), "nameAr");
  });
});

describe("OpenAPI document", () => {
  it("shows the Phase 4a-1 request and response fields", async () => {
    const res = await request.get("/api-docs.json");
    expect(res.status).toBe(200);
    const schemas = res.body.components.schemas;
    const props = (name: string) => Object.keys(schemas[name].properties);
    expect(props("Store")).toEqual(expect.arrayContaining(["legalName", "legalNameAr", "taxRegistrationNumber", "effective", "phone", "email", "invoicePrefix", "receipt"]));
    expect(props("OrganizationProfile")).toEqual(expect.arrayContaining(["legalNameAr", "cashRoundingSteps"]));
    expect(Object.keys(schemas.OrganizationProfile.properties.settings.properties.sales.properties)).toEqual(
      expect.arrayContaining(["paymentMethods", "cashRounding", "maxDiscountPercent"])
    );
    expect(props("Product")).toEqual(expect.arrayContaining(["nameAr", "hsnOrSac"]));

    const storePath = Object.keys(res.body.paths).find((path) => path.endsWith("/v1/stores"))!;
    const createBody = JSON.stringify(res.body.paths[storePath].post.requestBody);
    for (const field of ["invoicePrefix", "taxRegistrationNumber", "legalNameAr", "receipt", "stateCode"]) expect(createBody).toContain(field);
    expect(res.body.paths[storePath].post.description).toContain("Phase 4a-1");
  });
});
