/**
 * Purpose: Permission Service.
 * Resolves effective permissions for users (handling platform, organization, and store scopes)
 * and guards against privilege escalation when creating or assigning roles.
 */

import mongoose from "mongoose";
import { IUser } from "../models/user.model";
import { IRole, Role } from "../models/role.model";

export type PermissionScope = "platform" | "organization" | "store";

/** Reads an ObjectId out of a reference field that may or may not have been populated. */
function refToId(
  ref: unknown
): mongoose.Types.ObjectId | null {
  if (!ref) return null;
  if (ref instanceof mongoose.Types.ObjectId) return ref;
  if (typeof ref === "string") return new mongoose.Types.ObjectId(ref);
  const populated = ref as { _id?: mongoose.Types.ObjectId };
  return populated._id ?? null;
}

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
    const orgRole = (await Role.findById(user.orgRoleId).lean().exec()) as IRole | null;
    if (orgRole) {
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
        .exec()) as IRole | null;
      if (storeRole) {
        storeRole.permissions.forEach((perm) => permissionsSet.add(perm));
      }
    }
  }

  return Array.from(permissionsSet);
}

/**
 * Resolves permissions the user holds ANYWHERE: their organization role unioned with the role
 * they hold at every one of their stores.
 *
 * WHY THIS EXISTS:
 * getEffectivePermissions only consults a store role when a specific storeId is supplied, which
 * is correct for store-scoped actions. But some endpoints are legitimately store-agnostic — the
 * staff roster, the role list — and a store manager holds `user:read` only through their store
 * role. Without this they could never satisfy the permission check on those routes at all.
 *
 * This answers "may you do X somewhere", not "may you do X here". Endpoints using it must still
 * narrow the RESULT to what the caller may see (listUsers/getUser do exactly that).
 */
export async function getPermissionsAcrossStores(user: IUser): Promise<string[]> {
  if (user.isSuperAdmin) {
    return ["*"];
  }

  const permissionsSet = new Set<string>();

  const orgRoleId = refToId(user.orgRoleId);
  if (orgRoleId) {
    const orgRole = (await Role.findById(orgRoleId).lean().exec()) as IRole | null;
    orgRole?.permissions.forEach((perm) => permissionsSet.add(perm));
  }

  const storeRoleIds = (user.storeAccess ?? [])
    .map((access) => refToId(access.roleId))
    .filter((id): id is mongoose.Types.ObjectId => id !== null);

  if (storeRoleIds.length > 0) {
    const storeRoles = (await Role.find({ _id: { $in: storeRoleIds } })
      .lean()
      .exec()) as IRole[];
    storeRoles.forEach((role) =>
      role.permissions.forEach((perm) => permissionsSet.add(perm))
    );
  }

  return Array.from(permissionsSet);
}

/**
 * True when the user holds an (undeleted) organization-scoped role such as org_admin.
 * Requires `user.orgRoleId` to be populated (the authenticate middleware does this).
 */
export function hasOrganizationScopeRole(user: IUser): boolean {
  const orgRole = user.orgRoleId as unknown as IRole | null;
  return (
    !!orgRole &&
    typeof orgRole === "object" &&
    "scope" in orgRole &&
    orgRole.scope === "organization" &&
    orgRole.isDelete !== true
  );
}

/**
 * Resolves the highest scope level a user operates at, used as the ceiling in canGrantRole.
 * Accepts a populated or unpopulated orgRoleId.
 */
export async function resolveUserScope(user: IUser): Promise<PermissionScope> {
  if (user.isSuperAdmin) {
    return "platform";
  }

  const orgRoleId = refToId(user.orgRoleId);
  if (orgRoleId) {
    const orgRole = (await Role.findById(orgRoleId).lean().exec()) as IRole | null;
    if (orgRole && orgRole.scope === "organization" && orgRole.isDelete !== true) {
      return "organization";
    }
  }

  return "store";
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

/**
 * Validates whether an actor may modify an existing user at all.
 *
 * WHY THIS IS SEPARATE FROM canGrantRole:
 * canGrantRole answers "may you hand out this role" — it inspects only the role being assigned.
 * It says nothing about the person being acted on, so on its own it would happily let a store
 * manager with `user:manage_roles` deactivate the organization admin: deactivation assigns no
 * role, so there is nothing for canGrantRole to reject.
 *
 * The rule here is domination: the actor must already hold every privilege the target holds,
 * across the target's organization role AND every one of their store roles.
 *
 * @param actorPermissions Effective permissions of the user performing the action.
 * @param actorScope Highest scope level of the user performing the action.
 * @param targetUser The user being modified.
 */
export async function canManageUser(
  actorPermissions: string[],
  actorScope: PermissionScope,
  targetUser: IUser
): Promise<boolean> {
  // Super Admins may manage anyone.
  if (actorPermissions.includes("*")) {
    return true;
  }

  // A tenant user may never act on a platform Super Admin.
  if (targetUser.isSuperAdmin) {
    return false;
  }

  const roleIds: mongoose.Types.ObjectId[] = [];

  const targetOrgRoleId = refToId(targetUser.orgRoleId);
  if (targetOrgRoleId) {
    roleIds.push(targetOrgRoleId);
  }
  for (const access of targetUser.storeAccess ?? []) {
    const storeRoleId = refToId(access.roleId);
    if (storeRoleId) {
      roleIds.push(storeRoleId);
    }
  }

  // The target holds no roles at all, so there is nothing to dominate.
  if (roleIds.length === 0) {
    return true;
  }

  // Soft-deleted roles are filtered out by the Role pre-query hook. That is intentional:
  // a deleted role grants nothing, so it cannot be the thing that protects the target.
  const roles = (await Role.find({ _id: { $in: roleIds } })
    .lean()
    .exec()) as IRole[];

  return roles.every((role) => canGrantRole(actorPermissions, actorScope, role));
}
