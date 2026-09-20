/**
 * Purpose: Integration tests for the Super Admin organization review flow:
 * reject-only-pending, duplicate application prevention, and slug override on approve.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { User } from "../../src/models/user.model";
import { Organization } from "../../src/models/organization.model";

const ORGS = "/api/v1/platform/organizations";
const SIGNUP = "/api/v1/auth/signup";
const ADMIN_EMAIL = "platform@example.com";
const PASSWORD = "SecurePassword123";

let token: string;

function signupBody(adminEmail: string, organizationName = "Acme Retail") {
  return {
    organizationName,
    contactPhone: "+911234567890",
    adminFirstName: "Jane",
    adminLastName: "Doe",
    adminEmail,
    adminPassword: PASSWORD,
  };
}

async function signup(adminEmail: string, organizationName?: string) {
  return request.post(SIGNUP).send(signupBody(adminEmail, organizationName));
}

async function signupOk(adminEmail: string, organizationName?: string): Promise<string> {
  const res = await signup(adminEmail, organizationName);
  expect(res.status).toBe(201);
  const org = await Organization.findOne({
    applicantEmail: adminEmail.toLowerCase(),
    approvalStatus: "pending",
  });
  return org!._id.toString();
}

const auth = () => ({ Authorization: `Bearer ${token}` });
const approve = (id: string, body?: object) =>
  request.post(`${ORGS}/${id}/approve`).set(auth()).send(body);
const reject = (id: string, reason = "Not a valid business") =>
  request.post(`${ORGS}/${id}/reject`).set(auth()).send({ reason });

describe("Platform organization review", () => {
  beforeEach(async () => {
    // Ensure the partial unique index exists before any test relies on it.
    await Organization.init();
    await User.create({
      email: ADMIN_EMAIL,
      passwordHash: PASSWORD,
      firstName: "Test",
      lastName: "Admin",
      isSuperAdmin: true,
      organizationId: null,
      isActive: true,
    });
    const login = await request
      .post("/api/v1/platform/auth/login")
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    token = login.body.data.accessToken;
  });

  describe("Reject", () => {
    it("rejects a pending organization", async () => {
      const id = await signupOk("a@example.com");
      const res = await reject(id);
      expect(res.status).toBe(200);
      const org = await Organization.findById(id);
      expect(org!.approvalStatus).toBe("rejected");
      expect(org!.rejectionReason).toBe("Not a valid business");
    });

    it("returns 400 when rejecting an approved organization and leaves it approved", async () => {
      const id = await signupOk("a@example.com");
      await approve(id).expect(200);
      const res = await reject(id);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect((await Organization.findById(id))!.approvalStatus).toBe("approved");
    });

    it("returns 400 when rejecting an already-rejected organization", async () => {
      const id = await signupOk("a@example.com");
      await reject(id).expect(200);
      const res = await reject(id, "Second rejection attempt");
      expect(res.status).toBe(400);
      expect((await Organization.findById(id))!.rejectionReason).toBe("Not a valid business");
    });

    it("requires a super admin token (401 without one)", async () => {
      const id = await signupOk("a@example.com");
      const res = await request.post(`${ORGS}/${id}/reject`).send({ reason: "whatever reason" });
      expect(res.status).toBe(401);
    });
  });

  describe("Duplicate applications", () => {
    it("returns 409 for a sequential duplicate signup with the same adminEmail", async () => {
      await signupOk("dup@example.com");
      const res = await signup("dup@example.com", "Other Name");
      expect(res.status).toBe(409);
      expect(await Organization.countDocuments({})).toBe(1);
    });

    it("treats email case-insensitively", async () => {
      await signupOk("dup@example.com");
      const res = await signup("DUP@Example.com", "Other Name");
      expect(res.status).toBe(409);
    });

    it("concurrent signups with the same adminEmail: exactly one succeeds, the other is 409", async () => {
      const [r1, r2] = await Promise.all([
        signup("race@example.com", "Race One"),
        signup("race@example.com", "Race Two"),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([201, 409]);
      expect(await Organization.countDocuments({ applicantEmail: "race@example.com" })).toBe(1);
      expect(await User.countDocuments({ email: "race@example.com" })).toBe(1);
    });

    it("allows the same email to re-apply after rejection", async () => {
      const id = await signupOk("again@example.com");
      await reject(id).expect(200);
      const res = await signup("again@example.com", "Second Try");
      expect(res.status).toBe(201);
      expect(await Organization.countDocuments({ applicantEmail: "again@example.com" })).toBe(2);
    });

    it("blocks re-application while the previous application is approved", async () => {
      const id = await signupOk("appr@example.com");
      await approve(id).expect(200);
      const res = await signup("appr@example.com", "Another");
      expect(res.status).toBe(409);
    });

    it("legacy organizations without applicantEmail do not collide with each other", async () => {
      const base = {
        contactEmail: "l@example.com",
        contactPhone: "+911234567890",
        settings: { currency: "INR", timezone: "UTC" },
        approvalStatus: "pending",
      };
      await Organization.collection.insertMany([
        { ...base, name: "Legacy1", slug: "legacy-1" },
        { ...base, name: "Legacy2", slug: "legacy-2" },
      ]);
      expect(await Organization.countDocuments({})).toBe(2);
    });
  });

  describe("Approve with slug override", () => {
    it("approves without a body and keeps the generated slug", async () => {
      const id = await signupOk("a@example.com", "Acme Retail");
      const res = await approve(id);
      expect(res.status).toBe(200);
      expect(res.body.data.slug).toBe("acme-retail");
      expect(res.body.data.approvalStatus).toBe("approved");
    });

    it("approves with a valid slug and changes the slug", async () => {
      const id = await signupOk("a@example.com");
      const res = await approve(id, { slug: "acme-store-1" });
      expect(res.status).toBe(200);
      const org = await Organization.findById(id);
      expect(org!.slug).toBe("acme-store-1");
      expect(org!.approvalStatus).toBe("approved");
    });

    it("lowercases an uppercase slug", async () => {
      const id = await signupOk("a@example.com");
      const res = await approve(id, { slug: "  MyShop  " });
      expect(res.status).toBe(200);
      expect((await Organization.findById(id))!.slug).toBe("myshop");
    });

    it("returns 409 when the slug belongs to another org and the org stays pending", async () => {
      await signupOk("other@example.com", "Taken Name"); // slug: taken-name
      const id = await signupOk("a@example.com", "Acme Retail");
      const res = await approve(id, { slug: "taken-name" });
      expect(res.status).toBe(409);
      const org = await Organization.findById(id);
      expect(org!.approvalStatus).toBe("pending");
      expect(org!.slug).toBe("acme-retail");
    });

    it.each(["a", "bad slug", "-x-", "double--hyphen", "under_score", "x".repeat(61), ""])(
      "rejects invalid slug %j with 400 and leaves the org pending",
      async (slug) => {
        const id = await signupOk("a@example.com");
        const res = await approve(id, { slug });
        expect(res.status).toBe(400);
        expect((await Organization.findById(id))!.approvalStatus).toBe("pending");
      }
    );

    it("rejects a non-string slug with 400", async () => {
      const id = await signupOk("a@example.com");
      const res = await approve(id, { slug: 123 });
      expect(res.status).toBe(400);
    });

    it("same slug as current is a no-op success", async () => {
      const id = await signupOk("a@example.com", "Acme Retail");
      const res = await approve(id, { slug: "acme-retail" });
      expect(res.status).toBe(200);
      expect((await Organization.findById(id))!.slug).toBe("acme-retail");
    });

    it("approving a previously rejected org with a slug override works and clears rejection", async () => {
      const id = await signupOk("a@example.com");
      await reject(id).expect(200);
      const res = await approve(id, { slug: "fresh-slug" });
      expect(res.status).toBe(200);
      const org = await Organization.findById(id);
      expect(org!.slug).toBe("fresh-slug");
      expect(org!.rejectionReason).toBeNull();
    });
  });
});
