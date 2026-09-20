/**
 * Purpose: Integration tests for Super Admin (platform) authentication routes:
 * login, /me, refresh-token rotation, and logout.
 * Migrated from scripts/testSuperAdminAuth.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { User } from "../../src/models/user.model";

const BASE = "/api/v1/platform/auth";
const EMAIL = "admin@example.com";
const PASSWORD = "SecurePassword123";

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

async function login(): Promise<TokenPair> {
  const res = await request.post(`${BASE}/login`).send({ email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data as TokenPair;
}

describe("Platform (Super Admin) auth", () => {
  // The super admin is created directly via the model, bypassing the seed CLI
  // script on purpose: these tests cover the AUTH LOGIC, not the seed script.
  beforeEach(async () => {
    await User.create({
      email: EMAIL,
      passwordHash: PASSWORD, // plaintext, hashed by the model's pre-save hook
      firstName: "Test",
      lastName: "Admin",
      isSuperAdmin: true,
      organizationId: null,
      isActive: true,
    });
  });

  describe("Login", () => {
    it("rejects wrong password with a generic 401", async () => {
      const res = await request.post(`${BASE}/login`).send({ email: EMAIL, password: "WrongPassword" });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe("Invalid credentials");
      expect(res.body.success).toBe(false);
    });

    it("accepts correct credentials and returns access + refresh tokens", async () => {
      const res = await request.post(`${BASE}/login`).send({ email: EMAIL, password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));

      // Access token carries the platform claims
      const payload = JSON.parse(
        Buffer.from(res.body.data.accessToken.split(".")[1], "base64").toString()
      ) as { aud?: string; isSuperAdmin?: boolean };
      expect(payload.aud).toBe("platform");
      expect(payload.isSuperAdmin).toBe(true);
    });
  });

  describe("GET /me", () => {
    it("rejects requests without a token (401)", async () => {
      const res = await request.get(`${BASE}/me`);
      expect(res.status).toBe(401);
    });

    it("returns the super admin profile with a valid token", async () => {
      const { accessToken } = await login();
      const res = await request.get(`${BASE}/me`).set("Authorization", `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.email).toBe(EMAIL);
      expect(res.body.data.isSuperAdmin).toBe(true);
    });
  });

  describe("Refresh token rotation", () => {
    it("issues a new token pair for a valid refresh token", async () => {
      const { refreshToken } = await login();
      const res = await request.post(`${BASE}/refresh`).send({ refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
    });

    it("rejects reuse of an already-rotated refresh token (401)", async () => {
      const { refreshToken } = await login();
      await request.post(`${BASE}/refresh`).send({ refreshToken }).expect(200);

      const reuse = await request.post(`${BASE}/refresh`).send({ refreshToken });
      expect(reuse.status).toBe(401);
      expect(reuse.body.message).toMatch(/^Authentication failed/);
    });
  });

  describe("Logout", () => {
    it("revokes the refresh token so it can no longer be rotated", async () => {
      const { refreshToken } = await login();
      const rotated = await request.post(`${BASE}/refresh`).send({ refreshToken });
      const newRefreshToken = rotated.body.data.refreshToken as string;

      const logout = await request.post(`${BASE}/logout`).send({ refreshToken: newRefreshToken });
      expect(logout.status).toBe(200);

      const afterLogout = await request.post(`${BASE}/refresh`).send({ refreshToken: newRefreshToken });
      expect(afterLogout.status).toBe(401);
    });
  });
});
