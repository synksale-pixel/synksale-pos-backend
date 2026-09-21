/**
 * Purpose: Integration tests for store management (/api/v1/stores):
 * CRUD + RBAC, per-user store visibility, tenant isolation, deactivation enforcement
 * in scopeToStore, and storeId validation in the invite flow.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { generateSuperAdminAccessToken } from "../../src/services/platformAuth.service";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

const BASE = "/api/v1/stores";

const validStore = {
  name: "Main Street",
  code: "str-001",
  address: {
    line1: "1 Main St",
    city: "Bengaluru",
    state: "Karnataka",
    country: "India",
    postalCode: "560001",
  },
  timezone: "Asia/Kolkata",
};

async function createOrg(slug: string) {
  const org = await Organization.create({
    name: slug,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+91 98765 43210",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency: "INR", timezone: "Asia/Kolkata" },
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
  const token = generateAccessToken({
    userId: user._id.toString(),
    organizationId: String(orgId),
    isSuperAdmin: false,
  });
  return { user, token };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("Store management", () => {
  let orgId: unknown;
  let roleOf: (slug: string) => { _id: unknown };
  let admin: string;

  beforeEach(async () => {
    const { org, role } = await createOrg("acme");
    orgId = org._id;
    roleOf = role;
    admin = (await createUser(org._id, "admin@acme.test", { orgRoleId: role("org_admin")._id })).token;
  });

  describe("POST /stores", () => {
    it("creates a store in the caller's organization, uppercasing the code", async () => {
      const res = await request.post(BASE).set(auth(admin)).send(validStore);
      expect(res.status).toBe(201);
      expect(res.body.data.store.code).toBe("STR-001");
      expect(res.body.data.store.organizationId).toBe(String(orgId));
      expect(res.body.data.store.isActive).toBe(true);
    });

    it("ignores an organizationId sent in the body", async () => {
      const other = await createOrg("other");
      const res = await request
        .post(BASE)
        .set(auth(admin))
        .send({ ...validStore, organizationId: String(other.org._id) });
      expect(res.status).toBe(201);
      expect(res.body.data.store.organizationId).toBe(String(orgId));
    });

    it("returns 409 for a duplicate code in the same org, but allows it in another org", async () => {
      await request.post(BASE).set(auth(admin)).send(validStore).expect(201);
      const dup = await request.post(BASE).set(auth(admin)).send({ ...validStore, code: "STR-001" });
      expect(dup.status).toBe(409);

      const other = await createOrg("other");
      const otherAdmin = await createUser(other.org._id, "a@other.test", {
        orgRoleId: other.role("org_admin")._id,
      });
      const ok = await request.post(BASE).set(auth(otherAdmin.token)).send(validStore);
      expect(ok.status).toBe(201);
    });

    it("returns 400 for an invalid timezone or code", async () => {
      const tz = await request.post(BASE).set(auth(admin)).send({ ...validStore, timezone: "Mars/Base" });
      expect(tz.status).toBe(400);
      const code = await request.post(BASE).set(auth(admin)).send({ ...validStore, code: "bad code!" });
      expect(code.status).toBe(400);
    });

    it("returns 401 without a token and 403 for a cashier", async () => {
      await request.post(BASE).send(validStore).expect(401);

      const store = await Store.create({ ...validStore, organizationId: orgId });
      const cashier = await createUser(orgId, "c@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("cashier")._id }],
      });
      const res = await request.post(BASE).set(auth(cashier.token)).send({ ...validStore, code: "X1" });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /stores", () => {
    it("org admin sees all stores; store staff see only assigned ones", async () => {
      const a = await Store.create({ ...validStore, code: "A", organizationId: orgId });
      await Store.create({ ...validStore, code: "B", organizationId: orgId });
      const manager = await createUser(orgId, "m@acme.test", {
        storeAccess: [{ storeId: a._id, roleId: roleOf("store_manager")._id }],
      });

      const all = await request.get(BASE).set(auth(admin));
      expect(all.status).toBe(200);
      expect(all.body.data.stores).toHaveLength(2);
      expect(all.body.data.pagination.total).toBe(2);

      const mine = await request.get(BASE).set(auth(manager.token));
      expect(mine.body.data.stores.map((s: { code: string }) => s.code)).toEqual(["A"]);
    });

    it("paginates and filters by isActive", async () => {
      for (const code of ["A", "B", "C"]) {
        await Store.create({ ...validStore, code, organizationId: orgId, isActive: code !== "C" });
      }
      const page = await request.get(`${BASE}?limit=2&page=2`).set(auth(admin));
      expect(page.body.data.stores).toHaveLength(1);
      expect(page.body.data.pagination.totalPages).toBe(2);

      const inactive = await request.get(`${BASE}?isActive=false`).set(auth(admin));
      expect(inactive.body.data.stores.map((s: { code: string }) => s.code)).toEqual(["C"]);
    });

    it("never returns another organization's stores", async () => {
      const other = await createOrg("other");
      await Store.create({ ...validStore, organizationId: other.org._id });
      const res = await request.get(BASE).set(auth(admin));
      expect(res.body.data.stores).toHaveLength(0);
    });
  });

  describe("GET/PATCH /stores/:storeId", () => {
    it("gets and updates a store; code is immutable and address merges", async () => {
      const store = await Store.create({ ...validStore, code: "A", organizationId: orgId });

      const got = await request.get(`${BASE}/${store._id}`).set(auth(admin));
      expect(got.status).toBe(200);

      const upd = await request
        .patch(`${BASE}/${store._id}`)
        .set(auth(admin))
        .send({ name: "Renamed", address: { city: "Mysuru" } });
      expect(upd.status).toBe(200);
      expect(upd.body.data.store.name).toBe("Renamed");
      expect(upd.body.data.store.address.city).toBe("Mysuru");
      expect(upd.body.data.store.address.line1).toBe("1 Main St");

      const code = await request.patch(`${BASE}/${store._id}`).set(auth(admin)).send({ code: "ZZZ" });
      expect(code.status).toBe(400);
      const empty = await request.patch(`${BASE}/${store._id}`).set(auth(admin)).send({});
      expect(empty.status).toBe(400);
    });

    it("store manager can update their own store but not another", async () => {
      const own = await Store.create({ ...validStore, code: "A", organizationId: orgId });
      const other = await Store.create({ ...validStore, code: "B", organizationId: orgId });
      const manager = await createUser(orgId, "m@acme.test", {
        storeAccess: [{ storeId: own._id, roleId: roleOf("store_manager")._id }],
      });

      const ok = await request.patch(`${BASE}/${own._id}`).set(auth(manager.token)).send({ name: "X" });
      expect(ok.status).toBe(200);
      const denied = await request.patch(`${BASE}/${other._id}`).set(auth(manager.token)).send({ name: "X" });
      expect(denied.status).toBe(403);
      await request.get(`${BASE}/${other._id}`).set(auth(manager.token)).expect(403);
    });

    it("cashier cannot update (missing store:configure)", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      const cashier = await createUser(orgId, "c@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("cashier")._id }],
      });
      await request.get(`${BASE}/${store._id}`).set(auth(cashier.token)).expect(200);
      await request.patch(`${BASE}/${store._id}`).set(auth(cashier.token)).send({ name: "X" }).expect(403);
    });

    it("returns 404 for another org's store and for unknown ids, 400 for malformed ids", async () => {
      const other = await createOrg("other");
      const foreign = await Store.create({ ...validStore, organizationId: other.org._id });

      await request.get(`${BASE}/${foreign._id}`).set(auth(admin)).expect(404);
      await request.patch(`${BASE}/${foreign._id}`).set(auth(admin)).send({ name: "X" }).expect(404);
      await request.patch(`${BASE}/${foreign._id}/deactivate`).set(auth(admin)).expect(404);
      await request.get(`${BASE}/665f1c2e8a4b3c0012ab34ef`).set(auth(admin)).expect(404);
      await request.get(`${BASE}/not-an-id`).set(auth(admin)).expect(400);

      // Read via the raw collection (no tenant scoping) to confirm the foreign store was not touched
      const untouched = await Store.collection.findOne({ _id: foreign._id });
      expect(untouched?.name).toBe(validStore.name);
    });
  });

  describe("deactivate / activate", () => {
    it("deactivates and reactivates, and blocks store-scoped access while inactive", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      const cashierRole = roleOf("cashier");

      const off = await request.patch(`${BASE}/${store._id}/deactivate`).set(auth(admin));
      expect(off.status).toBe(200);
      expect(off.body.data.store.isActive).toBe(false);

      // Store stays readable for management...
      await request.get(`${BASE}/${store._id}`).set(auth(admin)).expect(200);

      // ...but the invite flow (scopeToStore) rejects the inactive store
      const invite = await request
        .post("/api/v1/users/invite")
        .set(auth(admin))
        .send({
          email: "new@acme.test",
          firstName: "N",
          lastName: "U",
          roleId: String(cashierRole._id),
          storeId: String(store._id),
        });
      expect(invite.status).toBe(403);

      const on = await request.patch(`${BASE}/${store._id}/activate`).set(auth(admin));
      expect(on.body.data.store.isActive).toBe(true);
      const again = await request
        .post("/api/v1/users/invite")
        .set(auth(admin))
        .send({
          email: "new@acme.test",
          firstName: "N",
          lastName: "U",
          roleId: String(cashierRole._id),
          storeId: String(store._id),
        });
      expect(again.status).toBe(201);
    });

    it("keeps a user's storeAccess intact across deactivate/activate", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      const manager = await createUser(orgId, "m@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("store_manager")._id }],
      });
      await request.patch(`${BASE}/${store._id}/deactivate`).set(auth(admin)).expect(200);
      const user = await User.findById(manager.user._id);
      expect(user?.storeAccess).toHaveLength(1);
    });
  });

  describe("invite flow storeId validation", () => {
    const invite = (token: string, storeId: string, roleId: unknown) =>
      request.post("/api/v1/users/invite").set(auth(token)).send({
        email: "new@acme.test",
        firstName: "N",
        lastName: "U",
        roleId: String(roleId),
        storeId,
      });

    it("rejects a nonexistent storeId (404) and another org's storeId (404)", async () => {
      const other = await createOrg("other");
      const foreign = await Store.create({ ...validStore, organizationId: other.org._id });

      const missing = await invite(admin, "665f1c2e8a4b3c0012ab34ef", roleOf("cashier")._id);
      expect(missing.status).toBe(404);
      const cross = await invite(admin, String(foreign._id), roleOf("cashier")._id);
      expect(cross.status).toBe(404);
      expect(await User.findOne({ email: "new@acme.test" })).toBeNull();
    });

    it("assigns a valid, active store", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      const res = await invite(admin, String(store._id), roleOf("cashier")._id);
      expect(res.status).toBe(201);
      expect(res.body.data.user.storeAccess[0].storeId).toBe(String(store._id));
    });
  });

  describe("GET /stores query params", () => {
    const codes = (res: { body: { data: { stores: { code: string }[] } } }) =>
      res.body.data.stores.map((s) => s.code);

    beforeEach(async () => {
      for (const code of ["A", "B", "C"]) {
        await Store.create({ ...validStore, code, organizationId: orgId });
      }
    });

    it.each(["page=abc", "page=0", "page=-3", "limit=abc", "limit=0", "limit=-5", "isActive=garbage", "page=&limit="])(
      "falls back to defaults for %s (never 5xx)",
      async (qs) => {
        const res = await request.get(`${BASE}?${qs}`).set(auth(admin));
        expect(res.status).toBe(200);
        expect(res.body.data.pagination.page).toBeGreaterThanOrEqual(1);
        expect(res.body.data.stores).toHaveLength(3);
      }
    );

    it("caps limit at 100", async () => {
      const res = await request.get(`${BASE}?limit=100000`).set(auth(admin));
      expect(res.status).toBe(200);
      expect(res.body.data.pagination.limit).toBe(100);
    });

    it("returns an empty page (not an error) beyond the last page", async () => {
      const res = await request.get(`${BASE}?page=99`).set(auth(admin));
      expect(res.status).toBe(200);
      expect(res.body.data.stores).toEqual([]);
      expect(res.body.data.pagination.total).toBe(3);
    });

    it("does not 5xx on fractional or huge numeric params", async () => {
      for (const qs of ["limit=2.5", "page=1.5", "page=1e20", "page=Infinity", "limit=Infinity"]) {
        const res = await request.get(`${BASE}?${qs}`).set(auth(admin));
        expect(res.status, qs).toBeLessThan(500);
      }
    });

    it("does not 5xx on repeated or object-shaped params", async () => {
      for (const qs of ["page=1&page=2", "limit[a]=1", "isActive=true&isActive=false", "page[]=2", "isActive[$ne]=true"]) {
        const res = await request.get(`${BASE}?${qs}`).set(auth(admin));
        expect(res.status, qs).toBeLessThan(500);
      }
    });

    it("isActive=true filters; injected organizationId/isDelete/storeId query params are ignored", async () => {
      await Store.updateOne({ code: "C", organizationId: orgId }, { isActive: false });
      const active = await request.get(`${BASE}?isActive=true`).set(auth(admin));
      expect(codes(active).sort()).toEqual(["A", "B"]);

      const other = await createOrg("other");
      await Store.create({ ...validStore, code: "FOREIGN", organizationId: other.org._id });
      const inj = await request
        .get(`${BASE}?organizationId=${other.org._id}&isDelete=true&storeId=${other.org._id}`)
        .set(auth(admin));
      expect(inj.status).toBe(200);
      expect(codes(inj).sort()).toEqual(["A", "B", "C"]);
    });

    it("excludes soft-deleted stores from list and get", async () => {
      const gone = await Store.create({ ...validStore, code: "GONE", organizationId: orgId, isDelete: true });
      const res = await request.get(BASE).set(auth(admin));
      expect(codes(res)).not.toContain("GONE");
      expect(res.body.data.pagination.total).toBe(3);
      await request.get(`${BASE}/${gone._id}`).set(auth(admin)).expect(404);
    });

    it("a user with no store assignments and no org role sees an empty list", async () => {
      const nobody = await createUser(orgId, "nobody@acme.test", {});
      const res = await request.get(BASE).set(auth(nobody.token));
      expect(res.status).toBe(200);
      expect(res.body.data.stores).toEqual([]);
    });

    it("store staff's list never includes a foreign-org store even if storeAccess points at it", async () => {
      const other = await createOrg("other");
      const foreign = await Store.create({ ...validStore, code: "F", organizationId: other.org._id });
      const mine = await Store.create({ ...validStore, code: "M", organizationId: orgId });
      const staff = await createUser(orgId, "s@acme.test", {
        storeAccess: [
          { storeId: foreign._id, roleId: roleOf("cashier")._id },
          { storeId: mine._id, roleId: roleOf("cashier")._id },
        ],
      });
      const res = await request.get(BASE).set(auth(staff.token));
      expect(codes(res)).toEqual(["M"]);
    });
  });

  describe("input validation edge cases", () => {
    const post = (body: unknown) => request.post(BASE).set(auth(admin)).send(body as object);

    it("rejects missing required fields and wrong types", async () => {
      for (const body of [
        {},
        { ...validStore, name: undefined },
        { ...validStore, code: undefined },
        { ...validStore, address: undefined },
        { ...validStore, timezone: undefined },
        { ...validStore, name: 123 },
        { ...validStore, name: null },
        { ...validStore, name: { $gt: "" } },
        { ...validStore, code: ["A"] },
        { ...validStore, address: "1 Main St" },
        { ...validStore, address: { ...validStore.address, city: undefined } },
        { ...validStore, address: { ...validStore.address, postalCode: 560001 } },
      ]) {
        const res = await post(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.success).toBe(false);
      }
      expect(await Store.countDocuments({})).toBe(0);
    });

    it("rejects whitespace-only name/code/address fields", async () => {
      expect((await post({ ...validStore, name: "   \t\n" })).status).toBe(400);
      expect((await post({ ...validStore, code: "   " })).status).toBe(400);
      expect((await post({ ...validStore, address: { ...validStore.address, line1: "  " } })).status).toBe(400);
    });

    it("trims whitespace around name, code and timezone", async () => {
      const res = await post({ ...validStore, name: "  Padded  ", code: "  pad-1  ", timezone: " Asia/Kolkata " });
      expect(res.status).toBe(201);
      expect(res.body.data.store.name).toBe("Padded");
      expect(res.body.data.store.code).toBe("PAD-1");
      expect(res.body.data.store.timezone).toBe("Asia/Kolkata");
    });

    it("accepts unicode names/addresses (Devanagari, accents, emoji)", async () => {
      const res = await post({
        ...validStore,
        name: "शर्मा स्टोर – Café ☕",
        address: { ...validStore.address, line1: "१२, इंदिरानगर", city: "बेंगलुरु" },
      });
      expect(res.status).toBe(201);
      expect(res.body.data.store.name).toBe("शर्मा स्टोर – Café ☕");
      expect(res.body.data.store.address.city).toBe("बेंगलुरु");
    });

    it("rejects unicode / non-ASCII / punctuation in code", async () => {
      for (const code of ["ストア1", "STR 1", "STR.1", "_STR", "-STR", "STR/1", "É1", "A\u0000B"]) {
        expect((await post({ ...validStore, code })).status, code).toBe(400);
      }
    });

    it("enforces boundary lengths (name 100/101, code 20/21, postal 20/21, line2 200/201)", async () => {
      expect((await post({ ...validStore, name: "n".repeat(100), code: "C".repeat(20) })).status).toBe(201);
      expect((await post({ ...validStore, code: "D1", name: "n".repeat(101) })).status).toBe(400);
      expect((await post({ ...validStore, code: "C".repeat(21) })).status).toBe(400);
      expect(
        (await post({ ...validStore, code: "P1", address: { ...validStore.address, postalCode: "9".repeat(21) } })).status
      ).toBe(400);
      expect(
        (await post({ ...validStore, code: "L2", address: { ...validStore.address, line2: "x".repeat(200) } })).status
      ).toBe(201);
      expect(
        (await post({ ...validStore, code: "L3", address: { ...validStore.address, line2: "x".repeat(201) } })).status
      ).toBe(400);
    });

    it("treats codes differing only by case as duplicates", async () => {
      expect((await post({ ...validStore, code: "abc" })).status).toBe(201);
      expect((await post({ ...validStore, code: "AbC" })).status).toBe(409);
    });

    it("cannot smuggle isActive / isDelete / _id / createdAt via create body", async () => {
      const res = await post({
        ...validStore,
        code: "SMUG",
        isActive: false,
        isDelete: true,
        _id: "665f1c2e8a4b3c0012ab34ef",
        createdAt: "2000-01-01",
      });
      expect(res.status).toBe(201);
      expect(res.body.data.store.isActive).toBe(true);
      expect(res.body.data.store._id).not.toBe("665f1c2e8a4b3c0012ab34ef");
      expect(new Date(res.body.data.store.createdAt).getFullYear()).toBeGreaterThan(2000);
      const listed = await request.get(BASE).set(auth(admin));
      expect(listed.body.data.stores.map((s: { code: string }) => s.code)).toContain("SMUG");
    });

    it("does not leak stack traces or internals in error responses", async () => {
      const res = await post({});
      expect(JSON.stringify(res.body)).not.toMatch(/\.ts:\d|node_modules|"stack"/i);
    });

    it("a request with no body at all is a 400 (not a 500)", async () => {
      const res = await request.post(BASE).set(auth(admin));
      expect(res.status).toBe(400);
    });

    it("a malformed JSON body is a 4xx, not a 5xx", async () => {
      const res = await request.post(BASE).set(auth(admin)).set("Content-Type", "application/json").send("{bad");
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe("PATCH /stores/:storeId strict mode and edge cases", () => {
    let storeId: string;
    beforeEach(async () => {
      storeId = String((await Store.create({ ...validStore, code: "A", organizationId: orgId }))._id);
    });
    const patch = (body: unknown, id?: string) =>
      request.patch(`${BASE}/${id ?? storeId}`).set(auth(admin)).send(body as object);

    it.each([
      ["code", { code: "NEW" }],
      ["organizationId", { organizationId: "665f1c2e8a4b3c0012ab34ef" }],
      ["isActive", { isActive: false }],
      ["isDelete", { isDelete: true }],
      ["_id", { _id: "665f1c2e8a4b3c0012ab34ef" }],
      ["storeId", { storeId: "665f1c2e8a4b3c0012ab34ef" }],
      ["mixed valid+forbidden", { name: "Ok", isActive: false }],
    ])("rejects immutable/unknown field: %s (400, nothing persisted)", async (_label, body) => {
      const res = await patch(body);
      expect(res.status).toBe(400);
      const raw = await Store.collection.findOne({ _id: new mongoose.Types.ObjectId(storeId) });
      expect(raw?.name).toBe(validStore.name);
      expect(raw?.code).toBe("A");
      expect(raw?.isActive).toBe(true);
      expect(raw?.isDelete).toBe(false);
    });

    it("rejects wrong types and invalid values", async () => {
      for (const body of [
        { name: "" },
        { name: "   " },
        { name: 5 },
        { name: null },
        { timezone: "Mars/Base" },
        { timezone: "" },
        { address: null },
        { address: "x" },
        { address: { line1: "" } },
        { address: { city: 5 } },
        { address: { line2: "x".repeat(201) } },
        [],
        "string",
      ]) {
        const res = await patch(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("$-operators / dotted keys inside address are stripped, not turned into update paths", async () => {
      const res = await patch({ address: { $set: { city: "x" }, city: "Ok", "x.y": "z" } });
      expect(res.status).toBe(200);
      expect(res.body.data.store.address.city).toBe("Ok");
      const raw = await Store.collection.findOne({ _id: new mongoose.Types.ObjectId(storeId) });
      expect(raw?.address.x).toBeUndefined();
      expect((await patch({ name: { $set: "x" } })).status).toBe(400);
    });

    it("an empty address object ({address:{}}) does not 5xx and changes nothing", async () => {
      const res = await patch({ address: {} });
      expect(res.status).toBeLessThan(500);
      if (res.status === 200) expect(res.body.data.store.address.city).toBe("Bengaluru");
    });

    it("can clear address.line2 to an empty string but not required fields", async () => {
      expect((await patch({ address: { line2: "Floor 2" } })).body.data.store.address.line2).toBe("Floor 2");
      expect((await patch({ address: { line2: "" } })).status).toBe(200);
      expect((await patch({ address: { city: "" } })).status).toBe(400);
    });

    it("trims and stores unicode names on update", async () => {
      const res = await patch({ name: "  स्टोर ☕  " });
      expect(res.status).toBe(200);
      expect(res.body.data.store.name).toBe("स्टोर ☕");
    });

    it("authorization runs before validation: cashier sending an invalid body gets 403, not 400", async () => {
      const cashier = await createUser(orgId, "c@acme.test", {
        storeAccess: [{ storeId, roleId: roleOf("cashier")._id }],
      });
      const res = await request.patch(`${BASE}/${storeId}`).set(auth(cashier.token)).send({ code: "X" });
      expect(res.status).toBe(403);
    });

    it("a query storeId cannot redirect the target: the :storeId param wins", async () => {
      const other = await Store.create({ ...validStore, code: "B", organizationId: orgId });
      const manager = await createUser(orgId, "m@acme.test", {
        storeAccess: [{ storeId, roleId: roleOf("store_manager")._id }],
      });
      const res = await request
        .patch(`${BASE}/${other._id}?storeId=${storeId}`)
        .set(auth(manager.token))
        .send({ name: "Hijack" });
      expect(res.status).toBe(403);
      expect((await Store.collection.findOne({ _id: other._id }))?.name).toBe(validStore.name);
    });

    it("only the addressed store is modified", async () => {
      const b = await Store.create({ ...validStore, code: "B", organizationId: orgId });
      expect((await patch({ name: "Only A" })).status).toBe(200);
      expect((await Store.collection.findOne({ _id: b._id }))?.name).toBe(validStore.name);
    });

    it("update on an inactive store is allowed for management", async () => {
      await request.patch(`${BASE}/${storeId}/deactivate`).set(auth(admin)).expect(200);
      expect((await patch({ name: "While inactive" })).status).toBe(200);
    });

    it("update/deactivate/activate on a soft-deleted store return 404", async () => {
      await Store.collection.updateOne({ code: "A" }, { $set: { isDelete: true } });
      expect((await patch({ name: "X" })).status).toBe(404);
      await request.patch(`${BASE}/${storeId}/deactivate`).set(auth(admin)).expect(404);
      await request.patch(`${BASE}/${storeId}/activate`).set(auth(admin)).expect(404);
    });
  });

  describe("tenant isolation (cross-org)", () => {
    it("org admin of org A cannot get/update/(de)activate a store of org B, and nothing changes", async () => {
      const other = await createOrg("other");
      const foreign = await Store.create({ ...validStore, code: "F", organizationId: other.org._id });
      for (const call of [
        () => request.get(`${BASE}/${foreign._id}`).set(auth(admin)),
        () => request.patch(`${BASE}/${foreign._id}`).set(auth(admin)).send({ name: "Pwn" }),
        () => request.patch(`${BASE}/${foreign._id}/deactivate`).set(auth(admin)),
        () => request.patch(`${BASE}/${foreign._id}/activate`).set(auth(admin)),
      ]) {
        expect((await call()).status).toBe(404);
      }
      const raw = await Store.collection.findOne({ _id: foreign._id });
      expect(raw?.name).toBe(validStore.name);
      expect(raw?.isActive).toBe(true);
    });

    it("store-scoped user gets the same 403 for a foreign-org id and an unknown id (no existence oracle)", async () => {
      const other = await createOrg("other");
      const foreign = await Store.create({ ...validStore, code: "F", organizationId: other.org._id });
      const mine = await Store.create({ ...validStore, code: "M", organizationId: orgId });
      const mgr = await createUser(orgId, "m@acme.test", {
        storeAccess: [{ storeId: mine._id, roleId: roleOf("store_manager")._id }],
      });
      const foreignRes = await request.patch(`${BASE}/${foreign._id}`).set(auth(mgr.token)).send({ name: "X" });
      const unknownRes = await request.patch(`${BASE}/665f1c2e8a4b3c0012ab34ef`).set(auth(mgr.token)).send({ name: "X" });
      expect(foreignRes.status).toBe(403);
      expect(unknownRes.status).toBe(403);
      expect(foreignRes.body.message).toBe(unknownRes.body.message);
    });

    it("a storeAccess entry pointing at a foreign-org store cannot be used to manage it", async () => {
      const other = await createOrg("other");
      const foreign = await Store.create({ ...validStore, code: "F", organizationId: other.org._id });
      const mgr = await createUser(orgId, "m@acme.test", {
        storeAccess: [{ storeId: foreign._id, roleId: roleOf("store_manager")._id }],
      });
      await request.get(`${BASE}/${foreign._id}`).set(auth(mgr.token)).expect(404);
      await request.patch(`${BASE}/${foreign._id}`).set(auth(mgr.token)).send({ name: "X" }).expect(404);
      expect((await Store.collection.findOne({ _id: foreign._id }))?.name).toBe(validStore.name);
    });

    it("a token whose organizationId claim is org B, for a user of org A, never yields org B stores", async () => {
      const other = await createOrg("other");
      await Store.create({ ...validStore, code: "F", organizationId: other.org._id });
      const { user } = await createUser(orgId, "x@acme.test", { orgRoleId: roleOf("org_admin")._id });
      const forged = generateAccessToken({
        userId: user._id.toString(),
        organizationId: String(other.org._id),
        isSuperAdmin: false,
      });
      const res = await request.get(BASE).set(auth(forged));
      if (res.status === 200) {
        expect(res.body.data.stores.every((s: { organizationId: string }) => s.organizationId === String(orgId))).toBe(true);
      }
    });

    it("an org B admin creating a store never affects org A's list", async () => {
      const other = await createOrg("other");
      const otherAdmin = await createUser(other.org._id, "a@other.test", { orgRoleId: other.role("org_admin")._id });
      await request.post(BASE).set(auth(otherAdmin.token)).send(validStore).expect(201);
      const res = await request.get(BASE).set(auth(admin));
      expect(res.body.data.stores).toHaveLength(0);
    });
  });

  describe("auth boundary and account state", () => {
    it("rejects a platform (super admin) token on every /stores route", async () => {
      const sa = await User.create({
        email: "sa@platform.test",
        passwordHash: "SecurePassword123",
        firstName: "S",
        lastName: "A",
        isSuperAdmin: true,
        organizationId: null,
        isActive: true,
      });
      const platformToken = generateSuperAdminAccessToken({ userId: sa._id.toString() });
      const store = await Store.create({ ...validStore, organizationId: orgId });
      for (const res of [
        await request.get(BASE).set(auth(platformToken)),
        await request.post(BASE).set(auth(platformToken)).send(validStore),
        await request.get(`${BASE}/${store._id}`).set(auth(platformToken)),
        await request.patch(`${BASE}/${store._id}`).set(auth(platformToken)).send({ name: "X" }),
        await request.patch(`${BASE}/${store._id}/deactivate`).set(auth(platformToken)),
      ]) {
        expect(res.status).toBe(401);
      }
      expect((await Store.collection.findOne({ _id: store._id }))?.isActive).toBe(true);
    });

    it("rejects missing, malformed, wrong-scheme, wrong-secret and expired tokens", async () => {
      const { user } = await createUser(orgId, "t@acme.test", { orgRoleId: roleOf("org_admin")._id });
      const payload = { userId: user._id.toString(), organizationId: String(orgId), isSuperAdmin: false };
      const wrongSecret = jwt.sign(payload, "not-the-secret");
      const expired = jwt.sign(payload, "x", { expiresIn: -10 });
      for (const header of [
        undefined,
        "",
        "Bearer",
        "Bearer ",
        "Bearer garbage",
        "Basic abc",
        `Bearer ${wrongSecret}`,
        `Bearer ${expired}`,
      ]) {
        const req = request.get(BASE);
        const res = header === undefined ? await req : await req.set("Authorization", header);
        expect(res.status, String(header)).toBe(401);
        expect(res.body.success).toBe(false);
        expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|"stack"/i);
      }
    });

    it("rejects an unsigned (alg none) token", async () => {
      const { user } = await createUser(orgId, "t@acme.test", { orgRoleId: roleOf("org_admin")._id });
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ userId: user._id.toString(), organizationId: String(orgId) })}.`;
      await request.get(BASE).set("Authorization", `Bearer ${none}`).expect(401);
    });

    it("rejects a deactivated user (token issued before deactivation)", async () => {
      const u = await createUser(orgId, "d@acme.test", { orgRoleId: roleOf("org_admin")._id });
      await request.get(BASE).set(auth(u.token)).expect(200);
      await User.updateOne({ _id: u.user._id }, { isActive: false });
      await request.get(BASE).set(auth(u.token)).expect(401);
      await request.post(BASE).set(auth(u.token)).send(validStore).expect(401);
    });

    it("rejects tokens for a user that no longer exists", async () => {
      const u = await createUser(orgId, "gone@acme.test", { orgRoleId: roleOf("org_admin")._id });
      await User.deleteOne({ _id: u.user._id });
      await request.get(BASE).set(auth(u.token)).expect(401);
    });

    it.each([
      ["suspended", { isActive: false }],
      ["pending approval", { approvalStatus: "pending" }],
      ["rejected", { approvalStatus: "rejected" }],
    ])("rejects all store routes when the organization is %s", async (_label, patchOrg) => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      await Organization.updateOne({ _id: orgId }, patchOrg);
      await request.get(BASE).set(auth(admin)).expect(401);
      await request.post(BASE).set(auth(admin)).send(validStore).expect(401);
      await request.get(`${BASE}/${store._id}`).set(auth(admin)).expect(401);
      await request.patch(`${BASE}/${store._id}`).set(auth(admin)).send({ name: "X" }).expect(401);
      await request.patch(`${BASE}/${store._id}/deactivate`).set(auth(admin)).expect(401);
    });

    it("has no DELETE or PUT endpoint (404) and DELETE removes nothing", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      expect((await request.delete(`${BASE}/${store._id}`).set(auth(admin))).status).toBe(404);
      expect((await request.put(`${BASE}/${store._id}`).set(auth(admin)).send(validStore)).status).toBe(404);
      expect(await Store.countDocuments({})).toBe(1);
    });
  });

  describe("privilege / RBAC edge cases", () => {
    it("user whose org role was soft-deleted loses org-wide access and permissions", async () => {
      const role = await Role.create({
        organizationId: orgId,
        name: "Temp Admin",
        slug: "temp_admin",
        scope: "organization",
        permissions: ["store:create", "store:configure"],
      });
      const u = await createUser(orgId, "t@acme.test", { orgRoleId: role._id });
      const store = await Store.create({ ...validStore, code: "EXIST", organizationId: orgId });

      await request.post(BASE).set(auth(u.token)).send(validStore).expect(201);
      await request.get(`${BASE}/${store._id}`).set(auth(u.token)).expect(200);

      await Role.collection.updateOne({ _id: role._id }, { $set: { isDelete: true } });

      const list = await request.get(BASE).set(auth(u.token));
      expect(list.status).toBe(200);
      expect(list.body.data.stores).toEqual([]);
      await request.post(BASE).set(auth(u.token)).send({ ...validStore, code: "AFTER" }).expect(403);
      await request.get(`${BASE}/${store._id}`).set(auth(u.token)).expect(403);
      await request.patch(`${BASE}/${store._id}`).set(auth(u.token)).send({ name: "X" }).expect(403);
    });

    it("a hard-deleted org role (dangling orgRoleId) yields no access instead of an error", async () => {
      const role = await Role.create({
        organizationId: orgId,
        name: "Ghost",
        slug: "ghost",
        scope: "organization",
        permissions: ["store:create"],
      });
      const u = await createUser(orgId, "g@acme.test", { orgRoleId: role._id });
      await Role.collection.deleteOne({ _id: role._id });
      expect((await request.post(BASE).set(auth(u.token)).send(validStore)).status).toBe(403);
    });

    it("a soft-deleted store-scoped role in storeAccess loses store:configure", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      const role = await Role.create({
        organizationId: orgId,
        name: "Tmp",
        slug: "tmp_mgr",
        scope: "store",
        permissions: ["store:configure"],
      });
      const u = await createUser(orgId, "m@acme.test", { storeAccess: [{ storeId: store._id, roleId: role._id }] });
      await request.patch(`${BASE}/${store._id}`).set(auth(u.token)).send({ name: "A" }).expect(200);
      await Role.collection.updateOne({ _id: role._id }, { $set: { isDelete: true } });
      await request.patch(`${BASE}/${store._id}`).set(auth(u.token)).send({ name: "B" }).expect(403);
    });

    it("accountant (org scope, no store perms) can list/get but not create/update/(de)activate", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      const acc = await createUser(orgId, "acc@acme.test", { orgRoleId: roleOf("accountant")._id });
      expect((await request.get(BASE).set(auth(acc.token))).body.data.stores).toHaveLength(1);
      await request.get(`${BASE}/${store._id}`).set(auth(acc.token)).expect(200);
      await request.post(BASE).set(auth(acc.token)).send(validStore).expect(403);
      await request.patch(`${BASE}/${store._id}`).set(auth(acc.token)).send({ name: "X" }).expect(403);
      await request.patch(`${BASE}/${store._id}/deactivate`).set(auth(acc.token)).expect(403);
      await request.patch(`${BASE}/${store._id}/activate`).set(auth(acc.token)).expect(403);
    });

    it("store manager cannot create stores, even with their own storeId in body/query", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      const mgr = await createUser(orgId, "m@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("store_manager")._id }],
      });
      await request.post(BASE).set(auth(mgr.token)).send({ ...validStore, code: "N1" }).expect(403);
      await request.post(`${BASE}?storeId=${store._id}`).set(auth(mgr.token)).send({ ...validStore, code: "N2" }).expect(403);
      await request.post(BASE).set(auth(mgr.token)).send({ ...validStore, code: "N3", storeId: String(store._id) }).expect(403);
      expect(await Store.countDocuments({})).toBe(1);
    });

    it("store manager rights on store A do not carry over to store B for (de)activate", async () => {
      const a = await Store.create({ ...validStore, code: "A", organizationId: orgId });
      const b = await Store.create({ ...validStore, code: "B", organizationId: orgId });
      const mgr = await createUser(orgId, "m@acme.test", {
        storeAccess: [{ storeId: a._id, roleId: roleOf("store_manager")._id }],
      });
      await request.patch(`${BASE}/${b._id}/deactivate`).set(auth(mgr.token)).expect(403);
      await request.patch(`${BASE}/${b._id}/activate`).set(auth(mgr.token)).expect(403);
      expect((await Store.collection.findOne({ _id: b._id }))?.isActive).toBe(true);
    });

    it("a store manager can neither deactivate their own store nor re-activate one an org admin deactivated", async () => {
      const a = await Store.create({ ...validStore, code: "A", organizationId: orgId });
      const mgr = await createUser(orgId, "m@acme.test", {
        storeAccess: [{ storeId: a._id, roleId: roleOf("store_manager")._id }],
      });

      const off = await request.patch(`${BASE}/${a._id}/deactivate`).set(auth(mgr.token));
      expect(off.status).toBe(403);
      expect((await Store.collection.findOne({ _id: a._id }))?.isActive).toBe(true);

      await request.patch(`${BASE}/${a._id}/deactivate`).set(auth(admin)).expect(200);
      const on = await request.patch(`${BASE}/${a._id}/activate`).set(auth(mgr.token));
      expect(on.status).toBe(403);
      expect((await Store.collection.findOne({ _id: a._id }))?.isActive).toBe(false);
    });

    it("deactivate/activate are idempotent", async () => {
      const a = await Store.create({ ...validStore, code: "A", organizationId: orgId });
      await request.patch(`${BASE}/${a._id}/activate`).set(auth(admin)).expect(200);
      await request.patch(`${BASE}/${a._id}/deactivate`).set(auth(admin)).expect(200);
      const again = await request.patch(`${BASE}/${a._id}/deactivate`).set(auth(admin));
      expect(again.status).toBe(200);
      expect(again.body.data.store.isActive).toBe(false);
    });

    it("deactivate ignores any body", async () => {
      const a = await Store.create({ ...validStore, code: "A", organizationId: orgId });
      await request.patch(`${BASE}/${a._id}/deactivate`).set(auth(admin)).send({ name: "Sneaky", code: "ZZ" }).expect(200);
      const raw = await Store.collection.findOne({ _id: a._id });
      expect(raw?.name).toBe(validStore.name);
      expect(raw?.code).toBe("A");
    });

    it("a code stays reserved after deactivation", async () => {
      const first = await request.post(BASE).set(auth(admin)).send(validStore).expect(201);
      await request.patch(`${BASE}/${first.body.data.store._id}/deactivate`).set(auth(admin)).expect(200);
      await request.post(BASE).set(auth(admin)).send(validStore).expect(409);
    });
  });

  describe("concurrency", () => {
    it("concurrent creates with the same code yield exactly one 201 and the rest 409 (unique index)", async () => {
      await Store.init();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => request.post(BASE).set(auth(admin)).send(validStore))
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(7);
      expect(await Store.countDocuments({ code: "STR-001" })).toBe(1);
    });

    it("concurrent creates in different orgs with the same code both succeed", async () => {
      const other = await createOrg("other");
      const otherAdmin = await createUser(other.org._id, "a@other.test", { orgRoleId: other.role("org_admin")._id });
      const [a, b] = await Promise.all([
        request.post(BASE).set(auth(admin)).send(validStore),
        request.post(BASE).set(auth(otherAdmin.token)).send(validStore),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
    });
  });

  describe("scopeToStore middleware (via invite route)", () => {
    const body = (roleId: unknown, storeId?: unknown) => ({
      email: "new@acme.test",
      firstName: "N",
      lastName: "U",
      roleId: String(roleId),
      ...(storeId !== undefined ? { storeId } : {}),
    });
    const invite = (token: string, payload: object, qs = "") =>
      request.post(`/api/v1/users/invite${qs}`).set(auth(token)).send(payload);
    const grantInviteToManagers = () =>
      Role.updateOne({ _id: roleOf("store_manager")._id }, { $addToSet: { permissions: "user:invite" } });

    it("rejects malformed storeId in body and query with 400", async () => {
      for (const bad of ["not-an-id", "123", "z".repeat(24), "665f1c2e8a4b3c0012ab34e", "665f1c2e8a4b3c0012ab34eff"]) {
        expect((await invite(admin, body(roleOf("cashier")._id, bad))).status, bad).toBe(400);
        expect((await invite(admin, body(roleOf("cashier")._id), `?storeId=${bad}`)).status, bad).toBe(400);
      }
    });

    it("rejects non-string storeId shapes (array / object / number) with 4xx, never 5xx", async () => {
      for (const bad of [["665f1c2e8a4b3c0012ab34ef"], { $ne: null }, 12345, true]) {
        const res = await invite(admin, body(roleOf("cashier")._id, bad));
        expect(res.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
        expect(res.status, JSON.stringify(bad)).toBeLessThan(500);
      }
      const res = await invite(admin, body(roleOf("cashier")._id), "?storeId=a&storeId=b");
      expect(res.status).toBeLessThan(500);
      expect(await User.findOne({ email: "new@acme.test" })).toBeNull();
    });

    it("store-scoped inviter cannot invite into a same-org store they lack access to (403)", async () => {
      const mine = await Store.create({ ...validStore, code: "M", organizationId: orgId });
      const theirs = await Store.create({ ...validStore, code: "T", organizationId: orgId });
      const inviter = await createUser(orgId, "inv@acme.test", {
        storeAccess: [{ storeId: mine._id, roleId: roleOf("store_manager")._id }],
      });
      await grantInviteToManagers();

      const denied = await invite(inviter.token, body(roleOf("cashier")._id, String(theirs._id)));
      expect(denied.status).toBe(403);
      expect(await User.findOne({ email: "new@acme.test" })).toBeNull();

      expect((await invite(inviter.token, body(roleOf("cashier")._id, String(mine._id)))).status).toBe(201);
    });

    it("cannot bypass access by putting their own store in the query while the body targets another", async () => {
      const mine = await Store.create({ ...validStore, code: "M", organizationId: orgId });
      const theirs = await Store.create({ ...validStore, code: "T", organizationId: orgId });
      const inviter = await createUser(orgId, "inv@acme.test", {
        storeAccess: [{ storeId: mine._id, roleId: roleOf("store_manager")._id }],
      });
      await grantInviteToManagers();
      const res = await invite(inviter.token, body(roleOf("cashier")._id, String(theirs._id)), `?storeId=${mine._id}`);
      expect(res.status).toBe(403);
      expect(await User.findOne({ email: "new@acme.test" })).toBeNull();
    });

    it("cannot bypass by sending an empty-string body storeId plus their own query storeId", async () => {
      const mine = await Store.create({ ...validStore, code: "M", organizationId: orgId });
      const inviter = await createUser(orgId, "inv@acme.test", {
        storeAccess: [{ storeId: mine._id, roleId: roleOf("store_manager")._id }],
      });
      await grantInviteToManagers();
      const res = await invite(inviter.token, body(roleOf("cashier")._id, ""), `?storeId=${mine._id}`);
      expect(res.status).toBe(400); // empty string fails the Zod ObjectId regex
      expect(await User.findOne({ email: "new@acme.test" })).toBeNull();
    });

    it("privilege ceiling is still enforced when a valid, accessible storeId is supplied", async () => {
      const mine = await Store.create({ ...validStore, code: "M", organizationId: orgId });
      const inviter = await createUser(orgId, "inv@acme.test", {
        storeAccess: [{ storeId: mine._id, roleId: roleOf("store_manager")._id }],
      });
      await grantInviteToManagers();

      expect((await invite(inviter.token, body(roleOf("org_admin")._id, String(mine._id)))).status).toBe(403);
      expect((await invite(inviter.token, body(roleOf("accountant")._id, String(mine._id)))).status).toBe(403);

      const powerful = await Role.create({
        organizationId: orgId,
        name: "Power",
        slug: "power",
        scope: "store",
        permissions: ["sale:create", "store:create"],
      });
      expect((await invite(inviter.token, body(powerful._id, String(mine._id)))).status).toBe(403);
      expect(await User.findOne({ email: "new@acme.test" })).toBeNull();
    });

    it("a store-scoped role without storeId is rejected (400) and creates nothing", async () => {
      const res = await invite(admin, body(roleOf("cashier")._id));
      expect(res.status).toBe(400);
      expect(await User.findOne({ email: "new@acme.test" })).toBeNull();
    });

    it("an org-scoped invite ignores storeId (no storeAccess assigned)", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      const res = await invite(admin, body(roleOf("accountant")._id, String(store._id)));
      expect(res.status).toBe(201);
      expect(res.body.data.user.storeAccess).toEqual([]);
    });

    it("cannot invite into a soft-deleted store", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId, isDelete: true });
      expect((await invite(admin, body(roleOf("cashier")._id, String(store._id)))).status).toBe(404);
    });

    it("an org admin whose role was soft-deleted no longer bypasses store access in scopeToStore", async () => {
      const role = await Role.create({
        organizationId: orgId,
        name: "Temp Admin",
        slug: "temp_admin",
        scope: "organization",
        permissions: ["user:invite"],
      });
      const store = await Store.create({ ...validStore, organizationId: orgId });
      const u = await createUser(orgId, "t@acme.test", { orgRoleId: role._id });
      await Role.collection.updateOne({ _id: role._id }, { $set: { isDelete: true } });
      expect((await invite(u.token, body(roleOf("cashier")._id, String(store._id)))).status).toBe(403);
    });

    it("a store deactivated after assignment blocks scopeToStore but keeps the user's storeAccess and list entry", async () => {
      const store = await Store.create({ ...validStore, organizationId: orgId });
      const inviter = await createUser(orgId, "inv@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("store_manager")._id }],
      });
      await grantInviteToManagers();
      await request.patch(`${BASE}/${store._id}/deactivate`).set(auth(admin)).expect(200);
      const res = await invite(inviter.token, body(roleOf("cashier")._id, String(store._id)));
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/deactivated/i);
      const list = await request.get(BASE).set(auth(inviter.token));
      expect(list.body.data.stores).toHaveLength(1);
      expect(list.body.data.stores[0].isActive).toBe(false);
    });
  });
});
