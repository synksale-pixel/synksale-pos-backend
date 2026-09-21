/**
 * Purpose: Integration tests for the tenant auth token lifecycle:
 * login, access-token use on a protected route, refresh-token rotation,
 * expiry handling (access + stored refresh), logout, and invalid tokens.
 */

import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { env } from "../../src/config/env.config";
import { User } from "../../src/models/user.model";
import { Organization } from "../../src/models/organization.model";
import { hashToken } from "../../src/utils/token.util";

const BASE = "/api/v1/auth";
const ORG_SLUG = "acme-store";
const EMAIL = "owner@acme.test";
const PASSWORD = "SecurePassword123";

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

async function login(): Promise<TokenPair> {
  const res = await request
    .post(`${BASE}/login`)
    .send({ orgSlug: ORG_SLUG, email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data as TokenPair;
}

describe("Tenant auth token lifecycle", () => {
  let userId: string;
  let orgId: string;

  // Fixtures are created directly via the models: these tests cover token
  // handling, not the signup/approval flow.
  beforeEach(async () => {
    const org = await Organization.create({
      name: "Acme Store",
      slug: ORG_SLUG,
      contactEmail: EMAIL,
      contactPhone: "+91 98765 43210",
      approvalStatus: "approved",
      isActive: true,
      settings: { currency: "INR", timezone: "Asia/Kolkata" },
    });
    const user = await User.create({
      organizationId: org._id,
      email: EMAIL,
      passwordHash: PASSWORD, // hashed by the model's pre-save hook
      firstName: "Test",
      lastName: "Owner",
      isActive: true,
    });
    orgId = org._id.toString();
    userId = user._id.toString();
  });

  describe("Login + protected route", () => {
    it("returns access + refresh tokens and the access token works on /me", async () => {
      const res = await request
        .post(`${BASE}/login`)
        .send({ orgSlug: ORG_SLUG, email: EMAIL, password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      // Never leak secrets in the response
      expect(res.body.data.user.passwordHash).toBeUndefined();
      expect(res.body.data.user.refreshTokens).toBeUndefined();

      const me = await request
        .get(`${BASE}/me`)
        .set("Authorization", `Bearer ${res.body.data.accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.data.email).toBe(EMAIL);
    });

    it("stores only the SHA-256 hash of the refresh token", async () => {
      const { refreshToken } = await login();
      const user = await User.findById(userId);
      const stored = user!.refreshTokens.map((t) => t.token);

      expect(stored).toContain(hashToken(refreshToken));
      expect(stored).not.toContain(refreshToken);
    });
  });

  describe("Refresh token rotation", () => {
    it("issues a new working token pair for a valid refresh token", async () => {
      const first = await login();
      const res = await request.post(`${BASE}/refresh`).send({ refreshToken: first.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).not.toBe(first.refreshToken);

      const me = await request
        .get(`${BASE}/me`)
        .set("Authorization", `Bearer ${res.body.data.accessToken}`);
      expect(me.status).toBe(200);

      // The new refresh token itself must be usable
      const again = await request
        .post(`${BASE}/refresh`)
        .send({ refreshToken: res.body.data.refreshToken });
      expect(again.status).toBe(200);
    });

    it("rejects reuse of the old refresh token after rotation (401)", async () => {
      const { refreshToken } = await login();
      await request.post(`${BASE}/refresh`).send({ refreshToken }).expect(200);

      const reuse = await request.post(`${BASE}/refresh`).send({ refreshToken });
      expect(reuse.status).toBe(401);
      expect(reuse.body.success).toBe(false);
      expect(reuse.body.message).toMatch(/^Authentication failed/);
    });

    it("revokes all sessions when a rotated-out token is replayed", async () => {
      const first = await login();
      const second = await login(); // a second device
      const rotated = await request
        .post(`${BASE}/refresh`)
        .send({ refreshToken: first.refreshToken })
        .expect(200);

      // Attacker replays the consumed token
      await request
        .post(`${BASE}/refresh`)
        .send({ refreshToken: first.refreshToken })
        .expect(401);

      // Every other session's refresh token is now dead too
      await request
        .post(`${BASE}/refresh`)
        .send({ refreshToken: rotated.body.data.refreshToken })
        .expect(401);
      await request
        .post(`${BASE}/refresh`)
        .send({ refreshToken: second.refreshToken })
        .expect(401);

      const user = await User.findById(userId);
      expect(user!.refreshTokens).toHaveLength(0);
    });
  });

  describe("Expired access token", () => {
    it("returns 401 with an 'expired' message on a protected route", async () => {
      const expired = jwt.sign(
        { userId, organizationId: orgId, isSuperAdmin: false },
        env.JWT_ACCESS_SECRET,
        { expiresIn: -10 }
      );

      const res = await request.get(`${BASE}/me`).set("Authorization", `Bearer ${expired}`);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/expired/i);
    });
  });

  describe("Expired stored refresh token", () => {
    it("is rejected with 401 and removed from user.refreshTokens", async () => {
      const { refreshToken } = await login();
      await User.updateOne(
        { _id: userId, "refreshTokens.token": hashToken(refreshToken) },
        { $set: { "refreshTokens.$.expiresAt": new Date(Date.now() - 60_000) } }
      );

      const res = await request.post(`${BASE}/refresh`).send({ refreshToken });
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/expired/i);

      const user = await User.findById(userId);
      expect(user!.refreshTokens.map((t) => t.token)).not.toContain(hashToken(refreshToken));
      expect(user!.refreshTokens).toHaveLength(0);
    });
  });

  describe("Logout", () => {
    it("revokes the refresh token so it can no longer be used", async () => {
      const { refreshToken } = await login();

      const out = await request.post(`${BASE}/logout`).send({ refreshToken });
      expect(out.status).toBe(200);

      const after = await request.post(`${BASE}/refresh`).send({ refreshToken });
      expect(after.status).toBe(401);

      const user = await User.findById(userId);
      expect(user!.refreshTokens).toHaveLength(0);
    });
  });

  describe("Invalid refresh tokens", () => {
    it("rejects a garbage refresh token (401)", async () => {
      const res = await request.post(`${BASE}/refresh`).send({ refreshToken: "not-a-real-token" });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/^Authentication failed/);
    });

    it("rejects a missing refresh token via validation (400)", async () => {
      const res = await request.post(`${BASE}/refresh`).send({});
      expect(res.status).toBe(400);
    });

    it("rejects an access token signed with the wrong secret (401)", async () => {
      const forged = jwt.sign(
        { userId, organizationId: orgId, isSuperAdmin: false },
        "some-other-secret",
        { expiresIn: "15m" }
      );
      const res = await request.get(`${BASE}/me`).set("Authorization", `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });
  });
});
