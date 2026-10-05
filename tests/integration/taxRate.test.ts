/**
 * Purpose: Integration tests for tax rates (/api/v1/tax-rates): CRUD, case-insensitive name
 * uniqueness (reusable after delete), the single-default rule and its guards, RBAC (anyone reads,
 * only tax:manage on an org role writes), coded errors, and tenant isolation.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { TaxRate } from "../../src/models/taxRate.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { seedDefaultTaxRates } from "../../src/services/taxRate.service";
import { generateAccessToken } from "../../src/services/auth.service";

const BASE = "/api/v1/tax-rates";

async function createOrg(slug: string) {
  const org = await Organization.create({
    name: slug,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency: "BHD", timezone: "Asia/Bahrain" },
  });
  await seedDefaultRolesForOrganization(org._id);
  await seedDefaultTaxRates(org._id, "BHD");
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

describe("Tax rates", () => {
  let orgId: unknown;
  let roleOf: (slug: string) => { _id: unknown };
  let admin: string;
  let seededId: string;

  beforeEach(async () => {
    const { org, role } = await createOrg("alnoor");
    orgId = org._id;
    roleOf = role;
    admin = await createUser(org._id, "admin@alnoor.test", { orgRoleId: role("org_admin")._id });
    seededId = (await TaxRate.findOne({ organizationId: org._id }))!._id.toString();
  });

  const createRate = (body: Record<string, unknown>, token = admin) =>
    request.post(BASE).set(auth(token)).send(body);

  describe("POST /tax-rates", () => {
    it("creates a single-component rate and derives the total", async () => {
      const res = await createRate({ name: "Reduced 2.5%", components: [{ name: "VAT", rate: 2.5 }] });
      expect(res.status).toBe(201);
      expect(res.body.data.taxRate).toMatchObject({
        name: "Reduced 2.5%",
        rate: 2.5,
        isDefault: false,
        isActive: true,
        organizationId: String(orgId),
      });
      expect(res.body.data.taxRate.nameKey).toBeUndefined();
    });

    it("sums multiple components exactly", async () => {
      const res = await createRate({
        name: "Split",
        components: [
          { name: "A", rate: 0.1 },
          { name: "B", rate: 0.2 },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.taxRate.rate).toBe(0.3); // not 0.30000000000000004
    });

    it("rejects a duplicate name case-insensitively with a coded 409", async () => {
      const res = await createRate({ name: "  vat 10% ", components: [{ name: "VAT", rate: 10 }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("TAX_RATE_NAME_TAKEN");
      expect(res.body.errors[0].field).toBe("name");
    });

    it("allows a name in another organization", async () => {
      const other = await createOrg("other");
      const otherAdmin = await createUser(other.org._id, "a@other.test", {
        orgRoleId: other.role("org_admin")._id,
      });
      const res = await createRate({ name: "Standard", components: [{ name: "VAT", rate: 10 }] });
      const res2 = await createRate({ name: "Standard", components: [{ name: "VAT", rate: 10 }] }, otherAdmin);
      expect(res.status).toBe(201);
      expect(res2.status).toBe(201);
    });

    it("validates components", async () => {
      const bad = [
        { name: "X", components: [] },
        { name: "X", components: [{ name: "VAT", rate: -1 }] },
        { name: "X", components: [{ name: "VAT", rate: 101 }] },
        { name: "X", components: [{ name: "VAT", rate: 1.23456 }] },
        { name: "X", components: [{ name: "VAT", rate: "10" }] },
        { name: "X", components: [{ name: "A", rate: 60 }, { name: "B", rate: 50 }] },
        { name: "", components: [{ name: "VAT", rate: 5 }] },
      ];
      for (const body of bad) {
        const res = await createRate(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("isDefault: true moves the default to the new rate", async () => {
      const res = await createRate({ name: "New", components: [{ name: "VAT", rate: 5 }], isDefault: true });
      expect(res.status).toBe(201);
      expect(res.body.data.taxRate.isDefault).toBe(true);
      const defaults = await TaxRate.find({ organizationId: orgId, isDefault: true });
      expect(defaults.map((r) => r._id.toString())).toEqual([res.body.data.taxRate._id]);
    });
  });

  describe("GET /tax-rates", () => {
    it("lists the organization's rates, default first, filtered by isActive", async () => {
      const zero = await createRate({ name: "Zero", components: [{ name: "VAT", rate: 0 }] });
      await request.patch(`${BASE}/${zero.body.data.taxRate._id}/deactivate`).set(auth(admin)).expect(200);

      const all = await request.get(BASE).set(auth(admin));
      expect(all.status).toBe(200);
      expect(all.body.data.taxRates.map((r: { name: string }) => r.name)).toEqual(["VAT 10%", "Zero"]);

      const active = await request.get(`${BASE}?isActive=true`).set(auth(admin));
      expect(active.body.data.taxRates.map((r: { name: string }) => r.name)).toEqual(["VAT 10%"]);
    });

    it("is readable by a cashier, who cannot write", async () => {
      const store = await Store.create({
        name: "S",
        code: "S1",
        address: { line1: "1", city: "Manama", state: "C", country: "Bahrain", postalCode: "1" },
        countryCode: "BH",
        timezone: "Asia/Bahrain",
        organizationId: orgId,
      });
      const cashier = await createUser(orgId, "c@alnoor.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("cashier")._id }],
      });
      await request.get(BASE).set(auth(cashier)).expect(200);
      await request.get(`${BASE}/${seededId}`).set(auth(cashier)).expect(200);
      await createRate({ name: "Nope", components: [{ name: "VAT", rate: 1 }] }, cashier).then((r) =>
        expect(r.status).toBe(403)
      );
      await request.delete(`${BASE}/${seededId}`).set(auth(cashier)).expect(403);
    });

    it("lets an accountant (org role with tax:manage) write", async () => {
      const accountant = await createUser(orgId, "acc@alnoor.test", { orgRoleId: roleOf("accountant")._id });
      const res = await createRate({ name: "By accountant", components: [{ name: "VAT", rate: 1 }] }, accountant);
      expect(res.status).toBe(201);
    });
  });

  describe("tenant isolation", () => {
    it("another organization cannot read, update or delete a rate (404)", async () => {
      const other = await createOrg("other");
      const otherAdmin = await createUser(other.org._id, "a@other.test", {
        orgRoleId: other.role("org_admin")._id,
      });
      const get = await request.get(`${BASE}/${seededId}`).set(auth(otherAdmin));
      expect(get.status).toBe(404);
      expect(get.body.code).toBe("TAX_RATE_NOT_FOUND");
      await request.patch(`${BASE}/${seededId}`).set(auth(otherAdmin)).send({ name: "Hijack" }).expect(404);
      await request.delete(`${BASE}/${seededId}`).set(auth(otherAdmin)).expect(404);

      const list = await request.get(BASE).set(auth(otherAdmin));
      expect(list.body.data.taxRates.map((r: { _id: string }) => r._id)).not.toContain(seededId);
      expect((await TaxRate.findById(seededId))!.name).toBe("VAT 10%");
    });

    it("returns 400 for a malformed id", async () => {
      await request.get(`${BASE}/not-an-id`).set(auth(admin)).expect(400);
    });
  });

  describe("PATCH /tax-rates/:id", () => {
    it("renames and replaces components, recomputing the total", async () => {
      const res = await request
        .patch(`${BASE}/${seededId}`)
        .set(auth(admin))
        .send({ name: "Standard", components: [{ name: "VAT", rate: 15 }] });
      expect(res.status).toBe(200);
      expect(res.body.data.taxRate).toMatchObject({ name: "Standard", rate: 15, isDefault: true });
    });

    it("allows changing only the case of its own name, but not taking another rate's name", async () => {
      await createRate({ name: "Zero", components: [{ name: "VAT", rate: 0 }] });
      await request.patch(`${BASE}/${seededId}`).set(auth(admin)).send({ name: "vat 10%" }).expect(200);
      const res = await request.patch(`${BASE}/${seededId}`).set(auth(admin)).send({ name: "ZERO" });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("TAX_RATE_NAME_TAKEN");
    });

    it("rejects unknown fields (isDefault is changed through its own endpoint)", async () => {
      await request.patch(`${BASE}/${seededId}`).set(auth(admin)).send({ isDefault: false }).expect(400);
      await request.patch(`${BASE}/${seededId}`).set(auth(admin)).send({}).expect(400);
    });
  });

  describe("default, activation and deletion", () => {
    it("moves the default, keeping exactly one", async () => {
      const zero = await createRate({ name: "Zero", components: [{ name: "VAT", rate: 0 }] });
      const zeroId = zero.body.data.taxRate._id;

      const res = await request.patch(`${BASE}/${zeroId}/default`).set(auth(admin));
      expect(res.status).toBe(200);
      expect(res.body.data.taxRate.isDefault).toBe(true);
      const defaults = await TaxRate.find({ organizationId: orgId, isDefault: true });
      expect(defaults.map((r) => r._id.toString())).toEqual([zeroId]);

      // Idempotent
      await request.patch(`${BASE}/${zeroId}/default`).set(auth(admin)).expect(200);
    });

    it("refuses to deactivate or delete the default rate", async () => {
      const deactivate = await request.patch(`${BASE}/${seededId}/deactivate`).set(auth(admin));
      expect(deactivate.status).toBe(409);
      expect(deactivate.body.code).toBe("TAX_RATE_IS_DEFAULT");
      const remove = await request.delete(`${BASE}/${seededId}`).set(auth(admin));
      expect(remove.status).toBe(409);
      expect(remove.body.code).toBe("TAX_RATE_IS_DEFAULT");
    });

    it("refuses to make an inactive rate the default until it is activated", async () => {
      const zero = await createRate({ name: "Zero", components: [{ name: "VAT", rate: 0 }] });
      const zeroId = zero.body.data.taxRate._id;
      await request.patch(`${BASE}/${zeroId}/deactivate`).set(auth(admin)).expect(200);

      const res = await request.patch(`${BASE}/${zeroId}/default`).set(auth(admin));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("TAX_RATE_INACTIVE");

      await request.patch(`${BASE}/${zeroId}/activate`).set(auth(admin)).expect(200);
      await request.patch(`${BASE}/${zeroId}/default`).set(auth(admin)).expect(200);
    });

    it("soft-deletes a rate, hides it, and frees its name", async () => {
      const zero = await createRate({ name: "Zero", components: [{ name: "VAT", rate: 0 }] });
      const zeroId = zero.body.data.taxRate._id;

      await request.delete(`${BASE}/${zeroId}`).set(auth(admin)).expect(200);
      await request.get(`${BASE}/${zeroId}`).set(auth(admin)).expect(404);
      const list = await request.get(BASE).set(auth(admin));
      expect(list.body.data.taxRates).toHaveLength(1);

      const raw = await TaxRate.findOne({ _id: zeroId, isDelete: true });
      expect(raw).not.toBeNull();

      await createRate({ name: "Zero", components: [{ name: "VAT", rate: 0 }] }).then((r) =>
        expect(r.status).toBe(201)
      );
    });
  });
});
