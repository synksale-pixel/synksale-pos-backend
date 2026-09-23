/**
 * Purpose: Integration tests for role management (/api/v1/roles):
 * custom role CRUD, the privilege ceiling on create/modify/delete, system-role protection,
 * scope and slug immutability, minScope enforcement, delete-while-in-use, and tenant isolation.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { request } from "../helpers/testApp";
import { Organization } from "../../src/models/organization.model";
import { User } from "../../src/models/user.model";
import { Role } from "../../src/models/role.model";
import { Store } from "../../src/models/store.model";
import { AuditLog } from "../../src/models/auditLog.model";
import { seedDefaultRolesForOrganization } from "../../src/services/roleSeed.service";
import { generateAccessToken } from "../../src/services/auth.service";
import mongoose from "mongoose";

const BASE = "/api/v1/roles";

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

async function createUser(
  orgId: unknown,
  email: string,
  opts: {
    orgRoleId?: unknown;
    storeAccess?: { storeId: unknown; roleId: unknown }[];
  } = {}
) {
  const user = await User.create({
    organizationId: orgId,
    email,
    passwordHash: "SecurePassword123",
    firstName: "Test",
    lastName: "User",
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

describe("Role management", () => {
  let org: Awaited<ReturnType<typeof createOrg>>["org"];
  let roleOf: (slug: string) => { _id: unknown; permissions: string[]; name: string };
  let admin: { user: { _id: mongoose.Types.ObjectId }; token: string };
  let store: { _id: mongoose.Types.ObjectId };

  beforeEach(async () => {
    const created = await createOrg("acme");
    org = created.org;
    roleOf = created.role as never;
    admin = (await createUser(org._id, "admin@acme.test", {
      orgRoleId: roleOf("org_admin")._id,
    })) as never;
    store = (await Store.create({
      organizationId: org._id,
      name: "Store A",
      code: "AAA",
      address: {
        line1: "1 Main St",
        city: "Bengaluru",
        state: "Karnataka",
        country: "India",
        postalCode: "560001",
      },
      timezone: "Asia/Kolkata",
    })) as never;
  });

  const newRole = (over: Record<string, unknown> = {}) => ({
    name: "Shift Supervisor",
    scope: "store",
    permissions: ["sale:create", "sale:refund"],
    ...over,
  });

  // =============================================================
  // Create
  // =============================================================

  describe("POST /roles", () => {
    it("creates a custom role and derives the slug from the name", async () => {
      const res = await request.post(BASE).set(auth(admin.token)).send(newRole());

      expect(res.status).toBe(201);
      expect(res.body.data.role.slug).toBe("shift_supervisor");
      expect(res.body.data.role.isSystemRole).toBe(false);
      expect(res.body.data.role.usageCount).toBe(0);
      expect(res.body.data.role.organizationId).toBe(String(org._id));
    });

    it("suffixes the slug on collision instead of failing", async () => {
      await request.post(BASE).set(auth(admin.token)).send(newRole()).expect(201);
      const second = await request.post(BASE).set(auth(admin.token)).send(newRole());

      expect(second.status).toBe(201);
      expect(second.body.data.role.slug).toBe("shift_supervisor_2");
    });

    it("ignores a client-supplied slug, scope-mismatch aside", async () => {
      const res = await request
        .post(BASE)
        .set(auth(admin.token))
        .send({ ...newRole(), slug: "org_admin" });

      // .strict() rejects unknown fields outright rather than silently ignoring them.
      expect(res.status).toBe(400);
    });

    it("rejects an unknown permission key", async () => {
      const res = await request
        .post(BASE)
        .set(auth(admin.token))
        .send(newRole({ permissions: ["sale:create", "not:a:permission"] }));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/unknown permission/i);
    });

    it("rejects an organization-level permission in a store-scoped role", async () => {
      const res = await request
        .post(BASE)
        .set(auth(admin.token))
        .send(newRole({ permissions: ["sale:create", "report:view_org"] }));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not valid for a store-scoped role/i);
    });

    it("allows a store-level permission in an organization-scoped role", async () => {
      const res = await request
        .post(BASE)
        .set(auth(admin.token))
        .send(newRole({ scope: "organization", permissions: ["sale:create", "report:view_org"] }));

      expect(res.status).toBe(201);
    });

    it("rejects an empty permission list", async () => {
      const res = await request
        .post(BASE)
        .set(auth(admin.token))
        .send(newRole({ permissions: [] }));

      expect(res.status).toBe(400);
    });

    it("enforces the privilege ceiling: you cannot mint a role stronger than yourself", async () => {
      const limited = await Role.create({
        organizationId: org._id,
        scope: "organization",
        name: "Limited Admin",
        slug: "limited_admin",
        permissions: ["role:manage", "user:read"],
      });
      const limitedAdmin = await createUser(org._id, "limited@acme.test", {
        orgRoleId: limited._id,
      });

      const res = await request
        .post(BASE)
        .set(auth(limitedAdmin.token))
        .send(newRole({ permissions: ["sale:create"] }));

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/privilege ceiling/i);
    });

    it("refuses a store manager (not an organization-level role)", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("store_manager")._id }],
      });

      const res = await request.post(BASE).set(auth(manager.token)).send(newRole());
      expect(res.status).toBe(403);
    });

    it("writes an audit entry", async () => {
      const res = await request.post(BASE).set(auth(admin.token)).send(newRole()).expect(201);

      const entry = await AuditLog.findOne({ action: "role.created" });
      expect(entry).not.toBeNull();
      expect(String(entry!.targetId)).toBe(res.body.data.role._id);
      expect(entry!.after).toMatchObject({ slug: "shift_supervisor" });
    });
  });

  // =============================================================
  // Read
  // =============================================================

  describe("GET /roles", () => {
    it("reports how many users hold each role", async () => {
      await createUser(org._id, "c1@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("cashier")._id }],
      });
      await createUser(org._id, "c2@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("cashier")._id }],
      });

      const res = await request.get(BASE).set(auth(admin.token));
      expect(res.status).toBe(200);

      const byslug = (slug: string) =>
        res.body.data.roles.find((r: { slug: string }) => r.slug === slug);

      expect(byslug("cashier").usageCount).toBe(2);
      expect(byslug("org_admin").usageCount).toBe(1); // the admin themself
      expect(byslug("accountant").usageCount).toBe(0);
    });

    it("counts a user once even when they hold the role at several stores", async () => {
      const second = await Store.create({
        organizationId: org._id,
        name: "Store B",
        code: "BBB",
        address: {
          line1: "2 Main St",
          city: "Bengaluru",
          state: "Karnataka",
          country: "India",
          postalCode: "560001",
        },
        timezone: "Asia/Kolkata",
      });
      await createUser(org._id, "multi@acme.test", {
        storeAccess: [
          { storeId: store._id, roleId: roleOf("cashier")._id },
          { storeId: second._id, roleId: roleOf("cashier")._id },
        ],
      });

      const res = await request.get(BASE).set(auth(admin.token));
      const cashier = res.body.data.roles.find((r: { slug: string }) => r.slug === "cashier");
      expect(cashier.usageCount).toBe(1);
    });

    it("returns a single role with its usage count", async () => {
      const res = await request
        .get(`${BASE}/${roleOf("org_admin")._id}`)
        .set(auth(admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data.role.slug).toBe("org_admin");
      expect(res.body.data.role.usageCount).toBe(1);
    });

    it("returns 404 for a role in another organization", async () => {
      const other = await createOrg("other");
      const res = await request
        .get(`${BASE}/${other.role("cashier")._id}`)
        .set(auth(admin.token));

      expect(res.status).toBe(404);
    });

    it("does not list a deleted role", async () => {
      const created = await request.post(BASE).set(auth(admin.token)).send(newRole()).expect(201);
      await request
        .delete(`${BASE}/${created.body.data.role._id}`)
        .set(auth(admin.token))
        .expect(200);

      const res = await request.get(BASE).set(auth(admin.token));
      const slugs = res.body.data.roles.map((r: { slug: string }) => r.slug);
      expect(slugs).not.toContain("shift_supervisor");
    });
  });

  // =============================================================
  // Update
  // =============================================================

  describe("PATCH /roles/:roleId", () => {
    let customId: string;

    beforeEach(async () => {
      const res = await request.post(BASE).set(auth(admin.token)).send(newRole());
      customId = res.body.data.role._id;
    });

    it("renames a role without changing its slug", async () => {
      const res = await request
        .patch(`${BASE}/${customId}`)
        .set(auth(admin.token))
        .send({ name: "Floor Lead" });

      expect(res.status).toBe(200);
      expect(res.body.data.role.name).toBe("Floor Lead");
      expect(res.body.data.role.slug).toBe("shift_supervisor");
    });

    it("replaces the permission list", async () => {
      const res = await request
        .patch(`${BASE}/${customId}`)
        .set(auth(admin.token))
        .send({ permissions: ["sale:create", "product:read"] });

      expect(res.status).toBe(200);
      expect(res.body.data.role.permissions).toEqual(["sale:create", "product:read"]);
    });

    it("takes effect on the holder's very next request", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: customId }],
      });

      // The role has no user:read, so the roster is closed to them.
      await request.get("/api/v1/users").set(auth(staff.token)).expect(403);

      await request
        .patch(`${BASE}/${customId}`)
        .set(auth(admin.token))
        .send({ permissions: ["sale:create", "user:read"] })
        .expect(200);

      // Same token, no re-login needed.
      await request.get("/api/v1/users").set(auth(staff.token)).expect(200);
    });

    it("rejects a change of scope", async () => {
      const res = await request
        .patch(`${BASE}/${customId}`)
        .set(auth(admin.token))
        .send({ scope: "organization" });

      expect(res.status).toBe(400);
    });

    it("rejects a change of slug", async () => {
      const res = await request
        .patch(`${BASE}/${customId}`)
        .set(auth(admin.token))
        .send({ slug: "something_else" });

      expect(res.status).toBe(400);
    });

    it("rejects an empty body", async () => {
      const res = await request.patch(`${BASE}/${customId}`).set(auth(admin.token)).send({});
      expect(res.status).toBe(400);
    });

    it("rejects a permission that is out of scope for the role", async () => {
      const res = await request
        .patch(`${BASE}/${customId}`)
        .set(auth(admin.token))
        .send({ permissions: ["report:view_org"] });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not valid for a store-scoped role/i);
    });

    it("allows renaming a built-in role", async () => {
      const res = await request
        .patch(`${BASE}/${roleOf("cashier")._id}`)
        .set(auth(admin.token))
        .send({ name: "Till Operator" });

      expect(res.status).toBe(200);
      expect(res.body.data.role.name).toBe("Till Operator");
    });

    it("refuses to change a built-in role's permissions", async () => {
      const res = await request
        .patch(`${BASE}/${roleOf("cashier")._id}`)
        .set(auth(admin.token))
        .send({ permissions: ["sale:create"] });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/built-in role/i);
    });

    it("enforces the ceiling against the role's CURRENT permissions", async () => {
      // An admin who can manage roles but does not hold everything org_admin does.
      const limited = await Role.create({
        organizationId: org._id,
        scope: "organization",
        name: "Limited Admin",
        slug: "limited_admin",
        permissions: ["role:manage", "user:read", "sale:create"],
      });
      const limitedAdmin = await createUser(org._id, "limited@acme.test", {
        orgRoleId: limited._id,
      });

      // The target role grants more than the actor holds, so it is off limits even though
      // the actor is only trying to REDUCE it.
      const powerful = await Role.create({
        organizationId: org._id,
        scope: "store",
        name: "Powerful",
        slug: "powerful",
        permissions: ["sale:create", "inventory:adjust", "store:configure"],
      });

      const res = await request
        .patch(`${BASE}/${powerful._id}`)
        .set(auth(limitedAdmin.token))
        .send({ permissions: ["sale:create"] });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/privilege ceiling/i);
    });

    it("enforces the ceiling against the NEW permissions too", async () => {
      const limited = await Role.create({
        organizationId: org._id,
        scope: "organization",
        name: "Limited Admin",
        slug: "limited_admin",
        permissions: ["role:manage", "user:read", "sale:create"],
      });
      const limitedAdmin = await createUser(org._id, "limited@acme.test", {
        orgRoleId: limited._id,
      });
      const weak = await Role.create({
        organizationId: org._id,
        scope: "store",
        name: "Weak",
        slug: "weak",
        permissions: ["sale:create"],
      });

      // Dominates the role as it stands, but is trying to add something it does not hold.
      const res = await request
        .patch(`${BASE}/${weak._id}`)
        .set(auth(limitedAdmin.token))
        .send({ permissions: ["sale:create", "inventory:adjust"] });

      expect(res.status).toBe(403);
    });

    it("returns 404 for a role in another organization", async () => {
      const other = await createOrg("other");
      const res = await request
        .patch(`${BASE}/${other.role("cashier")._id}`)
        .set(auth(admin.token))
        .send({ name: "Hijacked" });

      expect(res.status).toBe(404);
    });

    it("writes an audit entry with before and after", async () => {
      await request
        .patch(`${BASE}/${customId}`)
        .set(auth(admin.token))
        .send({ permissions: ["sale:create"] })
        .expect(200);

      const entry = await AuditLog.findOne({ action: "role.updated" });
      expect(entry).not.toBeNull();
      expect(entry!.before).toMatchObject({ permissions: ["sale:create", "sale:refund"] });
      expect(entry!.after).toMatchObject({ permissions: ["sale:create"] });
    });
  });

  // =============================================================
  // Delete
  // =============================================================

  describe("DELETE /roles/:roleId", () => {
    let customId: string;

    beforeEach(async () => {
      const res = await request.post(BASE).set(auth(admin.token)).send(newRole());
      customId = res.body.data.role._id;
    });

    it("deletes an unused custom role", async () => {
      const res = await request.delete(`${BASE}/${customId}`).set(auth(admin.token));
      expect(res.status).toBe(200);

      const stored = await Role.findOne({ _id: customId }).setOptions({ isDelete: true });
      expect(await Role.findById(customId)).toBeNull(); // filtered by the soft-delete hook
      expect(stored === null || stored.isDelete).toBeTruthy();
    });

    it("frees the slug for reuse", async () => {
      await request.delete(`${BASE}/${customId}`).set(auth(admin.token)).expect(200);

      const again = await request.post(BASE).set(auth(admin.token)).send(newRole());
      expect(again.status).toBe(201);
      expect(again.body.data.role.slug).toBe("shift_supervisor");
    });

    it("refuses while a user holds the role at a store", async () => {
      await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: customId }],
      });

      const res = await request.delete(`${BASE}/${customId}`).set(auth(admin.token));
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/still assigned to 1 user\b/i);
    });

    it("refuses while a user holds the role organization-wide", async () => {
      const orgRole = await request
        .post(BASE)
        .set(auth(admin.token))
        .send(newRole({ name: "Ops Lead", scope: "organization" }));
      await createUser(org._id, "ops@acme.test", { orgRoleId: orgRole.body.data.role._id });

      const res = await request
        .delete(`${BASE}/${orgRole.body.data.role._id}`)
        .set(auth(admin.token));

      expect(res.status).toBe(409);
    });

    it("succeeds once the holders have been reassigned", async () => {
      const staff = await createUser(org._id, "staff@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: customId }],
      });
      await request.delete(`${BASE}/${customId}`).set(auth(admin.token)).expect(409);

      await request
        .patch(`/api/v1/users/${staff.user._id}/store-access/${store._id}`)
        .set(auth(admin.token))
        .send({ roleId: String(roleOf("cashier")._id) })
        .expect(200);

      await request.delete(`${BASE}/${customId}`).set(auth(admin.token)).expect(200);
    });

    it("refuses to delete a built-in role", async () => {
      const res = await request
        .delete(`${BASE}/${roleOf("accountant")._id}`)
        .set(auth(admin.token));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/built-in role/i);
    });

    it("enforces the ceiling", async () => {
      const limited = await Role.create({
        organizationId: org._id,
        scope: "organization",
        name: "Limited Admin",
        slug: "limited_admin",
        permissions: ["role:manage", "user:read", "sale:create"],
      });
      const limitedAdmin = await createUser(org._id, "limited@acme.test", {
        orgRoleId: limited._id,
      });
      const powerful = await Role.create({
        organizationId: org._id,
        scope: "store",
        name: "Powerful",
        slug: "powerful",
        permissions: ["sale:create", "inventory:adjust"],
      });

      const res = await request
        .delete(`${BASE}/${powerful._id}`)
        .set(auth(limitedAdmin.token));

      expect(res.status).toBe(403);
    });

    it("returns 404 for a role in another organization", async () => {
      const other = await createOrg("other");
      const custom = await Role.create({
        organizationId: other.org._id,
        scope: "store",
        name: "Theirs",
        slug: "theirs",
        permissions: ["sale:create"],
      });

      const res = await request.delete(`${BASE}/${custom._id}`).set(auth(admin.token));
      expect(res.status).toBe(404);
      expect(await Role.findById(custom._id)).not.toBeNull();
    });

    it("writes an audit entry", async () => {
      await request.delete(`${BASE}/${customId}`).set(auth(admin.token)).expect(200);

      const entry = await AuditLog.findOne({ action: "role.deleted" });
      expect(entry).not.toBeNull();
      expect(String(entry!.targetId)).toBe(customId);
    });
  });

  // =============================================================
  // Knock-on: the last-admin guard becomes reachable
  // =============================================================

  describe("the organization cannot lose its last administrator", () => {
    it("refuses when a non-administrator tries to deactivate the only admin", async () => {
      // Custom roles were expected to make the 409 last-admin guard reachable by separating
      // user:manage from user:manage_roles. They do not, and minScope enforcement closed the
      // gap further. The refusal below is a 403 from the ceiling, not the 409:
      //
      //   - to count as an administrator the TARGET must hold user:manage_roles;
      //   - canManageUser requires the ACTOR to hold everything the target holds, so the actor
      //     must hold user:manage_roles too;
      //   - user:manage_roles is minScope "organization", so it can only come from an
      //     ORGANISATION-scoped role — which is exactly what the admin count looks at.
      //
      // So any actor who can get past the ceiling is themselves a counted administrator, and
      // the remaining count is never zero. assertNotLastOrganizationAdmin is kept as
      // defense-in-depth (and for its transaction), not because this path can reach it.
      const opsRole = await Role.create({
        organizationId: org._id,
        scope: "organization",
        name: "Ops",
        slug: "ops",
        permissions: ["user:read", "user:manage"],
      });
      // The ceiling requires the actor to dominate the target (a full org_admin), and the
      // remaining permissions come from a store role so the ORG role stays non-administrative.
      const fullPowerStoreRole = await Role.create({
        organizationId: org._id,
        scope: "store",
        name: "Everything At Store",
        slug: "everything_at_store",
        permissions: roleOf("org_admin").permissions.filter((key) =>
          [
            "sale:create",
            "sale:void",
            "sale:refund",
            "product:read",
            "inventory:adjust",
            "report:view_store",
            "store:configure",
            "user:read",
            "user:invite",
          ].includes(key)
        ),
      });
      const ops = await createUser(org._id, "ops@acme.test", {
        orgRoleId: opsRole._id,
        storeAccess: [{ storeId: store._id, roleId: fullPowerStoreRole._id }],
      });

      const res = await request
        .patch(`/api/v1/users/${admin.user._id}/deactivate`)
        .set(auth(ops.token));

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/privilege ceiling/i);

      const stillActive = await User.findById(admin.user._id);
      expect(stillActive!.isActive).toBe(true);
    });
  });

  // =============================================================
  // Auth boundary
  // =============================================================

  describe("authentication and authorization", () => {
    it("rejects unauthenticated requests", async () => {
      await request.get(BASE).expect(401);
      await request.post(BASE).send(newRole()).expect(401);
      await request.delete(`${BASE}/${roleOf("cashier")._id}`).expect(401);
    });

    it("lets a cashier neither read nor write roles", async () => {
      const cashier = await createUser(org._id, "cash@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("cashier")._id }],
      });

      await request.get(BASE).set(auth(cashier.token)).expect(403);
      await request.post(BASE).set(auth(cashier.token)).send(newRole()).expect(403);
    });

    it("lets a store manager read roles but not create them", async () => {
      const manager = await createUser(org._id, "mgr@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("store_manager")._id }],
      });

      await request.get(BASE).set(auth(manager.token)).expect(200);
      await request.post(BASE).set(auth(manager.token)).send(newRole()).expect(403);
    });

    it("keeps /roles/permissions reachable and ahead of the :roleId route", async () => {
      const res = await request.get(`${BASE}/permissions`).set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.permissions.length).toBeGreaterThan(0);
      expect(res.body.data.permissions[0]).toHaveProperty("minScope");
    });
  });
});
