/**
 * Purpose: Tenant self-service auth: `storeRole` on GET /auth/me, PATCH /auth/me (name only,
 * strict) and POST /auth/change-password (verifies the current password, signs out every other
 * device and returns a fresh token pair for this one).
 */

import { beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";

const BASE = "/api/v1/auth";
const ORG_SLUG = "selfserve";
const ADMIN_EMAIL = "admin@selfserve.test";
const CASHIER_EMAIL = "cashier@selfserve.test";
const PASSWORD = "SecurePassword123";
const NEW_PASSWORD = "BrandNewPass456";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(email: string, password = PASSWORD) {
  const res = await request.post(`${BASE}/login`).send({ orgSlug: ORG_SLUG, email, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { accessToken: string; refreshToken: string };
}

let storeId: string;
let otherStoreId: string;
let cashierRoleId: string;
let cashierId: string;

beforeEach(async () => {
  const org = await Organization.create({
    name: "Self Serve Trading",
    slug: ORG_SLUG,
    contactEmail: ADMIN_EMAIL,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency: "BHD", timezone: "Asia/Bahrain" },
  });
  await seedDefaultRolesForOrganization(org._id);
  const orgAdmin = await Role.findOne({ organizationId: org._id, slug: "org_admin" });
  const cashierRole = await Role.findOne({ organizationId: org._id, slug: "cashier" });
  cashierRoleId = cashierRole!._id.toString();

  // storeAccess only needs ids for these tests; no Store documents are required.
  storeId = new mongoose.Types.ObjectId().toString();
  otherStoreId = new mongoose.Types.ObjectId().toString();

  await User.create({
    organizationId: org._id,
    email: ADMIN_EMAIL,
    passwordHash: PASSWORD,
    firstName: "Org",
    lastName: "Admin",
    isActive: true,
    orgRoleId: orgAdmin!._id,
  });
  const cashier = await User.create({
    organizationId: org._id,
    email: CASHIER_EMAIL,
    passwordHash: PASSWORD,
    firstName: "Till",
    lastName: "Operator",
    isActive: true,
    storeAccess: [{ storeId, roleId: cashierRole!._id }],
  });
  cashierId = cashier._id.toString();
});

describe("GET /auth/me storeRole", () => {
  it("returns the cashier's role at an assigned store", async () => {
    const { accessToken } = await login(CASHIER_EMAIL);
    const res = await request.get(`${BASE}/me?storeId=${storeId}`).set(auth(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.storeRole).toEqual({
      _id: cashierRoleId,
      name: expect.any(String),
      slug: "cashier",
      scope: "store",
    });
    expect(res.body.data.permissions.length).toBeGreaterThan(0);
  });

  it("is null without a storeId, for an unassigned store, and for an org-wide admin", async () => {
    const cashier = await login(CASHIER_EMAIL);
    const admin = await login(ADMIN_EMAIL);

    const noStore = await request.get(`${BASE}/me`).set(auth(cashier.accessToken));
    expect(noStore.body.data.storeRole).toBeNull();

    const unassigned = await request.get(`${BASE}/me?storeId=${otherStoreId}`).set(auth(cashier.accessToken));
    expect(unassigned.body.data.storeRole).toBeNull();

    const adminRes = await request.get(`${BASE}/me?storeId=${storeId}`).set(auth(admin.accessToken));
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.data.storeRole).toBeNull();
  });

  it("is null when the assigned role has been soft-deleted", async () => {
    await Role.updateOne({ _id: cashierRoleId }, { $set: { isDelete: true } });
    const { accessToken } = await login(CASHIER_EMAIL);
    const res = await request.get(`${BASE}/me?storeId=${storeId}`).set(auth(accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.storeRole).toBeNull();
  });
});

describe("PATCH /auth/me", () => {
  it("updates the name (trimmed) and returns the /me shape", async () => {
    const { accessToken } = await login(CASHIER_EMAIL);
    const res = await request
      .patch(`${BASE}/me?storeId=${storeId}`)
      .set(auth(accessToken))
      .send({ firstName: "  Aisha  ", lastName: "Khan" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ firstName: "Aisha", lastName: "Khan", email: CASHIER_EMAIL });
    expect(res.body.data.permissions).toEqual(expect.any(Array));
    expect(res.body.data.storeRole.slug).toBe("cashier");
    expect(res.body.data.passwordHash).toBeUndefined();
    expect(res.body.data.refreshTokens).toBeUndefined();

    const stored = await User.findById(cashierId);
    expect([stored!.firstName, stored!.lastName]).toEqual(["Aisha", "Khan"]);
  });

  it("allows changing just one field", async () => {
    const { accessToken } = await login(CASHIER_EMAIL);
    const res = await request.patch(`${BASE}/me`).set(auth(accessToken)).send({ lastName: "Rahman" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ firstName: "Till", lastName: "Rahman" });
  });

  it("rejects an empty body, blank names and over-long names (400)", async () => {
    const { accessToken } = await login(CASHIER_EMAIL);
    for (const body of [{}, { firstName: "   " }, { lastName: "x".repeat(51) }]) {
      const res = await request.patch(`${BASE}/me`).set(auth(accessToken)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects any other field so users cannot promote themselves (400, nothing changes)", async () => {
    const { accessToken } = await login(CASHIER_EMAIL);
    const adminRole = await Role.findOne({ slug: "org_admin" });
    for (const body of [
      { firstName: "Sneaky", orgRoleId: adminRole!._id.toString() },
      { firstName: "Sneaky", email: "other@selfserve.test" },
      { firstName: "Sneaky", storeAccess: [] },
      { firstName: "Sneaky", isActive: false },
    ]) {
      const res = await request.patch(`${BASE}/me`).set(auth(accessToken)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const stored = await User.findById(cashierId);
    expect(stored!.firstName).toBe("Till");
    expect(stored!.orgRoleId).toBeNull();
    expect(stored!.email).toBe(CASHIER_EMAIL);
    expect(stored!.storeAccess).toHaveLength(1);
  });

  it("requires authentication (401)", async () => {
    const res = await request.patch(`${BASE}/me`).send({ firstName: "Nobody" });
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/change-password", () => {
  it("changes the password, signs out other devices and returns a working token pair", async () => {
    const thisDevice = await login(CASHIER_EMAIL);
    const otherDevice = await login(CASHIER_EMAIL);

    const res = await request
      .post(`${BASE}/change-password`)
      .set(auth(thisDevice.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.user.email).toBe(CASHIER_EMAIL);
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.user.refreshTokens).toBeUndefined();

    // Every earlier session's refresh token is dead, including this device's old one.
    for (const old of [thisDevice.refreshToken, otherDevice.refreshToken]) {
      const r = await request.post(`${BASE}/refresh`).send({ refreshToken: old });
      expect(r.status).toBe(401);
    }

    // The new pair works.
    await request.get(`${BASE}/me`).set(auth(res.body.data.accessToken)).expect(200);
    await request.post(`${BASE}/refresh`).send({ refreshToken: res.body.data.refreshToken }).expect(200);

    // Old password no longer logs in; the new one does.
    const oldLogin = await request.post(`${BASE}/login`).send({ orgSlug: ORG_SLUG, email: CASHIER_EMAIL, password: PASSWORD });
    expect(oldLogin.status).toBe(401);
    await login(CASHIER_EMAIL, NEW_PASSWORD);

    // Stored as a bcrypt hash, never plaintext.
    const stored = await User.findById(cashierId).select("+passwordHash");
    expect(stored!.passwordHash).not.toBe(NEW_PASSWORD);
    expect(await stored!.comparePassword(NEW_PASSWORD)).toBe(true);
  });

  it("rejects a wrong current password with 400 on currentPassword and changes nothing", async () => {
    const device = await login(CASHIER_EMAIL);
    const res = await request
      .post(`${BASE}/change-password`)
      .set(auth(device.accessToken))
      .send({ currentPassword: "WrongPassword99", newPassword: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors[0].field).toBe("currentPassword");

    // Session still alive, password unchanged.
    await request.post(`${BASE}/refresh`).send({ refreshToken: device.refreshToken }).expect(200);
    await login(CASHIER_EMAIL, PASSWORD);
  });

  it("validates the new password (too short, same as current, missing)", async () => {
    const { accessToken } = await login(CASHIER_EMAIL);
    const cases: [Record<string, unknown>, string][] = [
      [{ currentPassword: PASSWORD, newPassword: "short" }, "newPassword"],
      [{ currentPassword: PASSWORD, newPassword: PASSWORD }, "newPassword"],
      [{ newPassword: NEW_PASSWORD }, "currentPassword"],
    ];
    for (const [body, field] of cases) {
      const res = await request.post(`${BASE}/change-password`).set(auth(accessToken)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.errors[0].field).toBe(field);
    }
  });

  it("requires authentication (401)", async () => {
    const res = await request
      .post(`${BASE}/change-password`)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });
});
