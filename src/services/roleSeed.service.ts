/**
 * Purpose: Role Seeding Service.
 * Seeds standard, default system roles for an organization during tenant provisioning/signup.
 */

import mongoose from "mongoose";
import { Role, IRole } from "../models/role.model";
import {
  PERMISSION_CATALOG,
  PermissionKey,
} from "../config/permissions.catalog";

interface DefaultRoleTemplate {
  slug: string;
  name: string;
  scope: "organization" | "store";
  permissions: PermissionKey[];
}

/**
 * Static templates for default system roles.
 * Adjust permissions according to sensible operational access levels.
 */
const DEFAULT_ROLE_TEMPLATES: DefaultRoleTemplate[] = [
  {
    slug: "org_admin",
    name: "Organization Administrator",
    scope: "organization",
    // Org Admin gets every permission that is not strictly platform-scoped
    permissions: PERMISSION_CATALOG.filter(
      (perm) => perm.minScope !== "platform"
    ).map((perm) => perm.key),
  },
  {
    slug: "store_manager",
    name: "Store Manager",
    scope: "store",
    permissions: [
      "sale:create",
      "sale:void",
      "sale:refund",
      "product:read",
      "inventory:adjust",
      "report:view_store",
      "store:configure",
      // A store manager staffs their own store. The privilege ceiling in canGrantRole still
      // stops them granting any role whose permissions exceed their own.
      "user:read",
      "user:invite",
    ],
  },
  {
    slug: "cashier",
    name: "Cashier",
    scope: "store",
    permissions: ["sale:create", "product:read", "report:view_store"],
  },
  {
    slug: "accountant",
    name: "Accountant",
    scope: "organization",
    permissions: ["report:view_org", "report:view_store", "sale:refund"],
  },
  {
    slug: "inventory_clerk",
    name: "Inventory Clerk",
    scope: "store",
    permissions: ["product:read", "inventory:adjust"],
  },
];

/**
 * Seeds default roles for a newly registered or updated organization.
 * Bypasses creation if a role with the same slug already exists for the organization.
 *
 * DESIGN DECISION:
 * Default roles are marked with `isSystemRole: true` to prevent user deletion,
 * but their permission lists are stored as standard documents in MongoDB. This allows
 * organizations to customize default roles or add brand new custom roles dynamically.
 *
 * @param organizationId The ObjectId of the organization.
 * @returns Array of created or existing Role documents.
 */
export async function seedDefaultRolesForOrganization(
  organizationId: mongoose.Types.ObjectId | string,
  options?: { session?: mongoose.ClientSession }
): Promise<IRole[]> {
  const orgId =
    typeof organizationId === "string"
      ? new mongoose.Types.ObjectId(organizationId)
      : organizationId;

  const roles: IRole[] = [];

  for (const template of DEFAULT_ROLE_TEMPLATES) {
    // Check if the role already exists to maintain idempotency
    let role = await Role.findOne({
      organizationId: orgId,
      slug: template.slug,
    }).session(options?.session || null);

    if (role) {
      // The role exists, but the permission catalog may have grown since it was seeded.
      // Union in any template permissions it is missing so organizations created before a
      // catalog change do not silently lack keys that new endpoints check for.
      const added = unionMissingPermissions(role, template.permissions);
      if (added.length > 0) {
        await role.save({ session: options?.session });
      }
    }

    if (!role) {
      const [newRole] = await Role.create(
        [
          {
            organizationId: orgId,
            scope: template.scope,
            name: template.name,
            slug: template.slug,
            isSystemRole: true, // Prevents deletion
            permissions: template.permissions,
          },
        ],
        options
      );
      role = newRole;
    }

    roles.push(role);
  }

  return roles;
}

/**
 * Adds any template permissions the role is missing, in place. Returns the keys that were added.
 *
 * DESIGN DECISION (additive, never subtractive):
 * Organizations may customize system roles, so a reconcile must not clobber their edits.
 * We only ever add. The trade-off is that a permission an organization deliberately removed
 * from a system role will come back on the next sync; once role editing ships (role:manage),
 * permission edits on system roles should be blocked so this case cannot arise.
 */
function unionMissingPermissions(
  role: IRole,
  templatePermissions: PermissionKey[]
): PermissionKey[] {
  const current = new Set<string>(role.permissions);
  const added = templatePermissions.filter((perm) => !current.has(perm));
  if (added.length > 0) {
    role.permissions = [...role.permissions, ...added];
  }
  return added;
}

/**
 * Reconciles the default system roles of existing organizations against DEFAULT_ROLE_TEMPLATES.
 *
 * WHY THIS EXISTS:
 * seedDefaultRolesForOrganization is idempotent *by slug* — it skips a role that already exists.
 * So adding a key to the permission catalog does not reach organizations that were seeded
 * earlier, and their org_admin silently 403s on any endpoint guarding the new key.
 * Run this after every catalog change (scripts/syncSystemRoles.ts).
 *
 * @param organizationId Restrict the sync to one organization. Omit to sync every organization.
 * @returns Per-role summary of the permissions that were added.
 */
export async function syncSystemRolePermissions(
  organizationId?: mongoose.Types.ObjectId | string
): Promise<{ roleId: string; slug: string; added: PermissionKey[] }[]> {
  const filter: Record<string, unknown> = { isSystemRole: true };
  if (organizationId) {
    filter.organizationId =
      typeof organizationId === "string"
        ? new mongoose.Types.ObjectId(organizationId)
        : organizationId;
  }

  const templatesBySlug = new Map(
    DEFAULT_ROLE_TEMPLATES.map((template) => [template.slug, template])
  );

  // Bypass the tenant scoping plugin: this is a maintenance routine that spans organizations
  // and runs outside any request context, so organizationId is set explicitly above (or absent).
  const roles = await Role.find(filter);
  const results: { roleId: string; slug: string; added: PermissionKey[] }[] = [];

  for (const role of roles) {
    const template = templatesBySlug.get(role.slug);
    if (!template) {
      continue; // A system role with no matching template (renamed/retired) is left alone.
    }

    const added = unionMissingPermissions(role, template.permissions);
    if (added.length > 0) {
      await role.save();
      results.push({ roleId: role._id.toString(), slug: role.slug, added });
    }
  }

  return results;
}
