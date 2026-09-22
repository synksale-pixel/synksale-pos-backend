/**
 * Purpose: User (staff) Management Service.
 * Reading the organization roster and changing an existing user's access: organization role,
 * per-store assignments, activation state, and pending-invite lifecycle.
 *
 * Creating users lives in userInvite.service.ts; this file only ever modifies users that
 * already exist.
 *
 * PRIVILEGE MODEL:
 * Every mutation here passes two independent checks.
 *  1. canManageUser  — may the actor touch this person at all (do they dominate the target's
 *     current privileges)? Without it, a store manager holding `user:manage_roles` could
 *     deactivate the organization admin, because deactivation assigns no role for
 *     canGrantRole to reject.
 *  2. canGrantRole   — may the actor hand out the specific role being assigned?
 */

import mongoose from "mongoose";
import { User, IUser, UserDocument } from "../models/user.model";
import { Role, IRole, RoleDocument } from "../models/role.model";
import { Store } from "../models/store.model";
import {
  getEffectivePermissions,
  getPermissionsAcrossStores,
  canGrantRole,
  canManageUser,
  hasOrganizationScopeRole,
  resolveUserScope,
  PermissionScope,
} from "./permission.service";
import { recordAudit } from "./audit.service";
import { generateOpaqueToken, getExpiryDate } from "../utils/token.util";
import { resolvePaging, buildPaginationMeta, PaginationInput } from "../utils/pagination";
import { env } from "../config/env.config";
import { ApiError } from "../utils/ApiError";
import { logger } from "../config/logger.config";

/** A lean() Role still carries its _id; the IRole interface alone does not describe it. */
type LeanRole = IRole & { _id: mongoose.Types.ObjectId };

export interface ListUsersInput extends PaginationInput {
  q?: string;
  storeId?: string;
  roleId?: string;
  status?: "active" | "inactive" | "pending";
}

/** Rotated-out refresh token hashes are noise on the roster endpoints. */
const USER_LIST_PROJECTION = "-usedRefreshTokens";

// ============================================================
// Internal guards
// ============================================================

/**
 * True when the actor is allowed to see this user at all.
 * Organization-scoped roles see the whole roster; store-scoped staff see only users who share
 * one of their stores (plus themselves).
 */
function canSeeUser(actor: IUser, target: { _id: mongoose.Types.ObjectId; storeAccess?: { storeId: mongoose.Types.ObjectId }[] }): boolean {
  if (actor.isSuperAdmin || hasOrganizationScopeRole(actor)) {
    return true;
  }

  if (target._id.toString() === (actor as UserDocument)._id?.toString()) {
    return true;
  }

  const ownStoreIds = new Set(
    (actor.storeAccess ?? []).map((access) => access.storeId.toString())
  );
  return (target.storeAccess ?? []).some((access) =>
    ownStoreIds.has(access.storeId.toString())
  );
}

/**
 * Loads the target user and verifies the actor is allowed to act on them at all.
 *
 * `storeIdForScope` names the store the action concerns, and the actor is then evaluated with
 * their role at THAT store. For store-agnostic actions (resending an invite, changing an
 * organization role) there is no such store, and the actor is evaluated across every store they
 * work at — otherwise a store manager, whose permissions all come from a store role, would
 * resolve to an empty permission set and fail the ceiling check against anyone at all.
 */
async function loadManageableTarget(
  organizationId: string,
  actor: IUser,
  targetUserId: string,
  storeIdForScope?: string,
  session?: mongoose.ClientSession
): Promise<{
  target: UserDocument;
  actorPermissions: string[];
  actorScope: PermissionScope;
}> {
  const target = (await User.findOne({
    _id: targetUserId,
    organizationId,
  }).session(session ?? null)) as UserDocument | null;

  // Reported as 404 rather than 403 so the endpoint cannot be used to probe who exists.
  if (!target || !canSeeUser(actor, target)) {
    throw new ApiError(404, "User not found.");
  }

  const actorPermissions = storeIdForScope
    ? await getEffectivePermissions(actor, storeIdForScope)
    : await getPermissionsAcrossStores(actor);
  const actorScope = await resolveUserScope(actor);

  const allowed = await canManageUser(actorPermissions, actorScope, target);
  if (!allowed) {
    throw new ApiError(
      403,
      "Access Denied: Privilege ceiling violation. You cannot manage a user whose access exceeds your own."
    );
  }

  return { target, actorPermissions, actorScope };
}

/** Blocks an actor from acting on their own account where doing so could lock them out. */
function assertNotSelf(actor: IUser, target: UserDocument, action: string): void {
  const actorId = (actor as UserDocument)._id?.toString();
  if (actorId && actorId === target._id.toString()) {
    throw new ApiError(
      400,
      `You cannot ${action} your own account. Ask another administrator to do it.`
    );
  }
}

/**
 * Refuses to leave an organization with no active administrator.
 *
 * MUST run inside the same transaction as the mutation it guards: two concurrent demotions
 * would otherwise each read "one other admin remains", both pass, and orphan the organization.
 */
async function assertNotLastOrganizationAdmin(
  organizationId: string,
  target: UserDocument,
  session: mongoose.ClientSession
): Promise<void> {
  const targetOrgRoleId = target.orgRoleId;
  if (!targetOrgRoleId) {
    return; // Holds no organization role, so cannot be the last administrator.
  }

  // Which roles in this organization can administer other users?
  const adminRoles = (await Role.find({
    organizationId,
    scope: "organization",
    permissions: "user:manage_roles",
  })
    .session(session)
    .lean()
    .exec()) as LeanRole[];

  const adminRoleIds = adminRoles.map((role) => role._id.toString());
  if (!adminRoleIds.includes(targetOrgRoleId.toString())) {
    return; // The target is not an administrator, so removing them changes nothing.
  }

  const remaining = await User.countDocuments({
    organizationId,
    orgRoleId: { $in: adminRoles.map((role) => role._id) },
    isActive: true,
    _id: { $ne: target._id },
  }).session(session);

  if (remaining === 0) {
    throw new ApiError(
      409,
      "This is the last active administrator of the organization. Assign the role to another user first."
    );
  }
}

/** Resolves a role that must exist in this organization and carry the expected scope. */
async function resolveAssignableRole(
  organizationId: string,
  roleId: string,
  expectedScope: "organization" | "store",
  actorPermissions: string[],
  actorScope: PermissionScope,
  session?: mongoose.ClientSession
): Promise<RoleDocument> {
  const role = (await Role.findOne({
    _id: roleId,
    organizationId,
  }).session(session ?? null)) as RoleDocument | null;

  if (!role) {
    throw new ApiError(404, "Role not found or does not belong to your organization.");
  }

  if (role.scope !== expectedScope) {
    throw new ApiError(
      400,
      `Role '${role.name}' is ${role.scope}-scoped and cannot be assigned as a ${expectedScope}-scoped role.`
    );
  }

  if (!canGrantRole(actorPermissions, actorScope, role)) {
    throw new ApiError(
      403,
      "Access Denied: Privilege ceiling violation. You cannot assign a role that exceeds your own scope or permissions."
    );
  }

  return role;
}

/** Re-reads a user through the normal (transform-applied) path for the API response. */
async function freshUser(organizationId: string, userId: mongoose.Types.ObjectId) {
  return User.findOne({ _id: userId, organizationId })
    .select(USER_LIST_PROJECTION)
    .populate("orgRoleId");
}

// ============================================================
// Reads
// ============================================================

/**
 * Lists staff in the caller's organization.
 * Visibility mirrors listStores: organization-scoped roles see the whole roster, store-scoped
 * staff see only users assigned to one of THEIR stores. A cashier must not be able to read the
 * organization's full staff directory.
 */
export async function listUsers(
  organizationId: string,
  actor: IUser,
  input: ListUsersInput
) {
  const { page, limit, skip } = resolvePaging(input);

  const filter: Record<string, unknown> = { organizationId };
  const storeIdConstraints: unknown[] = [];

  if (!hasOrganizationScopeRole(actor) && !actor.isSuperAdmin) {
    const ownStoreIds = (actor.storeAccess ?? []).map((access) => access.storeId);
    if (ownStoreIds.length === 0) {
      return { users: [], pagination: buildPaginationMeta(page, limit, 0) };
    }
    storeIdConstraints.push({ $in: ownStoreIds });
  }

  if (input.storeId) {
    storeIdConstraints.push(input.storeId);
  }

  // Both the visibility restriction and an explicit ?storeId= filter target the same field,
  // so they are combined rather than one silently overwriting the other.
  const andClauses: Record<string, unknown>[] = storeIdConstraints.map(
    (constraint) => ({ "storeAccess.storeId": constraint })
  );

  if (input.roleId) {
    andClauses.push({
      $or: [{ orgRoleId: input.roleId }, { "storeAccess.roleId": input.roleId }],
    });
  }

  if (input.status === "active") {
    filter.isActive = true;
    filter.inviteStatus = "accepted";
  } else if (input.status === "inactive") {
    filter.isActive = false;
    filter.inviteStatus = "accepted";
  } else if (input.status === "pending") {
    filter.inviteStatus = "pending";
  }

  if (input.q) {
    // Escaped so a search term cannot inject regex syntax (or a catastrophic backtrack).
    const escaped = input.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const term = new RegExp(escaped, "i");
    andClauses.push({
      $or: [{ firstName: term }, { lastName: term }, { email: term }],
    });
  }

  if (andClauses.length > 0) {
    filter.$and = andClauses;
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select(USER_LIST_PROJECTION)
      .populate("orgRoleId")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  return { users, pagination: buildPaginationMeta(page, limit, total) };
}

/** Fetches one user in the caller's organization, subject to the same visibility rules. */
export async function getUser(
  organizationId: string,
  actor: IUser,
  userId: string
) {
  const user = await User.findOne({ _id: userId, organizationId })
    .select(USER_LIST_PROJECTION)
    .populate("orgRoleId");

  if (!user) {
    throw new ApiError(404, "User not found.");
  }

  // Reported as 404 rather than 403 so the endpoint cannot be used to probe who exists.
  if (!canSeeUser(actor, user)) {
    throw new ApiError(404, "User not found.");
  }

  return user;
}

// ============================================================
// Organization role
// ============================================================

/**
 * Sets (or clears, with roleId: null) a user's organization-wide role.
 * Runs in a transaction so the last-administrator count cannot go stale mid-update.
 */
export async function setUserOrgRole(
  organizationId: string,
  actor: IUser,
  targetUserId: string,
  roleId: string | null,
  actorUserId: string
) {
  const session = await mongoose.startSession();

  try {
    let updatedId: mongoose.Types.ObjectId | null = null;
    let previousRoleId: string | null = null;

    await session.withTransaction(async () => {
      const { target, actorPermissions, actorScope } = await loadManageableTarget(
        organizationId,
        actor,
        targetUserId,
        undefined,
        session
      );

      assertNotSelf(actor, target, "change the organization role of");

      previousRoleId = target.orgRoleId ? target.orgRoleId.toString() : null;

      if (roleId === null) {
        await assertNotLastOrganizationAdmin(organizationId, target, session);
        target.orgRoleId = null;
      } else {
        const role = await resolveAssignableRole(
          organizationId,
          roleId,
          "organization",
          actorPermissions,
          actorScope,
          session
        );

        // Swapping an administrator role for one that cannot administer users is still a
        // demotion, so the guard applies whenever the replacement cannot manage roles.
        if (
          previousRoleId !== role._id.toString() &&
          !role.permissions.includes("user:manage_roles")
        ) {
          await assertNotLastOrganizationAdmin(organizationId, target, session);
        }

        target.orgRoleId = role._id;
      }

      await target.save({ session });
      updatedId = target._id;
    });

    await recordAudit({
      organizationId,
      actorUserId,
      action: "user.org_role_changed",
      targetType: "user",
      targetId: updatedId!,
      before: { orgRoleId: previousRoleId },
      after: { orgRoleId: roleId },
    });

    logger.info(
      `User org role changed: ${targetUserId} -> ${roleId ?? "none"} org=${organizationId} by user=${actorUserId}`
    );

    return freshUser(organizationId, updatedId!);
  } finally {
    await session.endSession();
  }
}

// ============================================================
// Store access
// ============================================================

/** Grants a user a store-scoped role at a store they are not yet assigned to. */
export async function grantStoreAccess(
  organizationId: string,
  actor: IUser,
  targetUserId: string,
  storeId: string,
  roleId: string,
  actorUserId: string
) {
  const { target, actorPermissions, actorScope } = await loadManageableTarget(
    organizationId,
    actor,
    targetUserId,
    storeId
  );

  const store = await Store.findOne({ _id: storeId, organizationId });
  if (!store) {
    throw new ApiError(404, "Store not found or does not belong to your organization.");
  }
  // Mirrors the invite flow: nobody is assigned to a store that is switched off.
  if (!store.isActive) {
    throw new ApiError(400, "Cannot assign a user to a deactivated store.");
  }

  const alreadyAssigned = (target.storeAccess ?? []).some(
    (access) => access.storeId.toString() === storeId
  );
  if (alreadyAssigned) {
    throw new ApiError(
      409,
      "This user is already assigned to that store. Update their existing assignment instead."
    );
  }

  const role = await resolveAssignableRole(
    organizationId,
    roleId,
    "store",
    actorPermissions,
    actorScope
  );

  target.storeAccess.push({ storeId: store._id, roleId: role._id });
  await target.save();

  await recordAudit({
    organizationId,
    actorUserId,
    action: "user.store_access_granted",
    targetType: "user",
    targetId: target._id,
    after: { storeId, roleId: role._id.toString() },
  });

  logger.info(
    `Store access granted: user=${targetUserId} store=${storeId} role=${role._id} org=${organizationId} by user=${actorUserId}`
  );

  return freshUser(organizationId, target._id);
}

/** Changes which store-scoped role a user holds at a store they are already assigned to. */
export async function updateStoreAccess(
  organizationId: string,
  actor: IUser,
  targetUserId: string,
  storeId: string,
  roleId: string,
  actorUserId: string
) {
  const { target, actorPermissions, actorScope } = await loadManageableTarget(
    organizationId,
    actor,
    targetUserId,
    storeId
  );

  const assignment = (target.storeAccess ?? []).find(
    (access) => access.storeId.toString() === storeId
  );
  if (!assignment) {
    throw new ApiError(404, "This user is not assigned to that store.");
  }

  const role = await resolveAssignableRole(
    organizationId,
    roleId,
    "store",
    actorPermissions,
    actorScope
  );

  const previousRoleId = assignment.roleId.toString();
  assignment.roleId = role._id;
  await target.save();

  await recordAudit({
    organizationId,
    actorUserId,
    action: "user.store_access_changed",
    targetType: "user",
    targetId: target._id,
    before: { storeId, roleId: previousRoleId },
    after: { storeId, roleId: role._id.toString() },
  });

  logger.info(
    `Store access changed: user=${targetUserId} store=${storeId} role=${previousRoleId} -> ${role._id} org=${organizationId} by user=${actorUserId}`
  );

  return freshUser(organizationId, target._id);
}

/**
 * Removes a user's assignment to a store.
 * Always permitted for a deactivated store — staff must be movable off a store that is closed.
 */
export async function revokeStoreAccess(
  organizationId: string,
  actor: IUser,
  targetUserId: string,
  storeId: string,
  actorUserId: string
) {
  const { target } = await loadManageableTarget(
    organizationId,
    actor,
    targetUserId,
    storeId
  );

  const assignment = (target.storeAccess ?? []).find(
    (access) => access.storeId.toString() === storeId
  );
  if (!assignment) {
    throw new ApiError(404, "This user is not assigned to that store.");
  }

  const previousRoleId = assignment.roleId.toString();
  target.storeAccess = target.storeAccess.filter(
    (access) => access.storeId.toString() !== storeId
  );
  await target.save();

  await recordAudit({
    organizationId,
    actorUserId,
    action: "user.store_access_revoked",
    targetType: "user",
    targetId: target._id,
    before: { storeId, roleId: previousRoleId },
  });

  logger.info(
    `Store access revoked: user=${targetUserId} store=${storeId} org=${organizationId} by user=${actorUserId}`
  );

  return freshUser(organizationId, target._id);
}

// ============================================================
// Activation
// ============================================================

/**
 * Activates or deactivates a staff account. Idempotent.
 *
 * Deactivation is the only removal path for an accepted user: sales and inventory records will
 * reference them, so the account must remain resolvable. Refresh tokens are cleared so existing
 * sessions cannot be renewed; the isActive check in `authenticate` closes the short remaining
 * window until their current access token expires.
 */
export async function setUserActive(
  organizationId: string,
  actor: IUser,
  targetUserId: string,
  isActive: boolean,
  actorUserId: string
) {
  const session = await mongoose.startSession();

  try {
    let updatedId: mongoose.Types.ObjectId | null = null;
    let wasActive = false;

    await session.withTransaction(async () => {
      const { target } = await loadManageableTarget(
        organizationId,
        actor,
        targetUserId,
        undefined,
        session
      );

      if (!isActive) {
        assertNotSelf(actor, target, "deactivate");
        await assertNotLastOrganizationAdmin(organizationId, target, session);
      }

      // A pending invitee has no password yet; activating them here would produce an account
      // nobody can log into. They become active by accepting their invitation.
      if (isActive && target.inviteStatus === "pending") {
        throw new ApiError(
          400,
          "This user has not accepted their invitation yet and cannot be activated manually."
        );
      }

      wasActive = target.isActive;
      target.isActive = isActive;

      if (!isActive) {
        // Kill every refresh session so the account cannot be renewed back to life.
        target.refreshTokens = [];
      }

      await target.save({ session });
      updatedId = target._id;
    });

    await recordAudit({
      organizationId,
      actorUserId,
      action: isActive ? "user.activated" : "user.deactivated",
      targetType: "user",
      targetId: updatedId!,
      before: { isActive: wasActive },
      after: { isActive },
    });

    logger.info(
      `User ${isActive ? "activated" : "deactivated"}: ${targetUserId} org=${organizationId} by user=${actorUserId}`
    );

    return freshUser(organizationId, updatedId!);
  } finally {
    await session.endSession();
  }
}

// ============================================================
// Pending invite lifecycle
// ============================================================

/**
 * Issues a fresh invite token for a user whose invitation is still pending, invalidating the
 * previous one (only the hash is stored, so the old link stops resolving immediately).
 */
export async function resendInvite(
  organizationId: string,
  actor: IUser,
  targetUserId: string,
  actorUserId: string
) {
  const { target } = await loadManageableTarget(organizationId, actor, targetUserId);

  if (target.inviteStatus !== "pending") {
    throw new ApiError(400, "This user has already accepted their invitation.");
  }

  const { token, hashedToken } = generateOpaqueToken();
  target.inviteToken = hashedToken;
  target.inviteTokenExpiresAt = getExpiryDate(env.INVITE_TOKEN_EXPIRY);
  await target.save();

  await recordAudit({
    organizationId,
    actorUserId,
    action: "user.invite_resent",
    targetType: "user",
    targetId: target._id,
  });

  logger.info(
    `Invite resent: user=${targetUserId} org=${organizationId} by user=${actorUserId}`
  );

  const {
    passwordHash: _passwordHash,
    refreshTokens: _refreshTokens,
    ...userResponse
  } = target.toObject();

  return { user: userResponse, ...buildInviteDelivery(token) };
}

/**
 * Cancels a pending invitation by deleting the placeholder user outright.
 *
 * HARD DELETE IS DELIBERATE: a pending invitee has never logged in and nothing references them,
 * so there is no history to preserve — and removing the row frees the email address to be
 * invited again (the unique index on { organizationId, email } does not exclude soft-deleted
 * rows, so a soft delete would keep the address occupied and the re-invite would 409).
 * Accepted users are never deleted, only deactivated.
 */
export async function revokeInvite(
  organizationId: string,
  actor: IUser,
  targetUserId: string,
  actorUserId: string
) {
  const { target } = await loadManageableTarget(organizationId, actor, targetUserId);

  if (target.inviteStatus !== "pending") {
    throw new ApiError(
      400,
      "This user has already accepted their invitation and can only be deactivated."
    );
  }

  const snapshot = {
    email: target.email,
    orgRoleId: target.orgRoleId ? target.orgRoleId.toString() : null,
    storeAccess: (target.storeAccess ?? []).map((access) => ({
      storeId: access.storeId.toString(),
      roleId: access.roleId.toString(),
    })),
  };

  await User.deleteOne({ _id: target._id, organizationId });

  await recordAudit({
    organizationId,
    actorUserId,
    action: "user.invite_revoked",
    targetType: "user",
    targetId: target._id,
    before: snapshot,
  });

  logger.info(
    `Invite revoked: user=${targetUserId} (${target.email}) org=${organizationId} by user=${actorUserId}`
  );
}

// ============================================================
// Invite delivery
// ============================================================

export interface InviteDelivery {
  /** Present only outside production. */
  inviteToken?: string;
  /** Present only outside production. */
  inviteLink?: string;
  /** How the invitee is expected to receive the link. */
  delivery: "response" | "email_pending";
}

/**
 * Decides whether the plaintext invite token may appear in the API response.
 *
 * In production it must not: it would travel through proxies, response logs and browser
 * devtools on every invite and resend. Until an email service is wired up, a production invite
 * is therefore not deliverable — that is the point of this flag, and the warning below is the
 * signal that the email adapter is the remaining blocker before real customers are onboarded.
 */
export function buildInviteDelivery(token: string): InviteDelivery {
  if (env.NODE_ENV === "production") {
    logger.warn(
      "[INVITE] An invitation was issued in production but no email service is configured, so the invite link was not delivered to the invitee."
    );
    return { delivery: "email_pending" };
  }

  return {
    inviteToken: token,
    inviteLink: `${env.FRONTEND_URL}/accept-invite?token=${token}`,
    delivery: "response",
  };
}
