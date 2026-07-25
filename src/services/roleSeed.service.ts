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
  organizationId: mongoose.Types.ObjectId | string
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
    });

    if (!role) {
      role = await Role.create({
        organizationId: orgId,
        scope: template.scope,
        name: template.name,
        slug: template.slug,
        isSystemRole: true, // Prevents deletion
        permissions: template.permissions,
      });
    }

    roles.push(role);
  }

  return roles;
}
