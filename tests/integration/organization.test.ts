/**
 * Purpose: Integration tests for the tenant-side organization endpoints (/api/v1/organization):
 * profile read, legal name / TRN / settings updates, RBAC, the single-currency rule linking the
 * organization's currency to its stores' countries, and tax-rate seeding at signup.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { TaxRate } from "../../src/models/taxRate.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";

const BASE = "/api/v1/organization";

async function createOrg(slug: string, currency = "BHD") {
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
  const role = (slugName: string) => roles.find((r) => r.slug === slugName)!;
  return { org, role };
}

async function createUser(
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
  return generateAccessToken({
    userId: user._id.toString(),
    organizationId: String(orgId),
    isSuperAdmin: false,
  });
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const storeBody = (code: string, countryCode: string) => ({
  name: `Store ${code}`,
  code,
  address: { line1: "Road 1", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
  countryCode,
  timezone: "Asia/Bahrain",
});

describe("Organization profile and settings", () => {
  let orgId: unknown;
  let roleOf: (slug: string) => { _id: unknown };
  let admin: string;

  beforeEach(async () => {
    const { org, role } = await createOrg("alnoor");
    orgId = org._id;
    roleOf = role;
    admin = await createUser(org._id, "admin@alnoor.test", { orgRoleId: role("org_admin")._id });
  });

  describe("GET /organization", () => {
    it("returns the profile with currency details for formatting money", async () => {
      const res = await request.get(BASE).set(auth(admin));
      expect(res.status).toBe(200);
      const organization = res.body.data.organization;
      expect(organization.slug).toBe("alnoor");
      expect(organization.settings).toEqual({
        currency: "BHD",
        timezone: "Asia/Bahrain",
        inventory: { allowNegativeStock: false },
      });
      expect(organization.currency).toEqual({ code: "BHD", name: "Bahraini Dinar", decimals: 3 });
      expect(organization.country).toEqual({ code: "BH", name: "Bahrain" });
      expect(organization.legalName).toBeNull();
      expect(organization.taxRegistrationNumber).toBeNull();
      // Internal approval fields are not exposed here
      expect(organization.applicantEmail).toBeUndefined();
      expect(organization.approvedBy).toBeUndefined();
    });

    it("is readable by store staff (a cashier needs the currency too)", async () => {
      const store = await Store.create({ ...storeBody("S1", "BH"), organizationId: orgId });
      const cashier = await createUser(orgId, "c@alnoor.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("cashier")._id }],
      });
      const res = await request.get(BASE).set(auth(cashier));
      expect(res.status).toBe(200);
      expect(res.body.data.organization.currency.decimals).toBe(3);
    });

    it("returns 401 without a token", async () => {
      await request.get(BASE).expect(401);
    });

    it("returns each caller their own organization only", async () => {
      const other = await createOrg("other", "AED");
      const otherAdmin = await createUser(other.org._id, "a@other.test", {
        orgRoleId: other.role("org_admin")._id,
      });
      const res = await request.get(BASE).set(auth(otherAdmin));
      expect(res.body.data.organization.slug).toBe("other");
      expect(res.body.data.organization.currency.decimals).toBe(2);
    });
  });

  describe("PATCH /organization", () => {
    it("sets legal name and TRN, normalising the TRN", async () => {
      const res = await request
        .patch(BASE)
        .set(auth(admin))
        .send({ legalName: "Al Noor Trading W.L.L.", taxRegistrationNumber: " 2200-0012 3400 002 " });
      expect(res.status).toBe(200);
      expect(res.body.data.organization.legalName).toBe("Al Noor Trading W.L.L.");
      expect(res.body.data.organization.taxRegistrationNumber).toBe("220000123400002");
    });

    it("clears legal name and TRN with null", async () => {
      await request.patch(BASE).set(auth(admin)).send({ legalName: "X", taxRegistrationNumber: "12345" });
      const res = await request
        .patch(BASE)
        .set(auth(admin))
        .send({ legalName: null, taxRegistrationNumber: null });
      expect(res.status).toBe(200);
      expect(res.body.data.organization.legalName).toBeNull();
      expect(res.body.data.organization.taxRegistrationNumber).toBeNull();
    });

    it("updates timezone and the negative-stock setting without touching other settings", async () => {
      const res = await request
        .patch(BASE)
        .set(auth(admin))
        .send({ settings: { timezone: "Asia/Dubai", inventory: { allowNegativeStock: true } } });
      expect(res.status).toBe(200);
      expect(res.body.data.organization.settings).toEqual({
        currency: "BHD",
        timezone: "Asia/Dubai",
        inventory: { allowNegativeStock: true },
      });
    });

    it("rejects an invalid TRN, timezone, currency, unknown fields and an empty body", async () => {
      const bad = [
        { taxRegistrationNumber: "12" },
        { taxRegistrationNumber: "ABC!@#123" },
        { settings: { timezone: "Mars/Base" } },
        { settings: { currency: "USD" } },
        { name: "Renamed" },
        { settings: { locale: "ar" } },
        {},
      ];
      for (const body of bad) {
        const res = await request.patch(BASE).set(auth(admin)).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe("VALIDATION_FAILED");
      }
    });

    it("changes the currency when no store is in a country using another one", async () => {
      // A legacy store without countryCode does not block the change
      await Store.create({ ...storeBody("OLD", "BH"), countryCode: undefined, organizationId: orgId });
      const res = await request.patch(BASE).set(auth(admin)).send({ settings: { currency: "aed" } });
      expect(res.status).toBe(200);
      expect(res.body.data.organization.currency).toMatchObject({ code: "AED", decimals: 2 });
      expect(res.body.data.organization.country.code).toBe("AE");
    });

    it("refuses a currency change while a store is in a country using the old currency", async () => {
      const store = await Store.create({ ...storeBody("MANAMA", "BH"), organizationId: orgId });
      const res = await request.patch(BASE).set(auth(admin)).send({ settings: { currency: "AED" } });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("CURRENCY_STORE_MISMATCH");
      expect(res.body.errors[0].meta).toEqual({
        storeId: store._id.toString(),
        storeCode: "MANAMA",
        countryCode: "BH",
      });
      const org = await Organization.findById(orgId);
      expect(org!.settings.currency).toBe("BHD");
    });

    it("is refused for store staff and for an org-level role without organization:configure", async () => {
      const store = await Store.create({ ...storeBody("S1", "BH"), organizationId: orgId });
      const manager = await createUser(orgId, "m@alnoor.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("store_manager")._id }],
      });
      const accountant = await createUser(orgId, "acc@alnoor.test", {
        orgRoleId: roleOf("accountant")._id,
      });
      await request.patch(BASE).set(auth(manager)).send({ legalName: "X" }).expect(403);
      await request.patch(BASE).set(auth(accountant)).send({ legalName: "X" }).expect(403);
    });
  });
});

describe("Store country must use the organization's currency", () => {
  let admin: string;

  beforeEach(async () => {
    const { org, role } = await createOrg("alnoor");
    admin = await createUser(org._id, "admin@alnoor.test", { orgRoleId: role("org_admin")._id });
  });

  it("creates a store in a matching country", async () => {
    const res = await request.post("/api/v1/stores").set(auth(admin)).send(storeBody("BH1", "bh"));
    expect(res.status).toBe(201);
    expect(res.body.data.store.countryCode).toBe("BH");
  });

  it("rejects a store in a country with another currency", async () => {
    const res = await request.post("/api/v1/stores").set(auth(admin)).send(storeBody("DXB", "AE"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("STORE_COUNTRY_CURRENCY_MISMATCH");
    expect(res.body.errors[0]).toMatchObject({
      field: "countryCode",
      meta: { countryCode: "AE", organizationCurrency: "BHD" },
    });
  });

  it("requires countryCode on create and rejects unsupported countries", async () => {
    const { countryCode: _omit, ...withoutCountry } = storeBody("X1", "BH");
    await request.post("/api/v1/stores").set(auth(admin)).send(withoutCountry).expect(400);
    await request.post("/api/v1/stores").set(auth(admin)).send(storeBody("X2", "US")).expect(400);
  });

  it("checks the country on update too, and lets a legacy store set one", async () => {
    const created = await request.post("/api/v1/stores").set(auth(admin)).send(storeBody("BH1", "BH"));
    const storeId = created.body.data.store._id;

    const bad = await request.patch(`/api/v1/stores/${storeId}`).set(auth(admin)).send({ countryCode: "SA" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("STORE_COUNTRY_CURRENCY_MISMATCH");

    await Store.updateOne({ _id: storeId }, { $unset: { countryCode: 1 } });
    const ok = await request.patch(`/api/v1/stores/${storeId}`).set(auth(admin)).send({ countryCode: "BH" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.store.countryCode).toBe("BH");
  });
});

describe("Signup currency and tax-rate seeding", () => {
  const signupBody = (email: string, currency?: string) => ({
    organizationName: `Org ${email}`,
    contactPhone: "+973 1234 5678",
    adminFirstName: "A",
    adminLastName: "B",
    adminEmail: email,
    adminPassword: "S3cure!Passw0rd",
    ...(currency && { currency }),
  });

  it("defaults to BHD and seeds VAT 10% as the default rate", async () => {
    const res = await request.post("/api/v1/auth/signup").send(signupBody("a@bh.test"));
    expect(res.status).toBe(201);
    const org = await Organization.findOne({ applicantEmail: "a@bh.test" });
    expect(org!.settings.currency).toBe("BHD");

    const rates = await TaxRate.find({ organizationId: org!._id });
    expect(rates).toHaveLength(1);
    expect(rates[0]).toMatchObject({ name: "VAT 10%", rate: 10, isDefault: true, isActive: true });
  });

  it("seeds the country's rate for the chosen currency (AED -> 5%)", async () => {
    await request.post("/api/v1/auth/signup").send(signupBody("a@ae.test", "aed")).expect(201);
    const org = await Organization.findOne({ applicantEmail: "a@ae.test" });
    expect(org!.settings.currency).toBe("AED");
    const rates = await TaxRate.find({ organizationId: org!._id });
    expect(rates.map((r) => r.rate)).toEqual([5]);
  });

  it("seeds no rate for a country without VAT (KWD)", async () => {
    await request.post("/api/v1/auth/signup").send(signupBody("a@kw.test", "KWD")).expect(201);
    const org = await Organization.findOne({ applicantEmail: "a@kw.test" });
    expect(await TaxRate.countDocuments({ organizationId: org!._id })).toBe(0);
  });

  it("rejects an unsupported currency", async () => {
    const res = await request.post("/api/v1/auth/signup").send(signupBody("a@us.test", "USD"));
    expect(res.status).toBe(400);
    expect(await Organization.countDocuments({ applicantEmail: "a@us.test" })).toBe(0);
  });
});
