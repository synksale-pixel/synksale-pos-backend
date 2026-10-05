/**
 * Purpose: Gap-closing integration tests for Phase 0: concurrency on tax-rate default/name
 * rules, tenant isolation on the state-change endpoints, auth-boundary and RBAC edge cases for
 * /organization and /tax-rates, PATCH /organization edge cases, store-update ordering, signup
 * rollback, and the error response shape (`code` only when set).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { TaxRate } from "../../src/models/taxRate.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { generateSuperAdminAccessToken } from "../../src/services/platformAuth.service";

const TAX = "/api/v1/tax-rates";
const ORG = "/api/v1/organization";

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
  await seedDefaultTaxRates(org._id, currency);
  const roles = await Role.find({ organizationId: org._id });
  const role = (s: string) => roles.find((r) => r.slug === s)!;
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

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const storeBody = (code: string, countryCode: string) => ({
  name: `Store ${code}`,
  code,
  address: { line1: "Road 1", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "317" },
  countryCode,
  timezone: "Asia/Bahrain",
});

describe("Phase 0 hardening", () => {
  let orgId: unknown;
  let roleOf: (s: string) => { _id: unknown };
  let admin: string;
  let seededId: string;

  beforeEach(async () => {
    await TaxRate.init();
    const { org, role } = await createOrg("alnoor");
    orgId = org._id;
    roleOf = role;
    admin = await createUser(org._id, "admin@alnoor.test", { orgRoleId: role("org_admin")._id });
    seededId = (await TaxRate.findOne({ organizationId: org._id }))!._id.toString();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mkRate = (name: string, rate = 1) =>
    request.post(TAX).set(auth(admin)).send({ name, components: [{ name: "VAT", rate }] });

  describe("tax-rate concurrency", () => {
    it("concurrent set-default calls never 500 and leave exactly one default", async () => {
      const a = (await mkRate("A")).body.data.taxRate._id;
      const b = (await mkRate("B", 2)).body.data.taxRate._id;
      const c = (await mkRate("C", 3)).body.data.taxRate._id;

      const results = await Promise.all(
        [a, b, c, a, b, c].map((id) => request.patch(`${TAX}/${id}/default`).set(auth(admin)))
      );
      for (const res of results) expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
      expect(await TaxRate.countDocuments({ organizationId: orgId, isDefault: true })).toBe(1);
    });

    it("concurrent create-with-isDefault never 500 and leaves exactly one default", async () => {
      const results = await Promise.all(
        ["N1", "N2", "N3", "N4"].map((name) =>
          request.post(TAX).set(auth(admin)).send({ name, components: [{ name: "VAT", rate: 1 }], isDefault: true })
        )
      );
      for (const res of results) expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
      expect(await TaxRate.countDocuments({ organizationId: orgId, isDefault: true })).toBe(1);
    });

    it("concurrent creates with the same name give one 201 and 409s, never 500", async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => mkRate("Same Name")));
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.every((s) => s === 201 || s === 409), JSON.stringify(statuses)).toBe(true);
      expect(await TaxRate.countDocuments({ organizationId: orgId, nameKey: "same name" })).toBe(1);
    });

    it("concurrent renames to the same name give one 200 and 409s, never 500", async () => {
      const a = (await mkRate("A")).body.data.taxRate._id;
      const b = (await mkRate("B")).body.data.taxRate._id;
      const results = await Promise.all(
        [a, b].map((id) => request.patch(`${TAX}/${id}`).set(auth(admin)).send({ name: "Target" }))
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([200, 409]);
    });

    it("update keeps nameKey and rate derived from name and components", async () => {
      const res = await request
        .patch(`${TAX}/${seededId}`)
        .set(auth(admin))
        .send({ name: "  Mixed CASE  ", components: [{ name: "A", rate: 0.1 }, { name: "B", rate: 0.2 }] });
      expect(res.status).toBe(200);
      const doc = await TaxRate.findById(seededId);
      expect(doc!.nameKey).toBe("mixed case");
      expect(doc!.rate).toBe(0.3);
      expect(res.body.data.taxRate.nameKey).toBeUndefined();
    });
  });

  describe("tax-rate tenant isolation on state changes", () => {
    it("another org gets 404 on default, activate and deactivate of a foreign id and changes nothing", async () => {
      const other = await createOrg("other");
      const otherAdmin = await createUser(other.org._id, "a@other.test", {
        orgRoleId: other.role("org_admin")._id,
      });
      const foreign = (await mkRate("Foreign")).body.data.taxRate._id;
      for (const action of ["default", "activate", "deactivate"]) {
        const res = await request.patch(`${TAX}/${foreign}/${action}`).set(auth(otherAdmin));
        expect(res.status, action).toBe(404);
        expect(res.body.code).toBe("TAX_RATE_NOT_FOUND");
      }
      const doc = await TaxRate.findById(foreign);
      expect(doc).toMatchObject({ isDefault: false, isActive: true });
      expect(await TaxRate.countDocuments({ organizationId: other.org._id, isDefault: true })).toBe(1);
    });

    it("a soft-deleted rate cannot be read, updated, defaulted, activated or deleted again", async () => {
      const id = (await mkRate("Gone")).body.data.taxRate._id;
      await request.delete(`${TAX}/${id}`).set(auth(admin)).expect(200);
      await request.get(`${TAX}/${id}`).set(auth(admin)).expect(404);
      await request.patch(`${TAX}/${id}`).set(auth(admin)).send({ name: "X" }).expect(404);
      await request.patch(`${TAX}/${id}/default`).set(auth(admin)).expect(404);
      await request.patch(`${TAX}/${id}/activate`).set(auth(admin)).expect(404);
      await request.delete(`${TAX}/${id}`).set(auth(admin)).expect(404);
    });

    it("organizationId, isDelete and rate in the create body cannot change tenant or derived data", async () => {
      const other = await createOrg("other");
      const res = await request.post(TAX).set(auth(admin)).send({
        name: "Sneaky",
        components: [{ name: "VAT", rate: 1 }],
        organizationId: other.org._id.toString(),
        isDelete: true,
        rate: 99,
      });
      if (res.status === 201) {
        const doc = await TaxRate.findById(res.body.data.taxRate._id);
        expect(String(doc!.organizationId)).toBe(String(orgId));
        expect(doc!.rate).toBe(1);
        expect(doc!.isDelete).toBe(false);
      } else {
        expect(res.status).toBe(400);
      }
      expect(await TaxRate.countDocuments({ organizationId: other.org._id })).toBe(1);
    });
  });

  describe("auth boundary", () => {
    const platformToken = () =>
      generateSuperAdminAccessToken({ userId: new mongoose.Types.ObjectId().toString() });

    it("a platform (super admin) token is rejected on tenant tax-rate and organization routes", async () => {
      const t = platformToken();
      await request.get(TAX).set(auth(t)).expect(401);
      await request.post(TAX).set(auth(t)).send({ name: "X", components: [{ name: "V", rate: 1 }] }).expect(401);
      await request.get(ORG).set(auth(t)).expect(401);
      await request.patch(ORG).set(auth(t)).send({ legalName: "X" }).expect(401);
    });

    it("a malformed token and a missing token are 401 on tax-rate writes", async () => {
      await request.delete(`${TAX}/${seededId}`).set(auth("garbage")).expect(401);
      await request.patch(`${TAX}/${seededId}/default`).expect(401);
      await request.post(TAX).send({}).expect(401);
    });

    it("a user with no roles cannot write tax rates or the organization (403) but can read", async () => {
      const nobody = await createUser(orgId, "n@alnoor.test", {});
      await request.get(TAX).set(auth(nobody)).expect(200);
      await request.post(TAX).set(auth(nobody)).send({ name: "X", components: [{ name: "V", rate: 1 }] }).expect(403);
      await request.patch(ORG).set(auth(nobody)).send({ legalName: "X" }).expect(403);
    });

    it("a store-scoped org_admin role cannot write tax rates or the organization", async () => {
      const store = await Store.create({ ...storeBody("S1", "BH"), organizationId: orgId });
      const t = await createUser(orgId, "sa@alnoor.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("org_admin")._id }],
      });
      await request.post(TAX).set(auth(t)).send({ name: "X", components: [{ name: "V", rate: 1 }] }).expect(403);
      await request.patch(`${TAX}/${seededId}/deactivate`).set(auth(t)).expect(403);
      await request.patch(ORG).set(auth(t)).send({ legalName: "X" }).expect(403);
    });

    it("rejects organizationId smuggled into PATCH /organization", async () => {
      const other = await createOrg("other");
      const res = await request
        .patch(ORG)
        .set(auth(admin))
        .send({ legalName: "Mine", organizationId: other.org._id.toString() });
      expect(res.status).toBe(400);
      expect((await Organization.findById(other.org._id))!.legalName ?? null).toBeNull();
    });
  });

  describe("PATCH /organization edge cases", () => {
    it("settings: {} does not crash and changes nothing", async () => {
      const res = await request.patch(ORG).set(auth(admin)).send({ settings: {} });
      expect([200, 400], JSON.stringify(res.body)).toContain(res.status);
      expect((await Organization.findById(orgId))!.settings.currency).toBe("BHD");
    });

    it("same currency as current is a no-op success even when stores exist", async () => {
      await Store.create({ ...storeBody("S1", "BH"), organizationId: orgId });
      const res = await request.patch(ORG).set(auth(admin)).send({ settings: { currency: "BHD" } });
      expect(res.status).toBe(200);
      expect(res.body.data.organization.settings.currency).toBe("BHD");
    });

    it("a soft-deleted store in another country does not block a currency change", async () => {
      await Store.create({ ...storeBody("OLD", "BH"), organizationId: orgId, isDelete: true });
      const res = await request.patch(ORG).set(auth(admin)).send({ settings: { currency: "AED" } });
      expect(res.status).toBe(200);
    });

    it("another organization's stores never block this organization's currency change", async () => {
      const other = await createOrg("other");
      await Store.create({ ...storeBody("O1", "BH"), organizationId: other.org._id });
      const res = await request.patch(ORG).set(auth(admin)).send({ settings: { currency: "AED" } });
      expect(res.status).toBe(200);
      expect((await Organization.findById(other.org._id))!.settings.currency).toBe("BHD");
    });

    it("lists every mismatching store in the 409 errors", async () => {
      await Store.create({ ...storeBody("M1", "BH"), organizationId: orgId });
      await Store.create({ ...storeBody("M2", "BH"), organizationId: orgId });
      const res = await request.patch(ORG).set(auth(admin)).send({ settings: { currency: "KWD" } });
      expect(res.status).toBe(409);
      expect(res.body.errors).toHaveLength(2);
    });

    it("never exposes secrets or internal fields in the profile", async () => {
      const res = await request.get(ORG).set(auth(admin));
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|refreshToken|stack/i);
    });
  });

  describe("store update ordering", () => {
    it("a foreign store id with countryCode never changes the foreign store", async () => {
      const other = await createOrg("other");
      const foreign = await Store.create({ ...storeBody("F1", "BH"), organizationId: other.org._id });
      const ok = await request.patch(`/api/v1/stores/${foreign._id}`).set(auth(admin)).send({ countryCode: "BH" });
      expect(ok.status).toBe(404);
      const bad = await request.patch(`/api/v1/stores/${foreign._id}`).set(auth(admin)).send({ countryCode: "AE" });
      expect([400, 404]).toContain(bad.status);
      expect((await Store.findById(foreign._id))!.countryCode).toBe("BH");
    });

    it("a nonexistent store id with countryCode is 404", async () => {
      const id = new mongoose.Types.ObjectId().toString();
      await request.patch(`/api/v1/stores/${id}`).set(auth(admin)).send({ countryCode: "BH" }).expect(404);
    });
  });

  describe("signup", () => {
    const body = (email: string, currency?: string) => ({
      organizationName: `Org ${email}`,
      contactPhone: "+973 1234 5678",
      adminFirstName: "A",
      adminLastName: "B",
      adminEmail: email,
      adminPassword: "S3cure!Passw0rd",
      ...(currency && { currency }),
    });

    it("rolls back organization, roles and user when tax-rate seeding fails", async () => {
      vi.spyOn(TaxRate, "create").mockRejectedValue(new Error("seed-failure-marker"));
      const res = await request.post("/api/v1/auth/signup").send(body("rb@bh.test"));
      vi.restoreAllMocks();
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(res.body)).not.toContain("seed-failure-marker");
      expect(await Organization.countDocuments({ applicantEmail: "rb@bh.test" })).toBe(0);
      expect(await User.countDocuments({ email: "rb@bh.test" })).toBe(0);
      expect(await Role.countDocuments({ organizationId: { $ne: orgId } })).toBe(0);
      expect(await TaxRate.countDocuments({ organizationId: { $ne: orgId } })).toBe(0);
    });

    it("normalises currency case and whitespace, and rejects non-strings and empty", async () => {
      await request.post("/api/v1/auth/signup").send(body("c1@x.test", "  sar ")).expect(201);
      expect((await Organization.findOne({ applicantEmail: "c1@x.test" }))!.settings.currency).toBe("SAR");
      await request.post("/api/v1/auth/signup").send({ ...body("c2@x.test"), currency: 5 }).expect(400);
      await request.post("/api/v1/auth/signup").send({ ...body("c3@x.test"), currency: "" }).expect(400);
    });

    it("seeds the country's rate as the single default for OMR and SAR, none for QAR and INR", async () => {
      const expected: Record<string, number[]> = { OMR: [5], SAR: [15], QAR: [], INR: [] };
      for (const [cur, rates] of Object.entries(expected)) {
        const email = `${cur.toLowerCase()}@x.test`;
        await request.post("/api/v1/auth/signup").send(body(email, cur)).expect(201);
        const org = await Organization.findOne({ applicantEmail: email });
        const found = await TaxRate.find({ organizationId: org!._id });
        expect(found.map((r) => r.rate), cur).toEqual(rates);
        for (const r of found) expect(r.isDefault).toBe(true);
      }
    });
  });

  describe("seedDefaultTaxRates", () => {
    it("is idempotent and skips orgs that already have rates", async () => {
      expect(await seedDefaultTaxRates(orgId as mongoose.Types.ObjectId, "BHD")).toEqual([]);
      expect(await TaxRate.countDocuments({ organizationId: orgId })).toBe(1);
    });

    it("returns nothing for an unknown currency", async () => {
      expect(await seedDefaultTaxRates(new mongoose.Types.ObjectId(), "USD")).toEqual([]);
    });
  });

  describe("error response shape", () => {
    it("coded errors carry code; uncoded ApiErrors omit it entirely", async () => {
      const coded = await request.get(`${TAX}/${new mongoose.Types.ObjectId()}`).set(auth(admin));
      expect(coded.body.code).toBe("TAX_RATE_NOT_FOUND");
      const plain = await request.get(ORG);
      expect(plain.status).toBe(401);
      expect("code" in plain.body).toBe(false);
      expect(plain.body).toMatchObject({ success: false, statusCode: 401 });
    });

    it("validation failures are tagged VALIDATION_FAILED and never leak a stack", async () => {
      const res = await request.post(TAX).set(auth(admin)).send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
      expect(res.body.stack).toBeUndefined();
      expect(Array.isArray(res.body.errors)).toBe(true);
    });

    it("tax-rate JSON never exposes nameKey or __v", async () => {
      const res = await request.get(`${TAX}/${seededId}`).set(auth(admin));
      expect(res.body.data.taxRate.nameKey).toBeUndefined();
      expect(res.body.data.taxRate.__v).toBeUndefined();
    });
  });
});
