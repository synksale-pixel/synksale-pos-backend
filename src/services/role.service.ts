/**
 * Purpose: Role Service.
 * Reading and managing the roles defined in an organization.
 *
 * The read side exists so a client can resolve a roleId for the invite and staffing endpoints
 * (they all require one, and nothing else exposes it). The write side lets an organization
 * define roles beyond the five seeded at signup.
 *
 * PRIVILEGE MODEL:
 *  - canGrantRole  — you cannot create or move a role to a permission set you do not hold
 *                    yourself. This is what stops role creation being an escalation hole.
 *  - canModifyRole — you must also dominate the role AS IT STANDS, so a limited administrator
 *                    cannot edit or delete a role more powerful than they are.
 */

import mongoose from "mongoose";
import { Role, IRole, RoleDocument } from "../models/role.model";
import { User } from "../models/user.model";
import {
  canGrantRole,
  canModifyRole,
  PermissionScope,
} from "./permission.service";
import { recordAudit } from "./audit.service";
import {
  PERMISSION_CATALOG,
  permissionFitsScope,
} from "../config/permissions.catalog";
import { ApiError } from "../utils/ApiError";
import { logger } from "../config/logger.config";

export interface ListRolesInput {
  scope?: "organization" | "store";
}

export interface CreateRoleInput {
  name: string;
  scope: "organization" | "store";
  permissions: string[];
}

export interface UpdateRoleInput {
  name?: string;
  permissions?: string[];
}

export interface RoleActor {
  permissions: string[];
  scope: PermissionScope;
  userId: string;
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Builds a role slug from its display name.
 * Underscores, to match the seeded roles (org_admin, store_manager).
 */
function slugifyRoleName(name: string): string {
  return name
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]+/g, "") // drop punctuation
    .replace(/[\s-]+/g, "_") // spaces and hyphens become underscores
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Finds a free slug for this organization, appending -2, -3 … on collision.
 * The unique index excludes soft-deleted roles, so a deleted role's slug is reusable.
 */
async function resolveUniqueSlug(
  organizationId: string,
  name: string,
  session?: mongoose.ClientSession
): Promise<string> {
  const base = slugifyRoleName(name);
  if (!base) {
    throw new ApiError(400, "Role name must contain at least one letter or number.");
  }

  for (let attempt = 1; attempt <= 20; attempt++) {
    const candidate = attempt === 1 ? base : `${base}_${attempt}`;
    const existing = await Role.findOne({ organizationId, slug: candidate })
      .session(session ?? null)
      .lean();
    if (!existing) {
      return candidate;
    }
  }

  throw new ApiError(
    409,
    "Could not generate a unique slug for this role name. Try a more distinctive name."
  );
}

/** Rejects permissions that are unknown, or not meaningful at the role's scope. */
function assertPermissionsValidForScope(
  scope: "organization" | "store",
  permissions: string[]
): void {
  const known = new Set(PERMISSION_CATALOG.map((definition) => definition.key));

  const unknown = permissions.filter((key) => !known.has(key as never));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      `Unknown permission(s): ${unknown.join(", ")}. See GET /roles/permissions for the catalog.`
    );
  }

  const outOfScope = permissions.filter((key) => !permissionFitsScope(scope, key));
  if (outOfScope.length > 0) {
    throw new ApiError(
      400,
      `Permission(s) not valid for a ${scope}-scoped role: ${outOfScope.join(", ")}. ` +
        "An organization-wide permission cannot be granted by a role that only applies to one store."
    );
  }
}

/** Loads a role in the caller's organization, or 404s. */
async function loadRole(
  organizationId: string,
  roleId: string,
  session?: mongoose.ClientSession
): Promise<RoleDocument> {
  const role = (await Role.findOne({ _id: roleId, organizationId }).session(
    session ?? null
  )) as RoleDocument | null;

  if (!role) {
    throw new ApiError(404, "Role not found or does not belong to your organization.");
  }

  return role;
}

/** Counts users holding this role, either organization-wide or at any store. */
async function countRoleHolders(
  organizationId: string,
  roleId: mongoose.Types.ObjectId,
  session?: mongoose.ClientSession
): Promise<number> {
  return User.countDocuments({
    organizationId,
    $or: [{ orgRoleId: roleId }, { "storeAccess.roleId": roleId }],
  }).session(session ?? null);
}

// ============================================================
// Reads
// ============================================================

/**
 * Returns every non-deleted role belonging to the organization, organization-scoped first so
 * the more privileged roles are at the top of a picker. Each role carries a `usageCount` so a
 * client can warn before attempting a delete that would be refused.
 */
export async function listRoles(
  organizationId: string,
  input: ListRolesInput = {}
) {
  const filter: Record<string, unknown> = { organizationId };
  if (input.scope) {
    filter.scope = input.scope;
  }

  const roles = await Role.find(filter).sort({ scope: 1, name: 1 });

  // One grouped count for the whole page rather than a query per role.
  const usage = await User.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { organizationId: new mongoose.Types.ObjectId(organizationId) } },
    {
      $project: {
        roleIds: {
          $setUnion: [
            { $cond: [{ $ifNull: ["$orgRoleId", false] }, ["$orgRoleId"], []] },
            { $ifNull: ["$storeAccess.roleId", []] },
          ],
        },
      },
    },
    { $unwind: "$roleIds" },
    { $group: { _id: "$roleIds", count: { $sum: 1 } } },
  ]);

  const usageByRole = new Map(usage.map((row) => [row._id.toString(), row.count]));

  return roles.map((role) => ({
    ...role.toObject(),
    usageCount: usageByRole.get(role._id.toString()) ?? 0,
  }));
}

/** Fetches one role in the caller's organization, with its usage count. */
export async function getRole(organizationId: string, roleId: string) {
  const role = await loadRole(organizationId, roleId);
  const usageCount = await countRoleHolders(organizationId, role._id);
  return { ...role.toObject(), usageCount };
}

/** The fixed vocabulary of permissions the system understands. Static, identical per tenant. */
export function listPermissionCatalog() {
  return PERMISSION_CATALOG;
}

// ============================================================
// Writes
// ============================================================

/**
 * Creates a custom role. The slug is derived from the name and is never accepted from the
 * client: it is the key syncSystemRolePermissions matches templates on, and a client-chosen
 * slug could collide with a system role's.
 */
export async function createRole(
  organizationId: string,
  actor: RoleActor,
  input: CreateRoleInput
) {
  assertPermissionsValidForScope(input.scope, input.permissions);

  // You cannot mint a role more powerful than yourself.
  const proposed = {
    scope: input.scope,
    permissions: input.permissions,
  } as IRole;
  if (!canGrantRole(actor.permissions, actor.scope, proposed)) {
    throw new ApiError(
      403,
      "Access Denied: Privilege ceiling violation. You cannot create a role whose scope or permissions exceed your own."
    );
  }

  const slug = await resolveUniqueSlug(organizationId, input.name);

  const role = await Role.create({
    organizationId: new mongoose.Types.ObjectId(organizationId),
    scope: input.scope,
    name: input.name.trim(),
    slug,
    isSystemRole: false, // Only the seeded templates are system roles.
    permissions: input.permissions,
  });

  await recordAudit({
    organizationId,
    actorUserId: actor.userId,
    action: "role.created",
    targetType: "role",
    targetId: role._id,
    after: { name: role.name, slug: role.slug, scope: role.scope, permissions: role.permissions },
  });

  logger.info(
    `Role created: ${role._id} (${slug}, ${input.scope}) org=${organizationId} by user=${actor.userId}`
  );

  return { ...role.toObject(), usageCount: 0 };
}

/**
 * Renames a role and/or replaces its permission list.
 *
 * IMMUTABLE BY DESIGN:
 *  - `scope`: flipping a store role to organization scope would instantly hand organization-wide
 *    powers to everyone already holding it — a silent mass escalation with no record of who
 *    gained what. Create a new role instead.
 *  - `slug`: it is what syncSystemRolePermissions matches on, so changing it would orphan a role
 *    from its template. It also keeps existing integrations stable.
 *
 * Permission changes take effect on the holders' NEXT request: access tokens carry no
 * permissions and `authorize` resolves them from the database every time.
 */
export async function updateRole(
  organizationId: string,
  actor: RoleActor,
  roleId: string,
  input: UpdateRoleInput
) {
  const role = await loadRole(organizationId, roleId);

  // System roles may be renamed but their permissions are fixed: syncSystemRolePermissions
  // re-adds template permissions additively, so an edit here would be silently undone on the
  // next catalog change. Organizations that need a different permission set create a custom role.
  if (role.isSystemRole && input.permissions) {
    throw new ApiError(
      400,
      `'${role.name}' is a built-in role and its permissions cannot be changed. Create a custom role instead.`
    );
  }

  if (input.permissions) {
    assertPermissionsValidForScope(
      role.scope as "organization" | "store",
      input.permissions
    );
  }

  if (!canModifyRole(actor.permissions, actor.scope, role, input.permissions)) {
    throw new ApiError(
      403,
      "Access Denied: Privilege ceiling violation. You cannot modify a role whose scope or permissions exceed your own."
    );
  }

  const before = { name: role.name, permissions: [...role.permissions] };

  if (input.name !== undefined) {
    role.name = input.name.trim();
  }
  if (input.permissions !== undefined) {
    role.permissions = input.permissions as typeof role.permissions;
  }

  await role.save();

  await recordAudit({
    organizationId,
    actorUserId: actor.userId,
    action: "role.updated",
    targetType: "role",
    targetId: role._id,
    before,
    after: { name: role.name, permissions: role.permissions },
  });

  logger.info(
    `Role updated: ${roleId} org=${organizationId} by user=${actor.userId}`
  );

  const usageCount = await countRoleHolders(organizationId, role._id);
  return { ...role.toObject(), usageCount };
}

/**
 * Soft-deletes a custom role.
 *
 * REFUSED WHILE THE ROLE IS IN USE: a deleted role is filtered out by the Role pre-query hook,
 * so getEffectivePermissions would resolve it to null and its holders would silently have zero
 * permissions at that store. That fails closed, which is right, but it is invisible to the
 * administrator and undebuggable for the user. Reassign the holders first.
 *
 * Soft rather than hard delete so audit entries and historical references can still resolve the
 * role's name. The unique index excludes soft-deleted rows, so the slug is released for reuse.
 */
export async function deleteRole(
  organizationId: string,
  actor: RoleActor,
  roleId: string
) {
  const session = await mongoose.startSession();

  try {
    let deletedName = "";
    let deletedId: mongoose.Types.ObjectId | null = null;

    await session.withTransaction(async () => {
      const role = await loadRole(organizationId, roleId, session);

      if (role.isSystemRole) {
        throw new ApiError(
          400,
          `'${role.name}' is a built-in role and cannot be deleted.`
        );
      }

      if (!canModifyRole(actor.permissions, actor.scope, role)) {
        throw new ApiError(
          403,
          "Access Denied: Privilege ceiling violation. You cannot delete a role whose scope or permissions exceed your own."
        );
      }

      // Counted inside the transaction so a concurrent assignment cannot slip in between
      // the check and the delete.
      const holders = await countRoleHolders(organizationId, role._id, session);
      if (holders > 0) {
        throw new ApiError(
          409,
          `This role is still assigned to ${holders} user${holders === 1 ? "" : "s"}. Reassign them before deleting it.`
        );
      }

      role.isDelete = true;
      await role.save({ session });

      deletedName = role.name;
      deletedId = role._id;
    });

    await recordAudit({
      organizationId,
      actorUserId: actor.userId,
      action: "role.deleted",
      targetType: "role",
      targetId: deletedId!,
      before: { name: deletedName },
    });

    logger.info(
      `Role deleted: ${roleId} (${deletedName}) org=${organizationId} by user=${actor.userId}`
    );
  } finally {
    await session.endSession();
  }
}
