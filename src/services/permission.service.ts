/**
 * Purpose: Permission Service.
 * Resolves effective permissions for users (handling platform, organization, and store scopes)
 * and guards against privilege escalation when creating or assigning roles.
 */

import { IUser } from "../models/user.model";
import { IRole, Role } from "../models/role.model";

/**
 * Resolves the full list of effective permissions for a user.
 *
 * DESIGN DECISION:
 * Org-level and store-level permissions union together rather than overriding each other.
 * If a user is an 'accountant' (org scope) and 'cashier' (store scope), they get permissions of both.
 * For platform Super Admins (isSuperAdmin: true), we immediately return ['*'] to bypass checks.
 *
 * @param user The User document.
 * @param storeId Optional store context identifier.
 * @returns Array of unique active permission keys.
 */
export async function getEffectivePermissions(
  user: IUser,
  storeId?: string
): Promise<string[]> {
  // 1. Super Admin gets wildcard bypass immediately
  if (user.isSuperAdmin) {
    return ["*"];
  }

  const permissionsSet = new Set<string>();

  // 2. Fetch Organization-level permissions (if orgRoleId is assigned)
  if (user.orgRoleId) {
    const orgRole = (await Role.findById(user.orgRoleId).lean().exec()) as
      (IRole & { isActive?: boolean }) | null;
    if (orgRole && orgRole.isActive !== false) {
      orgRole.permissions.forEach((perm) => permissionsSet.add(perm));
    }
  }

  // 3. Fetch Store-level permissions (if storeId is provided and user has access to it)
  if (storeId && user.storeAccess && user.storeAccess.length > 0) {
    const matchingAccess = user.storeAccess.find(
      (access) => access.storeId.toString() === storeId
    );

    if (matchingAccess) {
      const storeRole = (await Role.findById(matchingAccess.roleId)
        .lean()
        .exec()) as (IRole & { isActive?: boolean }) | null;
      if (storeRole && storeRole.isActive !== false) {
        storeRole.permissions.forEach((perm) => permissionsSet.add(perm));
      }
    }
  }

  return Array.from(permissionsSet);
}

// Scope hierarchy ranking for privilege escalation checks
const SCOPE_RANK = {
  platform: 3,
  organization: 2,
  store: 1,
};

/**
 * Validates whether a granting user has sufficient permissions and scope hierarchy to assign/create a role.
 * Prevents privilege escalation. E.g., a Store Manager cannot create/assign a role containing organization configuration
 * permissions or promote someone to an Org Admin.
 *
 * @param grantingUserPermissions Effective permissions of the user performing the action.
 * @param grantingUserScope Highest scope level of the user performing the action.
 * @param targetRole The Role structure to be created or assigned.
 * @returns Boolean indicating if the operation is valid.
 */
export function canGrantRole(
  grantingUserPermissions: string[],
  grantingUserScope: "platform" | "organization" | "store",
  targetRole: IRole
): boolean {
  // 1. Super Admins (with '*' permission) can grant any role
  if (grantingUserPermissions.includes("*")) {
    return true;
  }

  // 2. Scope check: Grantor's scope rank must be greater than or equal to target role's scope rank
  const grantorRank = SCOPE_RANK[grantingUserScope] || 0;
  const targetRank = SCOPE_RANK[targetRole.scope] || 0;

  if (targetRank > grantorRank) {
    return false;
  }

  // 3. Permissions check: Every permission in the target role must be possessed by the grantor
  const hasAllPermissions = targetRole.permissions.every((perm) =>
    grantingUserPermissions.includes(perm)
  );

  return hasAllPermissions;
}
