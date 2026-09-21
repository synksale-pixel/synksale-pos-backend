/**
 * Purpose: User Invitation Service.
 * Handles the creation of pending user invitations (inviting staff members)
 * and the acceptance of invitations (setting passwords and activating accounts).
 * Enforces the privilege ceiling using canGrantRole.
 */

import mongoose from "mongoose";
import { User, IUser } from "../models/user.model";
import { Role } from "../models/role.model";
import { Store } from "../models/store.model";
import { getEffectivePermissions, canGrantRole } from "./permission.service";
import { generateAccessToken, generateRefreshToken } from "./auth.service";
import { generateOpaqueToken, hashToken, getExpiryDate } from "../utils/token.util";
import { env } from "../config/env.config";
import { ApiError } from "../utils/ApiError";

export interface InviteUserInput {
  organizationId: string;
  storeId?: string;
  email: string;
  firstName: string;
  lastName: string;
  roleId: string;
  invitedByUserId: string;
}

export interface AcceptInviteInput {
  token: string;
  password?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Creates a pending user invitation.
 * Enforces permission privilege checks to prevent store managers from granting admin roles.
 */
export async function inviteUser(input: InviteUserInput) {
  // 1. Resolve and validate the target role belongs to this organization
  const targetRole = await Role.findOne({
    _id: input.roleId,
    organizationId: input.organizationId,
    isDelete: { $ne: true },
  });

  if (!targetRole) {
    throw new ApiError(404, "Role not found or does not belong to your organization.");
  }

  // 2. Enforce the Privilege Ceiling
  const invitingUser = await User.findById(input.invitedByUserId);
  if (!invitingUser) {
    throw new ApiError(404, "Inviting user not found.");
  }

  // Resolve inviting user's effective permissions based on store context
  const invitingPermissions = await getEffectivePermissions(invitingUser, input.storeId);

  // Determine the highest scope level of the inviting user
  let grantingUserScope: "platform" | "organization" | "store" = "store";
  if (invitingUser.isSuperAdmin) {
    grantingUserScope = "platform";
  } else if (invitingUser.orgRoleId) {
    const orgRole = await Role.findById(invitingUser.orgRoleId);
    if (orgRole && orgRole.scope === "organization" && orgRole.isDelete !== true) {
      grantingUserScope = "organization";
    }
  }

  // Verify the inviter has sufficient permission to grant targetRole
  const isGrantAllowed = canGrantRole(invitingPermissions, grantingUserScope, targetRole);
  if (!isGrantAllowed) {
    throw new ApiError(
      403,
      "Access Denied: Privilege ceiling violation. You cannot invite a user to a role that exceeds your own scope or permissions."
    );
  }

  // 3. Check if user already exists in this organization
  const existingUser = await User.findOne({
    organizationId: input.organizationId,
    email: input.email.toLowerCase().trim(),
  });

  if (existingUser) {
    throw new ApiError(
      400,
      "A user with this email address is already registered in your organization."
    );
  }

  // 4. Generate the opaque invite token and set expiration
  const { token, hashedToken } = generateOpaqueToken();
  const expiresAt = getExpiryDate(env.INVITE_TOKEN_EXPIRY);

  // 5. Create the pending user document
  const userData: Partial<IUser> = {
    organizationId: new mongoose.Types.ObjectId(input.organizationId),
    email: input.email.toLowerCase().trim(),
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    isSuperAdmin: false,
    isActive: false, // Must remain false until invite is accepted
    inviteToken: hashedToken,
    inviteTokenExpiresAt: expiresAt,
    inviteStatus: "pending",
  };

  // Scoped assignments based on target role scope
  if (targetRole.scope === "organization") {
    userData.orgRoleId = targetRole._id;
    userData.storeAccess = [];
  } else if (targetRole.scope === "store") {
    if (!input.storeId) {
      throw new ApiError(400, "Store context is required for assigning a store-scoped role.");
    }
    // The store must exist in this organization and be active before anyone is assigned to it.
    const store = await Store.findOne({
      _id: input.storeId,
      organizationId: input.organizationId,
    });
    if (!store) {
      throw new ApiError(404, "Store not found or does not belong to your organization.");
    }
    if (!store.isActive) {
      throw new ApiError(400, "Cannot assign a user to a deactivated store.");
    }

    userData.orgRoleId = null;
    userData.storeAccess = [
      {
        storeId: store._id,
        roleId: targetRole._id,
      },
    ];
  }

  const user = await User.create(userData);

  // 6. Construct the invitation link
  const inviteLink = `${env.FRONTEND_URL}/accept-invite?token=${token}`;

  const { passwordHash: _passwordHash, refreshTokens: _refreshTokens, ...userResponse } = user.toObject();

  return {
    user: userResponse,
    inviteToken: token, // Plaintext returned ONLY in API response
    inviteLink,
  };
}

/**
 * Accepts an invitation, sets the password, activates the account, and returns login tokens.
 */
export async function acceptInvite(input: AcceptInviteInput) {
  const hashed = hashToken(input.token);

  // 1. Look up pending user by hashed token
  const user = await User.findOne({
    inviteToken: hashed,
    inviteStatus: "pending",
  }).select("+inviteToken +inviteTokenExpiresAt");

  if (!user) {
    throw new ApiError(400, "Invalid or expired invitation token.");
  }

  // 2. Check if the token has expired
  if (user.inviteTokenExpiresAt && user.inviteTokenExpiresAt < new Date()) {
    throw new ApiError(400, "Invitation link has expired.");
  }

  // 3. Set password, activate user, and clear token fields
  user.passwordHash = input.password;
  user.isActive = true;
  user.inviteStatus = "accepted";
  user.inviteToken = undefined;
  user.inviteTokenExpiresAt = undefined;

  await user.save();

  // 4. Generate session tokens immediately (seamless UX auto-login)
  const accessToken = generateAccessToken({
    userId: user._id.toString(),
    organizationId: user.organizationId!.toString(),
    isSuperAdmin: false,
  });

  const { token: refreshToken, hashedToken } = generateRefreshToken();
  const expiresAt = getExpiryDate(env.JWT_REFRESH_EXPIRY);

  user.refreshTokens.push({
    token: hashedToken,
    createdAt: new Date(),
    expiresAt,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  });

  user.lastLoginAt = new Date();
  await user.save();

  const { passwordHash: _passwordHash, refreshTokens: _refreshTokens, ...userResponse } = user.toObject();

  return {
    accessToken,
    refreshToken,
    user: userResponse,
  };
}
