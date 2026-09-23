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
import {
  seedDefaultRolesForOrganization,
  syncSystemRolePermissions,
} from "../../src/services/roleSeed.service";
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

  // =============================================================
  // resolveUniqueSlug boundaries
  // =============================================================

  describe("slug derivation boundaries", () => {
    it("rejects a name that slugifies to nothing, even though it clears the 2-character minimum", async () => {
      // Zod's min(2) counts raw characters, so "!!" is accepted by the validator; slugifyRoleName
      // then strips every character that is not a word character, whitespace or hyphen, leaving
      // an empty string. The 400 in resolveUniqueSlug is meant for exactly this.
      const res = await request.post(BASE).set(auth(admin.token)).send(newRole({ name: "!!" }));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/at least one letter or number/i);
    });

    it("treats names differing only by case and punctuation as the same slug", async () => {
      await request
        .post(BASE)
        .set(auth(admin.token))
        .send(newRole({ name: "shift supervisor" }))
        .expect(201);

      const res = await request
        .post(BASE)
        .set(auth(admin.token))
        .send(newRole({ name: "SHIFT -- Supervisor!!" }));

      expect(res.status).toBe(201);
      expect(res.body.data.role.slug).toBe("shift_supervisor_2");
    });

    it("gives up after 20 collisions with a 409 rather than looping forever", async () => {
      const base = "shift_supervisor";
      const occupiedSlugs = [base, ...Array.from({ length: 19 }, (_, i) => `${base}_${i + 2}`)];
      await Role.insertMany(
        occupiedSlugs.map((slug, i) => ({
          organizationId: org._id,
          scope: "store",
          name: `Occupant ${i}`,
          slug,
          permissions: ["sale:create"],
        }))
      );

      const res = await request.post(BASE).set(auth(admin.token)).send(newRole());

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/unique slug/i);
    });
  });

  // =============================================================
  // listRoles usageCount vs getRole usageCount (aggregation bypasses tenantScope/soft-delete)
  // =============================================================

  describe("usageCount consistency", () => {
    it("excludes a soft-deleted holder from usageCount in BOTH listRoles and getRole", async () => {
      // getRole's usageCount comes from countRoleHolders, which uses User.countDocuments — a
      // method the tenantScope plugin hooks, and that hook injects `isDelete: { $ne: true }`
      // UNCONDITIONALLY (not only when a request context is present). So a soft-deleted holder
      // is excluded there.
      //
      // listRoles' usageCount instead comes from a raw User.aggregate([...]) pipeline, and the
      // tenantScope plugin does NOT hook aggregate() — its targetMethods list covers
      // find/findOne/findOneAndUpdate/countDocuments/updateMany/updateOne/deleteOne/deleteMany
      // only. So listRoles has to write the soft-delete filter into its $match stage by hand.
      // Without it the two endpoints disagree about whether the same role is "in use".
      const holder = await createUser(org._id, "ghost@acme.test", {
        storeAccess: [{ storeId: store._id, roleId: roleOf("cashier")._id }],
      });
      await User.updateOne({ _id: holder.user._id }, { $set: { isDelete: true } });

      const listRes = await request.get(BASE).set(auth(admin.token));
      const cashierFromList = listRes.body.data.roles.find(
        (r: { slug: string }) => r.slug === "cashier"
      );
      const getRes = await request
        .get(`${BASE}/${roleOf("cashier")._id}`)
        .set(auth(admin.token));

      expect(getRes.body.data.role.usageCount).toBe(0);
      expect(cashierFromList.usageCount).toBe(0);
    });
  });

  // =============================================================
  // Deleted-role fallout: fail closed, asserted rather than assumed
  // =============================================================

  describe("a role deleted out from under its holder", () => {
    it("resolves to zero permissions from that role on the holder's next request (fails closed)", async () => {
      const created = await request
        .post(BASE)
        .set(auth(admin.token))
        .send(newRole({ permissions: ["user:read"] }))
        .expect(201);
      const roleId = created.body.data.role._id;

      const staff = await createUser(org._id, "staff2@acme.test", {
        storeAccess: [{ storeId: store._id, roleId }],
      });

      // Holds user:read only through this role.
      await request.get("/api/v1/users").set(auth(staff.token)).expect(200);

      // The API itself refuses to delete a role while it is held (see the 409 tests above), so
      // this simulates the only other ways it can happen: direct DB manipulation, or the
      // concurrency race demonstrated below.
      await Role.updateOne({ _id: roleId }, { $set: { isDelete: true } });

      const res = await request.get("/api/v1/users").set(auth(staff.token));
      expect(res.status).toBe(403);
    });
  });

  // =============================================================
  // syncSystemRolePermissions interaction with custom roles
  // =============================================================

  describe("syncSystemRolePermissions and custom roles", () => {
    it("does not touch a custom role even when its slug collides with a system template's base slug", async () => {
      // "Org Admin" collides with the seeded org_admin system role's slug, so resolveUniqueSlug
      // suffixes it — it can never actually acquire the bare "org_admin" slug while that system
      // role exists.
      const res = await request
        .post(BASE)
        .set(auth(admin.token))
        .send(newRole({ name: "Org Admin", scope: "organization", permissions: ["user:read"] }));

      expect(res.status).toBe(201);
      expect(res.body.data.role.slug).toBe("org_admin_2");

      await syncSystemRolePermissions(org._id);

      const customRoleAfter = await Role.findById(res.body.data.role._id);
      expect(customRoleAfter!.isSystemRole).toBe(false);
      expect(customRoleAfter!.permissions).toEqual(["user:read"]); // untouched by the reconcile
    });

    it("keeps matching a renamed system role by its immutable slug, not by name", async () => {
      await request
        .patch(`${BASE}/${roleOf("cashier")._id}`)
        .set(auth(admin.token))
        .send({ name: "Till Operator" })
        .expect(200);

      // The API refuses to change a system role's permissions at all, so this simulates a
      // permission the reconcile is meant to restore (e.g. one dropped before role editing
      // shipped, per unionMissingPermissions' own docstring).
      await Role.updateOne(
        { _id: roleOf("cashier")._id },
        { $set: { permissions: ["sale:create"] } }
      );

      await syncSystemRolePermissions(org._id);

      const reconciled = await Role.findById(roleOf("cashier")._id);
      expect(reconciled!.name).toBe("Till Operator"); // rename preserved
      expect(reconciled!.permissions).toEqual(
        expect.arrayContaining(["product:read", "report:view_store"])
      );
    });
  });

  // =============================================================
  // Concurrency: is the transaction actually protecting anything?
  // =============================================================

  describe("deleteRole concurrency", () => {
    it("REAL RACE: a concurrent grant slipping in between the holder count and the commit is not prevented by the transaction", async () => {
      // deleteRole's docstring claims a concurrent assignment "cannot slip in between the check
      // and the delete" because the count happens inside the transaction. That is only true for
      // writes that are themselves part of the SAME transaction: MongoDB's snapshot isolation
      // stops the transaction from being confused by ITS OWN reads, and detects write conflicts
      // when two transactions touch the SAME document — but grantStoreAccess (POST
      // /users/:userId/store-access) takes no session at all, writes a DIFFERENT document (the
      // User, not the Role), and commits immediately and independently. Nothing about the
      // delete transaction can see, block, or conflict with it.
      //
      // This test replicates deleteRole's own read/write sequence by hand so the interleaving
      // is deterministic instead of racing real wall-clock concurrency.
      const created = await request.post(BASE).set(auth(admin.token)).send(newRole()).expect(201);
      const roleId = created.body.data.role._id;
      const staff = await createUser(org._id, "race@acme.test", {});

      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const role = await Role.findOne({ _id: roleId, organizationId: org._id }).session(
          session
        );
        const holders = await User.countDocuments({
          organizationId: org._id,
          $or: [{ orgRoleId: role!._id }, { "storeAccess.roleId": role!._id }],
        }).session(session);
        expect(holders).toBe(0); // deleteRole's 409 guard would not fire yet either

        // A second administrator grants this very role to a new hire WHILE the delete
        // transaction above is still open.
        const grantRes = await request
          .post(`/api/v1/users/${staff.user._id}/store-access`)
          .set(auth(admin.token))
          .send({ storeId: String(store._id), roleId });
        expect(grantRes.status).toBe(201);

        // The open transaction's snapshot was taken before the grant, so it never sees it, and
        // proceeds to soft-delete the role exactly as deleteRole would.
        role!.isDelete = true;
        await role!.save({ session });
        await session.commitTransaction();
      } finally {
        session.endSession();
      }

      expect(await Role.findById(roleId)).toBeNull(); // the role is gone...
      const reloadedStaff = await User.findById(staff.user._id);
      // ...but the concurrently-granted assignment still references it. Their effective
      // permissions from it fail closed (see the block above), but the delete's own in-use
      // guard did not catch this holder, and the dangling assignment is now invisible to
      // listRoles/getRole (a deleted role is filtered out of both).
      expect(
        reloadedStaff!.storeAccess.some((a) => a.roleId.toString() === roleId)
      ).toBe(true);
    });
  });

  // =============================================================
  // Concurrency: the last-organization-admin guard has the same shape of race
  // =============================================================

  describe("assertNotLastOrganizationAdmin concurrency", () => {
    it("REAL RACE: two concurrent demotions of the organization's only two admins can both pass, leaving zero", async () => {
      // The guard's own comment claims it "MUST run inside the same transaction as the
      // mutation it guards" to stop two concurrent demotions from each reading "one other admin
      // remains". Running inside A transaction stops conflicts on documents that transaction
      // itself writes — it does not stop a DIFFERENT transaction, reading and writing a
      // DIFFERENT user document, from reaching the same stale conclusion. Replicated here by
      // hand (two real sessions, real transactions) rather than raced over HTTP, so the
      // interleaving is deterministic.
      const admin2 = await createUser(org._id, "admin2@acme.test", {
        orgRoleId: roleOf("org_admin")._id,
      });

      const session1 = await mongoose.startSession();
      const session2 = await mongoose.startSession();
      session1.startTransaction();
      session2.startTransaction();

      try {
        const remaining1 = await User.countDocuments({
          organizationId: org._id,
          orgRoleId: roleOf("org_admin")._id,
          isActive: true,
          _id: { $ne: admin2.user._id },
        }).session(session1);
        const remaining2 = await User.countDocuments({
          organizationId: org._id,
          orgRoleId: roleOf("org_admin")._id,
          isActive: true,
          _id: { $ne: admin.user._id },
        }).session(session2);

        expect(remaining1).toBe(1); // admin is still active, from session1's point of view
        expect(remaining2).toBe(1); // admin2 is still active, from session2's point of view

        await User.updateOne(
          { _id: admin2.user._id },
          { $set: { isActive: false } }
        ).session(session1);
        await User.updateOne(
          { _id: admin.user._id },
          { $set: { isActive: false } }
        ).session(session2);

        await session1.commitTransaction();
        await session2.commitTransaction();
      } finally {
        session1.endSession();
        session2.endSession();
      }

      const [reloadedAdmin, reloadedAdmin2] = await Promise.all([
        User.findById(admin.user._id),
        User.findById(admin2.user._id),
      ]);

      // Both admins are now inactive: the organization has zero active administrators, which
      // this guard exists specifically to prevent.
      expect(reloadedAdmin!.isActive).toBe(false);
      expect(reloadedAdmin2!.isActive).toBe(false);
    });
  });
});
