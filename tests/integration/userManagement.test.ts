/**
 * Purpose: Integration tests for staff management (/api/v1/users, /api/v1/roles):
 * roster visibility, organization-role changes, store assignments, activation,
 * the pending-invite lifecycle, the privilege ceiling, and tenant isolation.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { AuditLog } from "../../src/models/auditLog.model";
import {
  seedDefaultRolesForOrganization,
  syncSystemRolePermissions,
} from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";
import { hashToken } from "../../src/utils/token.util";
import mongoose from "mongoose";

const BASE = "/api/v1/users";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

async function createStore(orgId: unknown, code: string, isActive = true) {
  return Store.create({
    organizationId: orgId,
    name: `Store ${code}`,
    code,
    address: {
      line1: "1 Main St",
      city: "Bengaluru",
      state: "Karnataka",
      country: "India",
      postalCode: "560001",
    },
    timezone: "Asia/Kolkata",
    isActive,
  });
}

async function createUser(
  orgId: unknown,
  email: string,
  opts: {
    orgRoleId?: unknown;
    storeAccess?: { storeId: unknown; roleId: unknown }[];
    isActive?: boolean;
  } = {}
) {
  const user = await User.create({
    organizationId: orgId,
    email,
    passwordHash: "SecurePassword123",
    firstName: "Test",
    lastName: "User",
    isActive: opts.isActive ?? true,
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

/** Creates a pending (invited, not yet accepted) user with a known plaintext invite token. */
async function createPendingUser(
  orgId: unknown,
  email: string,
  opts: { orgRoleId?: unknown; storeAccess?: { storeId: unknown; roleId: unknown }[] } = {}
) {
  const plaintext = "a".repeat(80);
  const user = await User.create({
    organizationId: orgId,
    email,
    firstName: "Pending",
    lastName: "Invitee",
    isActive: false,
    inviteStatus: "pending",
    inviteToken: hashToken(plaintext),
    inviteTokenExpiresAt: new Date(Date.now() + 86_400_000),
    orgRoleId: opts.orgRoleId ?? null,
    storeAccess: opts.storeAccess ?? [],
  });
  return { user, plaintext };
}

describe("Staff management", () => {
  let org: Awaited<ReturnType<typeof createOrg>>["org"];
  let roleOf: (slug: string) => { _id: unknown; permissions: string[] };
  let admin: { user: { _id: mongoose.Types.ObjectId }; token: string };
  let storeA: { _id: mongoose.Types.ObjectId };
  let storeB: { _id: mongoose.Types.ObjectId };

  beforeEach(async () => {
    const created = await createOrg("acme");
    org = created.org;
    roleOf = created.role as never;
    admin = (await createUser(org._id, "admin@acme.test", {
      orgRoleId: roleOf("org_admin")._id,
    })) as never;
    storeA = (await createStore(org._id, "AAA")) as never;
    storeB = (await createStore(org._id, "BBB")) as never;
  });

  // =============================================================
  // Phase 0 foundations
  // =============================================================

  describe("permission catalog reconcile", () => {
    it("adds newly catalogued permissions to pre-existing system roles", async () => {
      // Simulate an organization seeded before user:read existed.
      await Role.updateOne(
        { organizationId: org._id, slug: "store_manager" },
        { $set: { permissions: ["sale:create", "store:configure"] } }
      );

      const results = await syncSystemRolePermissions(org._id);

      const updated = await Role.findOne({ organizationId: org._id, slug: "store_manager" });
      expect(updated!.permissions).toContain("user:read");
      expect(updated!.permissions).toContain("user:invite");
      expect(results.some((r) => r.slug === "store_manager")).toBe(true);
    });

    it("never removes a permission an organization added itself", async () => {
      await Role.updateOne(
        { organizationId: org._id, slug: "cashier" },
        { $addToSet: { permissions: "inventory:adjust" } }
      );

      await syncSystemRolePermissions(org._id);

      const updated = await Role.findOne({ organizationId: org._id, slug: "cashier" });
      expect(updated!.permissions).toContain("inventory:adjust");
    });

    it("is idempotent when everything is already in sync", async () => {
      await syncSystemRolePermissions(org._id);
      const second = await syncSystemRolePermissions(org._id);
      expect(second).toEqual([]);
    });
  });

  describe("storeAccess integrity", () => {
    it("rejects two roles for the same store on one user", async () => {
      await expect(
        User.create({
          organizationId: org._id,
          email: "dup@acme.test",
          passwordHash: "SecurePassword123",
          firstName: "Dup",
          lastName: "User",
          storeAccess: [
            { storeId: storeA._id, roleId: roleOf("cashier")._id },
            { storeId: storeA._id, roleId: roleOf("store_manager")._id },
          ],
        })
      ).rejects.toThrow(/only one role per store/i);
    });
  });

  // =============================================================
  // Roles
  // =============================================================

  describe("GET /roles", () => {
    it("returns the organization's roles for an org admin", async () => {
      const res = await request.get("/api/v1/roles").set(auth(admin.token));
      expect(res.status).toBe(200);
      const slugs = res.body.data.roles.map((r: { slug: string }) => r.slug);
      expect(slugs).toContain("org_admin");
      expect(slugs).toContain("cashier");
    });

    it("filters by scope", async () => {
      const res = await request.get("/api/v1/roles?scope=store").set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.roles.every((r: { scope: string }) => r.scope === "store")).toBe(true);
    });

    it("is reachable by a store manager, who needs it to invite staff", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("store_manager")._id }],
      });
      const res = await request.get("/api/v1/roles").set(auth(manager.token));
      expect(res.status).toBe(200);
    });

    it("returns 403 for a cashier (no user:read)", async () => {
      const cashier = await createUser(org._id, "cash@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });
      const res = await request.get("/api/v1/roles").set(auth(cashier.token));
      expect(res.status).toBe(403);
    });

    it("never leaks another organization's roles", async () => {
      const other = await createOrg("other");
      const res = await request.get("/api/v1/roles").set(auth(admin.token));
      const ids = res.body.data.roles.map((r: { _id: string }) => r._id);
      expect(ids).not.toContain(String(other.role("org_admin")._id));
    });

    it("exposes the permission catalog", async () => {
      const res = await request.get("/api/v1/roles/permissions").set(auth(admin.token));
      expect(res.status).toBe(200);
      const keys = res.body.data.permissions.map((p: { key: string }) => p.key);
      expect(keys).toContain("user:read");
      expect(keys).toContain("sale:create");
    });
  });

  // =============================================================
  // Roster
  // =============================================================

  describe("GET /users", () => {
    it("returns every user in the organization for an org admin", async () => {
      await createUser(org._id, "c1@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });
      const res = await request.get(BASE).set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.users).toHaveLength(2);
      expect(res.body.data.pagination.total).toBe(2);
    });

    it("never returns password hashes or refresh tokens", async () => {
      const res = await request.get(BASE).set(auth(admin.token));
      const user = res.body.data.users[0];
      expect(user.passwordHash).toBeUndefined();
      expect(user.refreshTokens).toBeUndefined();
      expect(user.usedRefreshTokens).toBeUndefined();
      expect(user.inviteToken).toBeUndefined();
    });

    it("limits a store manager to users who share one of their stores", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("store_manager")._id }],
      });
      await createUser(org._id, "sameStore@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });
      await createUser(org._id, "otherStore@acme.test", {
        storeAccess: [{ storeId: storeB._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request.get(BASE).set(auth(manager.token));
      expect(res.status).toBe(200);
      const emails = res.body.data.users.map((u: { email: string }) => u.email);
      expect(emails).toContain("samestore@acme.test");
      expect(emails).not.toContain("otherstore@acme.test");
      // The org admin has no storeAccess, so they are outside a store manager's view.
      expect(emails).not.toContain("admin@acme.test");
    });

    it("returns 403 for a cashier", async () => {
      const cashier = await createUser(org._id, "cash@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });
      const res = await request.get(BASE).set(auth(cashier.token));
      expect(res.status).toBe(403);
    });

    it("filters by store, role and status", async () => {
      await createUser(org._id, "a@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });
      await createUser(org._id, "b@acme.test", {
        storeAccess: [{ storeId: storeB._id, roleId: roleOf("cashier")._id }],
      });
      await createPendingUser(org._id, "pending@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      const byStore = await request.get(`${BASE}?storeId=${storeA._id}`).set(auth(admin.token));
      expect(byStore.body.data.users).toHaveLength(2); // a@ and pending@

      const byRole = await request
        .get(`${BASE}?roleId=${roleOf("org_admin")._id}`)
        .set(auth(admin.token));
      expect(byRole.body.data.users).toHaveLength(1);

      const pending = await request.get(`${BASE}?status=pending`).set(auth(admin.token));
      expect(pending.body.data.users).toHaveLength(1);
      expect(pending.body.data.users[0].email).toBe("pending@acme.test");
    });

    it("searches by name or email, treating the term literally", async () => {
      await createUser(org._id, "priya.nair@acme.test", {});

      const hit = await request.get(`${BASE}?q=priya`).set(auth(admin.token));
      expect(hit.body.data.users).toHaveLength(1);

      // A regex metacharacter must not match everything.
      const escaped = await request.get(`${BASE}?q=.%2B`).set(auth(admin.token));
      expect(escaped.body.data.users).toHaveLength(0);
    });

    it("never returns users of another organization", async () => {
      const other = await createOrg("other");
      await createUser(other.org._id, "spy@other.test", {});

      const res = await request.get(BASE).set(auth(admin.token));
      const emails = res.body.data.users.map((u: { email: string }) => u.email);
      expect(emails).not.toContain("spy@other.test");
    });
  });

  describe("GET /users/:userId", () => {
    it("returns a user with the organization role populated", async () => {
      const res = await request.get(`${BASE}/${admin.user._id}`).set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.user.orgRoleId.slug).toBe("org_admin");
    });

    it("returns 404 for a user in another organization", async () => {
      const other = await createOrg("other");
      const stranger = await createUser(other.org._id, "stranger@other.test", {});
      const res = await request.get(`${BASE}/${stranger.user._id}`).set(auth(admin.token));
      expect(res.status).toBe(404);
    });

    it("returns 404 (not 403) when a store manager targets a user outside their stores", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("store_manager")._id }],
      });
      const elsewhere = await createUser(org._id, "far@acme.test", {
        storeAccess: [{ storeId: storeB._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request.get(`${BASE}/${elsewhere.user._id}`).set(auth(manager.token));
      expect(res.status).toBe(404);
    });
  });

  // =============================================================
  // Organization role
  // =============================================================

  describe("PATCH /users/:userId/org-role", () => {
    it("assigns an organization role", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {});
      const res = await request
        .patch(`${BASE}/${staff.user._id}/org-role`)
        .set(auth(admin.token))
        .send({ roleId: String(roleOf("accountant")._id) });

      expect(res.status).toBe(200);
      expect(res.body.data.user.orgRoleId.slug).toBe("accountant");
    });

    it("clears the organization role with null", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {
        orgRoleId: roleOf("accountant")._id,
      });
      const res = await request
        .patch(`${BASE}/${staff.user._id}/org-role`)
        .set(auth(admin.token))
        .send({ roleId: null });

      expect(res.status).toBe(200);
      expect(res.body.data.user.orgRoleId).toBeNull();
    });

    it("refuses a store-scoped role", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {});
      const res = await request
        .patch(`${BASE}/${staff.user._id}/org-role`)
        .set(auth(admin.token))
        .send({ roleId: String(roleOf("cashier")._id) });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/store-scoped/i);
    });

    it("refuses to change your own organization role", async () => {
      const res = await request
        .patch(`${BASE}/${admin.user._id}/org-role`)
        .set(auth(admin.token))
        .send({ roleId: String(roleOf("accountant")._id) });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/your own account/i);
    });

    it("refuses a role from another organization", async () => {
      const other = await createOrg("other");
      const staff = await createUser(org._id, "staff@acme.test", {});
      const res = await request
        .patch(`${BASE}/${staff.user._id}/org-role`)
        .set(auth(admin.token))
        .send({ roleId: String(other.role("accountant")._id) });

      expect(res.status).toBe(404);
    });

    it("refuses a store manager (not an organization-level role)", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("store_manager")._id }],
      });
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .patch(`${BASE}/${staff.user._id}/org-role`)
        .set(auth(manager.token))
        .send({ roleId: String(roleOf("accountant")._id) });

      expect(res.status).toBe(403);
    });

    it("enforces the privilege ceiling against the TARGET's current access", async () => {
      // An organization-scoped role that can manage users but holds fewer permissions
      // overall than org_admin.
      const limited = await Role.create({
        organizationId: org._id,
        scope: "organization",
        name: "Limited Admin",
        slug: "limited_admin",
        permissions: ["user:read", "user:manage", "user:manage_roles"],
      });
      const limitedAdmin = await createUser(org._id, "limited@acme.test", {
        orgRoleId: limited._id,
      });

      // The target is a full org_admin, whose permissions the actor does not hold.
      const res = await request
        .patch(`${BASE}/${admin.user._id}/org-role`)
        .set(auth(limitedAdmin.token))
        .send({ roleId: String(roleOf("accountant")._id) });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/privilege ceiling/i);
    });

    it("writes an audit entry", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {});
      await request
        .patch(`${BASE}/${staff.user._id}/org-role`)
        .set(auth(admin.token))
        .send({ roleId: String(roleOf("accountant")._id) })
        .expect(200);

      const entry = await AuditLog.findOne({ action: "user.org_role_changed" });
      expect(entry).not.toBeNull();
      expect(String(entry!.targetId)).toBe(String(staff.user._id));
      expect(String(entry!.actorUserId)).toBe(String(admin.user._id));
      expect(entry!.after).toMatchObject({ orgRoleId: String(roleOf("accountant")._id) });
    });
  });

  // =============================================================
  // Store access
  // =============================================================

  describe("store access", () => {
    it("assigns an existing employee to another store", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .post(`${BASE}/${staff.user._id}/store-access`)
        .set(auth(admin.token))
        .send({ storeId: String(storeB._id), roleId: String(roleOf("cashier")._id) });

      expect(res.status).toBe(201);
      expect(res.body.data.user.storeAccess).toHaveLength(2);
    });

    it("returns 409 when the user already holds a role at that store", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .post(`${BASE}/${staff.user._id}/store-access`)
        .set(auth(admin.token))
        .send({ storeId: String(storeA._id), roleId: String(roleOf("store_manager")._id) });

      expect(res.status).toBe(409);
    });

    it("refuses an organization-scoped role", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {});
      const res = await request
        .post(`${BASE}/${staff.user._id}/store-access`)
        .set(auth(admin.token))
        .send({ storeId: String(storeA._id), roleId: String(roleOf("accountant")._id) });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/organization-scoped/i);
    });

    it("refuses to assign anyone to a deactivated store", async () => {
      const closed = await createStore(org._id, "CLOSED", false);
      const staff = await createUser(org._id, "staff@acme.test", {});

      const res = await request
        .post(`${BASE}/${staff.user._id}/store-access`)
        .set(auth(admin.token))
        .send({ storeId: String(closed._id), roleId: String(roleOf("cashier")._id) });

      expect(res.status).toBe(403); // scopeToStore rejects the inactive store first
    });

    it("changes the role a user holds at a store", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .patch(`${BASE}/${staff.user._id}/store-access/${storeA._id}`)
        .set(auth(admin.token))
        .send({ roleId: String(roleOf("store_manager")._id) });

      expect(res.status).toBe(200);
      expect(String(res.body.data.user.storeAccess[0].roleId)).toBe(
        String(roleOf("store_manager")._id)
      );
    });

    it("returns 404 when the user is not assigned to that store", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {});
      const res = await request
        .patch(`${BASE}/${staff.user._id}/store-access/${storeA._id}`)
        .set(auth(admin.token))
        .send({ roleId: String(roleOf("cashier")._id) });

      expect(res.status).toBe(404);
    });

    it("revokes an assignment, leaving other stores untouched", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [
          { storeId: storeA._id, roleId: roleOf("cashier")._id },
          { storeId: storeB._id, roleId: roleOf("cashier")._id },
        ],
      });

      const res = await request
        .delete(`${BASE}/${staff.user._id}/store-access/${storeA._id}`)
        .set(auth(admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data.user.storeAccess).toHaveLength(1);
      expect(String(res.body.data.user.storeAccess[0].storeId)).toBe(String(storeB._id));
    });

    it("allows revoking access to a DEACTIVATED store", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });
      await Store.updateOne({ _id: storeA._id }, { $set: { isActive: false } });

      const res = await request
        .delete(`${BASE}/${staff.user._id}/store-access/${storeA._id}`)
        .set(auth(admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data.user.storeAccess).toHaveLength(0);
    });

    it("writes audit entries for grant and revoke", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {});
      await request
        .post(`${BASE}/${staff.user._id}/store-access`)
        .set(auth(admin.token))
        .send({ storeId: String(storeA._id), roleId: String(roleOf("cashier")._id) })
        .expect(201);
      await request
        .delete(`${BASE}/${staff.user._id}/store-access/${storeA._id}`)
        .set(auth(admin.token))
        .expect(200);

      const actions = (await AuditLog.find({ targetId: staff.user._id })).map((a) => a.action);
      expect(actions).toContain("user.store_access_granted");
      expect(actions).toContain("user.store_access_revoked");
    });
  });

  // =============================================================
  // Activation
  // =============================================================

  describe("activation", () => {
    it("deactivates a user and blocks their existing access token", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .patch(`${BASE}/${staff.user._id}/deactivate`)
        .set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.user.isActive).toBe(false);

      // The account is refused on the very next authenticated request.
      const blocked = await request.get("/api/v1/auth/me").set(auth(staff.token));
      expect(blocked.status).toBe(401);
    });

    it("clears refresh tokens so the session cannot be renewed", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {});
      await User.updateOne(
        { _id: staff.user._id },
        {
          $push: {
            refreshTokens: {
              token: hashToken("whatever"),
              createdAt: new Date(),
              expiresAt: new Date(Date.now() + 86_400_000),
            },
          },
        }
      );

      await request.patch(`${BASE}/${staff.user._id}/deactivate`).set(auth(admin.token)).expect(200);

      const stored = await User.findById(staff.user._id);
      expect(stored!.refreshTokens).toHaveLength(0);
    });

    it("keeps store assignments so reactivation restores access", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      await request.patch(`${BASE}/${staff.user._id}/deactivate`).set(auth(admin.token)).expect(200);
      const res = await request
        .patch(`${BASE}/${staff.user._id}/activate`)
        .set(auth(admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data.user.isActive).toBe(true);
      expect(res.body.data.user.storeAccess).toHaveLength(1);
    });

    it("is idempotent", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {});
      await request.patch(`${BASE}/${staff.user._id}/deactivate`).set(auth(admin.token)).expect(200);
      await request.patch(`${BASE}/${staff.user._id}/deactivate`).set(auth(admin.token)).expect(200);
    });

    it("refuses to deactivate your own account", async () => {
      const res = await request
        .patch(`${BASE}/${admin.user._id}/deactivate`)
        .set(auth(admin.token));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/your own account/i);
    });

    it("refuses to activate a user whose invitation is still pending", async () => {
      const pending = await createPendingUser(org._id, "pending@acme.test");
      const res = await request
        .patch(`${BASE}/${pending.user._id}/activate`)
        .set(auth(admin.token));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not accepted their invitation/i);
    });

    it("refuses a store manager (not an organization-level role)", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("store_manager")._id }],
      });
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .patch(`${BASE}/${staff.user._id}/deactivate`)
        .set(auth(manager.token));

      expect(res.status).toBe(403);
    });

    it("refuses to deactivate a user of another organization", async () => {
      const other = await createOrg("other");
      const stranger = await createUser(other.org._id, "stranger@other.test", {});

      const res = await request
        .patch(`${BASE}/${stranger.user._id}/deactivate`)
        .set(auth(admin.token));

      expect(res.status).toBe(404);
    });
  });

  // =============================================================
  // Pending invite lifecycle
  // =============================================================

  describe("invite lifecycle", () => {
    it("resends an invitation and invalidates the previous link", async () => {
      const pending = await createPendingUser(org._id, "pending@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .post(`${BASE}/${pending.user._id}/invite/resend`)
        .set(auth(admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data.delivery).toBe("response");
      expect(res.body.data.inviteToken).toBeTruthy();

      // The old link no longer resolves.
      const old = await request
        .post(`${BASE}/accept-invite`)
        .send({ token: pending.plaintext, password: "SecurePassword123" });
      expect(old.status).toBe(400);

      // The new one does.
      const fresh = await request
        .post(`${BASE}/accept-invite`)
        .send({ token: res.body.data.inviteToken, password: "SecurePassword123" });
      expect(fresh.status).toBe(200);
      expect(fresh.body.data.accessToken).toBeTruthy();
    });

    it("refuses to resend for a user who has already accepted", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {});
      const res = await request
        .post(`${BASE}/${staff.user._id}/invite/resend`)
        .set(auth(admin.token));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already accepted/i);
    });

    it("revokes a pending invitation and frees the email address", async () => {
      const pending = await createPendingUser(org._id, "pending@acme.test");

      const res = await request
        .delete(`${BASE}/${pending.user._id}/invite`)
        .set(auth(admin.token));
      expect(res.status).toBe(200);

      expect(await User.findById(pending.user._id)).toBeNull();

      // The address can be invited again.
      const reinvite = await request
        .post(`${BASE}/invite`)
        .set(auth(admin.token))
        .send({
          email: "pending@acme.test",
          firstName: "Second",
          lastName: "Attempt",
          roleId: String(roleOf("cashier")._id),
          storeId: String(storeA._id),
        });
      expect(reinvite.status).toBe(201);
    });

    it("refuses to revoke an accepted user (deactivate instead)", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {});
      const res = await request.delete(`${BASE}/${staff.user._id}/invite`).set(auth(admin.token));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/can only be deactivated/i);
    });

    it("records invite, resend and revoke in the audit log", async () => {
      const invited = await request
        .post(`${BASE}/invite`)
        .set(auth(admin.token))
        .send({
          email: "new@acme.test",
          firstName: "New",
          lastName: "Hire",
          roleId: String(roleOf("cashier")._id),
          storeId: String(storeA._id),
        })
        .expect(201);

      const userId = invited.body.data.user._id;
      await request.post(`${BASE}/${userId}/invite/resend`).set(auth(admin.token)).expect(200);
      await request.delete(`${BASE}/${userId}/invite`).set(auth(admin.token)).expect(200);

      const actions = (await AuditLog.find({ targetId: userId })).map((a) => a.action);
      expect(actions).toContain("user.invited");
      expect(actions).toContain("user.invite_resent");
      expect(actions).toContain("user.invite_revoked");
    });
  });

  // =============================================================
  // Cross-store boundary for store-scoped actors
  // =============================================================

  describe("store-scoped actors cannot reach users outside their stores", () => {
    it("refuses to resend an invite for an invitee at another store", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("store_manager")._id }],
      });
      const elsewhere = await createPendingUser(org._id, "far@acme.test", {
        storeAccess: [{ storeId: storeB._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .post(`${BASE}/${elsewhere.user._id}/invite/resend`)
        .set(auth(manager.token));

      expect(res.status).toBe(404);
    });

    it("allows resending an invite for an invitee at their own store", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("store_manager")._id }],
      });
      const sameStore = await createPendingUser(org._id, "near@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .post(`${BASE}/${sameStore.user._id}/invite/resend`)
        .set(auth(manager.token));

      expect(res.status).toBe(200);
    });

    it("refuses to revoke an invite for an invitee at another store", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("store_manager")._id }],
      });
      const elsewhere = await createPendingUser(org._id, "far@acme.test", {
        storeAccess: [{ storeId: storeB._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .delete(`${BASE}/${elsewhere.user._id}/invite`)
        .set(auth(manager.token));

      expect(res.status).toBe(404);
      expect(await User.findById(elsewhere.user._id)).not.toBeNull();
    });

    it("refuses to resend an invite for an invitee whose role outranks the actor", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("store_manager")._id }],
      });
      // Shares the manager's store, but also holds an organization-wide admin role.
      const superior = await createPendingUser(org._id, "boss@acme.test", {
        orgRoleId: roleOf("org_admin")._id,
        storeAccess: [{ storeId: storeA._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request
        .post(`${BASE}/${superior.user._id}/invite/resend`)
        .set(auth(manager.token));

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/privilege ceiling/i);
    });
  });

  // =============================================================
  // Auth boundary
  // =============================================================

  describe("authentication", () => {
    it("rejects unauthenticated requests", async () => {
      await request.get(BASE).expect(401);
      await request.get("/api/v1/roles").expect(401);
    });

    it("keeps accept-invite public", async () => {
      const res = await request
        .post(`${BASE}/accept-invite`)
        .send({ token: "nope".repeat(10), password: "SecurePassword123" });
      // 400 (bad token), not 401 — the route must not require a bearer token.
      expect(res.status).toBe(400);
    });
  });
});
