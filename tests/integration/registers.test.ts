/**
 * Purpose: Phase 4a-2 registers over HTTP: "Register 1" created with every store, list/get,
 * create and rename with per-store case-insensitive names, deactivate, delete (shiftCount guard,
 * name freed), deactivated stores, permissions, tenant isolation, and the migration that gives
 * existing stores their register.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { Register } from "../../src/models/register.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { backfillDefaultRegisters } from "../../src/services/registerMigration.service";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const storeBody = (code: string) => ({
  name: code,
  code,
  address: { line1: "Road 2", city: "Manama", state: "Capital", country: "Bahrain", postalCode: "324" },
  countryCode: "BH",
  timezone: "Asia/Bahrain",
});

async function setup(slug: string) {
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
  const roles = await Role.find({ organizationId: org._id });
  const role = (s: string) => roles.find((r) => r.slug === s)!;
  const admin = await tokenFor(org._id, `admin@${slug}.test`, { orgRoleId: role("org_admin")._id });
  return { org, role, admin };
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

async function createStore(token: string, code: string): Promise<string> {
  const res = await request.post("/api/v1/stores").set(auth(token)).send(storeBody(code));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.store._id;
}

let ctx: Awaited<ReturnType<typeof setup>>;
let storeId: string;
const base = (id = storeId) => `/api/v1/stores/${id}/registers`;

beforeEach(async () => {
  ctx = await setup("alnoor");
  storeId = await createStore(ctx.admin, "SEEF-1");
});

const list = (token = ctx.admin, id = storeId, query: Record<string, string> = {}) =>
  request.get(base(id)).query(query).set(auth(token));
const create = (body: Record<string, unknown>, token = ctx.admin, id = storeId) =>
  request.post(base(id)).set(auth(token)).send(body);
const names = (res: { body: { data: { registers: { name: string }[] } } }) => res.body.data.registers.map((r) => r.name);

async function registerId(name: string, id = storeId): Promise<string> {
  const res = await list(ctx.admin, id);
  return res.body.data.registers.find((r: { name: string }) => r.name === name)._id;
}

describe("default register", () => {
  it("a new store comes with 'Register 1'", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.data.registers).toHaveLength(1);
    expect(res.body.data.registers[0]).toMatchObject({ name: "Register 1", isActive: true, storeId });
    expect(res.body.data.registers[0].shiftCount).toBeUndefined();
    expect(res.body.data.registers[0].nameKey).toBeUndefined();
  });

  it("a failed store create leaves no register behind", async () => {
    const before = await Register.countDocuments({});
    const dup = await request.post("/api/v1/stores").set(auth(ctx.admin)).send(storeBody("SEEF-1"));
    expect(dup.status).toBe(409);
    expect(await Register.countDocuments({})).toBe(before);
  });
});

describe("list and get", () => {
  it("sorts by name and filters by isActive", async () => {
    await create({ name: "counter 2" });
    await create({ name: "Back office", isActive: false });
    expect(names(await list())).toEqual(["Back office", "counter 2", "Register 1"]);
    expect(names(await list(ctx.admin, storeId, { isActive: "true" }))).toEqual(["counter 2", "Register 1"]);
    expect(names(await list(ctx.admin, storeId, { isActive: "false" }))).toEqual(["Back office"]);
  });

  it("gets one; another store's register, an unknown or malformed id is refused", async () => {
    const id = await registerId("Register 1");
    const res = await request.get(`${base()}/${id}`).set(auth(ctx.admin));
    expect(res.status).toBe(200);
    expect(res.body.data.register.name).toBe("Register 1");

    const otherStore = await createStore(ctx.admin, "RIFFA-1");
    const cross = await request.get(`${base(otherStore)}/${id}`).set(auth(ctx.admin));
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe("REGISTER_NOT_FOUND");

    expect((await request.get(`${base()}/665f1c2e8a4b3c0012ab4299`).set(auth(ctx.admin))).status).toBe(404);
    expect((await request.get(`${base()}/nope`).set(auth(ctx.admin))).status).toBe(400);
  });
});

describe("create, rename, deactivate", () => {
  it("creates a register", async () => {
    const res = await create({ name: "Counter 2" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.register).toMatchObject({ name: "Counter 2", isActive: true, storeId });
  });

  it("names are unique per store, case-insensitively; other stores may reuse them", async () => {
    const res = await create({ name: "  register 1 " });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTER_NAME_TAKEN");
    expect(res.body.errors[0].field).toBe("name");

    const otherStore = await createStore(ctx.admin, "RIFFA-1");
    expect((await create({ name: "Counter 2" }, ctx.admin, otherStore)).status).toBe(201);
    expect((await create({ name: "Counter 2" })).status).toBe(201);
  });

  it("renames (including a case change of its own name) and refuses a taken name", async () => {
    const id = await registerId("Register 1");
    await create({ name: "Counter 2" });

    const own = await request.patch(`${base()}/${id}`).set(auth(ctx.admin)).send({ name: "REGISTER 1" });
    expect(own.status).toBe(200);
    expect(own.body.data.register.name).toBe("REGISTER 1");

    const taken = await request.patch(`${base()}/${id}`).set(auth(ctx.admin)).send({ name: "counter 2" });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("REGISTER_NAME_TAKEN");
  });

  it("deactivates and reactivates", async () => {
    const id = await registerId("Register 1");
    const off = await request.patch(`${base()}/${id}`).set(auth(ctx.admin)).send({ isActive: false });
    expect(off.body.data.register.isActive).toBe(false);
    const on = await request.patch(`${base()}/${id}`).set(auth(ctx.admin)).send({ isActive: true });
    expect(on.body.data.register.isActive).toBe(true);
  });

  it("validates the body", async () => {
    expect((await create({ name: "" })).status).toBe(400);
    expect((await create({ name: "x".repeat(51) })).status).toBe(400);
    expect((await create({ name: "A", openingFloat: "10" })).status).toBe(400);
    const id = await registerId("Register 1");
    expect((await request.patch(`${base()}/${id}`).set(auth(ctx.admin)).send({})).status).toBe(400);
  });
});

describe("delete", () => {
  it("deletes an unused register and frees its name", async () => {
    const id = await registerId("Register 1");
    const res = await request.delete(`${base()}/${id}`).set(auth(ctx.admin));
    expect(res.status).toBe(200);
    expect((await request.get(`${base()}/${id}`).set(auth(ctx.admin))).status).toBe(404);
    expect((await create({ name: "Register 1" })).status).toBe(201);
  });

  it("refuses a register that has had shifts", async () => {
    const id = await registerId("Register 1");
    await Register.collection.updateOne({ _id: (await Register.findById(id))!._id }, { $set: { shiftCount: 3 } });
    const res = await request.delete(`${base()}/${id}`).set(auth(ctx.admin));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTER_IN_USE");
    expect(res.body.errors[0].meta.shiftCount).toBe(3);
  });
});

describe("access", () => {
  it("a cashier of the store can read but not change registers", async () => {
    const cashier = await tokenFor(ctx.org._id, "cashier@alnoor.test", {
      storeAccess: [{ storeId, roleId: ctx.role("cashier")._id }],
    });
    expect((await list(cashier)).status).toBe(200);
    const id = await registerId("Register 1");
    expect((await request.get(`${base()}/${id}`).set(auth(cashier))).status).toBe(200);
    expect((await create({ name: "Counter 2" }, cashier)).status).toBe(403);
    expect((await request.patch(`${base()}/${id}`).set(auth(cashier)).send({ name: "X" })).status).toBe(403);
    expect((await request.delete(`${base()}/${id}`).set(auth(cashier))).status).toBe(403);
  });

  it("a store manager can manage their store's registers only", async () => {
    const otherStore = await createStore(ctx.admin, "RIFFA-1");
    const manager = await tokenFor(ctx.org._id, "manager@alnoor.test", {
      storeAccess: [{ storeId, roleId: ctx.role("store_manager")._id }],
    });
    expect((await create({ name: "Counter 2" }, manager)).status).toBe(201);
    expect((await list(manager, otherStore)).status).toBe(403);
    expect((await create({ name: "Counter 2" }, manager, otherStore)).status).toBe(403);
  });

  it("works for a deactivated store, so it can be set up before opening", async () => {
    const off = await request.patch(`/api/v1/stores/${storeId}/deactivate`).set(auth(ctx.admin));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await list()).status).toBe(200);
    expect((await create({ name: "Counter 2" })).status).toBe(201);
  });

  it("another organization's store is not found", async () => {
    const other = await setup("other");
    const res = await list(other.admin);
    expect(res.status).toBe(404);
  });

  it("needs a token", async () => {
    expect((await request.get(base())).status).toBe(401);
  });
});

describe("migration", () => {
  it("gives each store without a register 'Register 1', once", async () => {
    const legacy = await Store.create({ organizationId: ctx.org._id, ...storeBody("OLD-1") });
    const deletedStore = await Store.create({ organizationId: ctx.org._id, ...storeBody("GONE-1"), isDelete: true });

    expect(await backfillDefaultRegisters()).toEqual({ created: 1 });
    const registers = await Register.find({ storeId: legacy._id });
    expect(registers.map((r) => r.name)).toEqual(["Register 1"]);
    expect(String(registers[0].organizationId)).toBe(String(ctx.org._id));
    expect(await Register.countDocuments({ storeId: deletedStore._id })).toBe(0);
    // SEEF-1 (created through the API) kept its single register.
    expect(await Register.countDocuments({ storeId })).toBe(1);

    expect(await backfillDefaultRegisters()).toEqual({ created: 0 });
  });

  it("does not re-create a register a store deliberately deleted", async () => {
    const id = await registerId("Register 1");
    await request.delete(`${base()}/${id}`).set(auth(ctx.admin));
    expect(await backfillDefaultRegisters()).toEqual({ created: 0 });
  });
});
