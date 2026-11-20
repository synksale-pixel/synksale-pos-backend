/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Tenant Authentication Controller.
 * Handles organization signup, tenant user login, token refresh (with rotation),
 * logout, logout-all, and fetching user profiles with resolved permissions.
 * Mirrors the security boundary, logging, and error conventions from platform authentication.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { ApiResponse } from "../utils/ApiResponse";
import { logger } from "../config/logger.config";
import { signupOrganization } from "../services/organizationSignup.service";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../services/auth.service";
import { hashToken, getExpiryDate } from "../utils/token.util";
import { Organization } from "../models/organization.model";
import { IUser, User, hashPassword } from "../models/user.model";
import { Role } from "../models/role.model";
import { getEffectivePermissions } from "../services/permission.service";
import { env } from "../config/env.config";

/**
 * Tenant Signup:
 * Atomically registers a new organization, seeds standard roles, and creates the admin user.
 */
export const signup = asyncHandler(async (req: Request, res: Response) => {
  const ipAddress =
    req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  const result = await signupOrganization(req.body);

  logger.info(
    `[TENANT_AUTH] Organization application submitted (pending approval): ${result.organization.name} (ID: ${result.organization._id}) and admin email: ${req.body.adminEmail} from IP: ${ipAddress}`
  );

  res.status(201).json(
    new ApiResponse(
      201,
      {
        organization: {
          id: result.organization._id,
          name: result.organization.name,
          slug: result.organization.slug,
          approvalStatus: result.organization.approvalStatus,
        },
      },
      "Application received. You will be notified once your organization is approved."
    )
  );
});

/**
 * Tenant Login:
 * Validates organization and user credentials. Employs anti-enumeration checks to mask
 * invalid slugs or emails. Checks activation flags only after password verification.
 */
export const login = asyncHandler(async (req: Request, res: Response) => {
  const { orgSlug, email, password } = req.body;
  const ipAddress =
    req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  // 1. Resolve organization by slug
  const organization = await Organization.findOne({
    slug: orgSlug.toLowerCase(),
  });

  // Anti-enumeration check: if organization is not found, throw generic 401
  if (!organization) {
    logger.warn(
      `[TENANT_AUTH] Failed login attempt from IP: ${ipAddress} - Reason: Organization slug not found (${orgSlug})`
    );
    throw new ApiError(401, "Invalid credentials");
  }

  // 2. Resolve user in that organization (explicitly select passwordHash)
  const user = await User.findOne({
    organizationId: organization._id,
    email: email.toLowerCase(),
    isSuperAdmin: false,
  }).select("+passwordHash");

  // Anti-enumeration check: if user is not found, throw generic 401
  if (!user) {
    logger.warn(
      `[TENANT_AUTH] Failed login attempt for email: ${email} in org: ${orgSlug} from IP: ${ipAddress} - Reason: User not found`
    );
    throw new ApiError(401, "Invalid credentials");
  }

  // 3. Compare candidate password
  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    logger.warn(
      `[TENANT_AUTH] Failed login attempt for email: ${email} in org: ${orgSlug} from IP: ${ipAddress} - Reason: Incorrect password`
    );
    throw new ApiError(401, "Invalid credentials");
  }

  // 4. Safe post-verification check: verify approval and activation states
  // Since password verification succeeded, enumeration risk is resolved.
  if (organization.approvalStatus === "pending") {
    logger.warn(
      `[TENANT_AUTH] Failed login attempt for email: ${email} in org: ${orgSlug} from IP: ${ipAddress} - Reason: Organization pending approval`
    );
    throw new ApiError(
      403,
      "Your organization application is still pending review."
    );
  }

  if (organization.approvalStatus === "rejected") {
    logger.warn(
      `[TENANT_AUTH] Failed login attempt for email: ${email} in org: ${orgSlug} from IP: ${ipAddress} - Reason: Organization application rejected`
    );
    throw new ApiError(403, "Your organization application was not approved.");
  }

  if (!organization.isActive) {
    logger.warn(
      `[TENANT_AUTH] Failed login attempt for email: ${email} in org: ${orgSlug} from IP: ${ipAddress} - Reason: Organization suspended`
    );
    throw new ApiError(
      403,
      "Access Denied: Your organization account has been suspended."
    );
  }

  if (!user.isActive) {
    logger.warn(
      `[TENANT_AUTH] Failed login attempt for email: ${email} in org: ${orgSlug} from IP: ${ipAddress} - Reason: User deactivated`
    );
    throw new ApiError(
      403,
      "Access Denied: Your user account has been deactivated."
    );
  }

  // 5. Generate session tokens
  const accessToken = generateAccessToken({
    userId: user._id.toString(),
    organizationId: organization._id.toString(),
    isSuperAdmin: false,
  });

  const { token: refreshToken, hashedToken } = generateRefreshToken();
  const expiresAt = getExpiryDate(env.JWT_REFRESH_EXPIRY);

  // Store hashed refresh token in database (never store plaintext)
  user.refreshTokens.push({
    token: hashedToken,
    createdAt: new Date(),
    expiresAt,
    userAgent: req.headers["user-agent"],
    ipAddress: String(ipAddress),
  });

  user.lastLoginAt = new Date();
  await user.save();

  logger.info(
    `[TENANT_AUTH] Successful login for user: ${user._id} in org: ${organization.slug} from IP: ${ipAddress}`
  );

  const userResponse = user.toObject() as any;
  delete userResponse.passwordHash;
  delete userResponse.refreshTokens;

  res.status(200).json(
    new ApiResponse(
      200,
      {
        accessToken,
        refreshToken,
        user: userResponse,
        organization: {
          id: organization._id,
          name: organization.name,
          slug: organization.slug,
        },
      },
      "Logged in successfully"
    )
  );
});

/**
 * Tenant Refresh Token Rotation:
 * Invalidates the used refresh token and issues a new access/refresh pair.
 */
export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  const ipAddress =
    req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const hashedToken = hashToken(refreshToken);

  // Find non-super-admin user holding this hashed refresh token
  const user = await User.findOne({
    isSuperAdmin: false,
    "refreshTokens.token": hashedToken,
  });

  if (!user) {
    // Reuse detection: a rotated-out token being replayed suggests it was stolen,
    // so revoke every session for that user and force a fresh login.
    const compromisedUser = await User.findOneAndUpdate(
      {
        isSuperAdmin: false,
        "usedRefreshTokens.token": hashedToken,
      },
      { $set: { refreshTokens: [], usedRefreshTokens: [] } }
    );

    if (compromisedUser) {
      logger.warn(
        `[TENANT_AUTH] Refresh token reuse detected for user: ${compromisedUser._id} from IP: ${ipAddress} - All sessions revoked`
      );
    } else {
      logger.warn(
        `[TENANT_AUTH] Failed refresh attempt from IP: ${ipAddress} - Reason: Invalid refresh token`
      );
    }
    throw new ApiError(
      401,
      "Authentication failed: Invalid or expired refresh token."
    );
  }

  if (!user.isActive) {
    logger.warn(
      `[TENANT_AUTH] Failed refresh attempt for user: ${user._id} from IP: ${ipAddress} - Reason: Account inactive`
    );
    throw new ApiError(
      401,
      "Authentication failed: Account has been deactivated."
    );
  }

  const tokenIndex = user.refreshTokens.findIndex(
    (t) => t.token === hashedToken
  );
  const storedToken = user.refreshTokens[tokenIndex];

  // Validate expiration
  if (storedToken.expiresAt < new Date()) {
    // Remove expired token
    user.refreshTokens.splice(tokenIndex, 1);
    await user.save();

    logger.warn(
      `[TENANT_AUTH] Failed refresh attempt for user: ${user._id} from IP: ${ipAddress} - Reason: Expired refresh token`
    );
    throw new ApiError(
      401,
      "Authentication failed: Refresh token has expired."
    );
  }

  // Token Rotation: issue new access/refresh tokens and replace old hashed refresh token
  const newAccessToken = generateAccessToken({
    userId: user._id.toString(),
    organizationId: user.organizationId!.toString(),
    isSuperAdmin: false,
  });

  const newRefreshToken = generateRefreshToken();
  const expiresAt = getExpiryDate(env.JWT_REFRESH_EXPIRY);

  // Remember the consumed token (until it would have expired) for reuse detection,
  // pruning entries that can no longer be replayed anyway.
  const now = new Date();
  user.usedRefreshTokens = (user.usedRefreshTokens ?? []).filter(
    (t) => t.expiresAt > now
  );
  user.usedRefreshTokens.push({
    token: hashedToken,
    expiresAt: storedToken.expiresAt,
  });

  user.refreshTokens[tokenIndex] = {
    token: newRefreshToken.hashedToken,
    createdAt: new Date(),
    expiresAt,
    userAgent: req.headers["user-agent"],
    ipAddress: String(ipAddress),
  };

  await user.save();

  logger.info(
    `[TENANT_AUTH] Successful token rotation for user: ${user._id} from IP: ${ipAddress}`
  );

  const userResponse = user.toObject() as any;
  delete userResponse.passwordHash;
  delete userResponse.refreshTokens;

  res.status(200).json(
    new ApiResponse(
      200,
      {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken.token,
        user: userResponse,
      },
      "Token refreshed successfully"
    )
  );
});

/**
 * Tenant Logout:
 * Revokes the specific refresh token associated with the request (current session).
 */
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  const ipAddress =
    req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const hashedToken = hashToken(refreshToken);

  const user = await User.findOne({
    isSuperAdmin: false,
    "refreshTokens.token": hashedToken,
  });

  if (user) {
    user.refreshTokens = user.refreshTokens.filter(
      (t) => t.token !== hashedToken
    );
    await user.save();

    logger.info(
      `[TENANT_AUTH] Successful logout (device token revoked) for user: ${user._id} from IP: ${ipAddress}`
    );
  } else {
    logger.debug(
      `[TENANT_AUTH] Logout request with unrecognized token from IP: ${ipAddress}`
    );
  }

  res.status(200).json(new ApiResponse(200, null, "Logged out successfully"));
});

/**
 * Tenant Logout All Devices:
 * Clears all active refresh tokens for the authenticated tenant user.
 */
export const logoutAllDevices = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user!;
    const ipAddress =
      req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

    user.refreshTokens = [];
    await user.save();

    logger.info(
      `[TENANT_AUTH] Successful logout from all devices for user: ${user._id} from IP: ${ipAddress}`
    );

    res
      .status(200)
      .json(
        new ApiResponse(200, null, "Logged out from all devices successfully")
      );
  }
);

/**
 * Me/Profile Endpoint:
 * Resolves current user's profile and returns their effective permissions.
 * Accepts optional storeId parameter from query string to include store-level authorization context.
 */
export const me = asyncHandler(async (req: Request, res: Response) => {
  const storeId = req.query.storeId as string | undefined;

  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        await buildMeResponse(req.user!, storeId),
        "Profile and permissions resolved successfully"
      )
    );
});

/**
 * The role the user holds at `storeId`, or null when no storeId is given, the user is not
 * assigned to that store, or the role no longer exists. For display only: clients gate features
 * on `permissions`, never on the role's name or slug (system roles can be renamed).
 */
async function resolveStoreRole(user: IUser, storeId?: string) {
  if (!storeId) return null;
  const access = (user.storeAccess ?? []).find(
    (a) => a.storeId.toString() === storeId
  );
  if (!access) return null;
  const role = await Role.findById(access.roleId)
    .select("name slug scope")
    .lean()
    .exec();
  return role
    ? { _id: role._id, name: role.name, slug: role.slug, scope: role.scope }
    : null;
}

/** The /auth/me payload: user (org + org role populated) plus resolved permissions and store role. */
async function buildMeResponse(user: IUser, storeId?: string) {
  const [permissions, storeRole] = await Promise.all([
    getEffectivePermissions(user, storeId),
    resolveStoreRole(user, storeId),
  ]);

  const userResponse = (user as any).toObject();
  delete userResponse.passwordHash;
  delete userResponse.refreshTokens;

  return { ...userResponse, permissions, storeRole };
}

/**
 * Update My Profile:
 * The signed-in user edits their own first/last name. The validator is strict, so only these
 * two fields can ever reach the update (no role, store access or email changes through here).
 * Accepts the same optional ?storeId= as GET /me and returns the same shape.
 */
export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const storeId = req.query.storeId as string | undefined;
  const { firstName, lastName } = req.body as {
    firstName?: string;
    lastName?: string;
  };

  const $set: Record<string, string> = {};
  if (firstName !== undefined) $set.firstName = firstName;
  if (lastName !== undefined) $set.lastName = lastName;

  const updated = await User.findOneAndUpdate(
    { _id: req.user!._id },
    { $set },
    { new: true, runValidators: true }
  ).populate(["orgRoleId", "organizationId"]);

  if (!updated) {
    throw new ApiError(
      401,
      "Authentication failed: The user account associated with this token does not exist."
    );
  }

  logger.info(`[TENANT_AUTH] Profile updated for user: ${updated._id}`);

  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        await buildMeResponse(updated, storeId),
        "Profile updated successfully"
      )
    );
});

/**
 * Change Password:
 * Verifies the current password, then in ONE atomic update stores the new hash and replaces every
 * refresh token with a single fresh one for this device. Every other device is signed out (its
 * access token lives at most JWT_ACCESS_EXPIRY). The write is conditioned on the old hash, so two
 * concurrent changes cannot both succeed, and a concurrent /refresh cannot resurrect a session.
 *
 * A wrong current password is a 400 on `currentPassword`, not a 401: a 401 would trip the
 * client's refresh/logout interceptor for what is really a form error.
 */
export const changePassword = asyncHandler(
  async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string;
      newPassword: string;
    };
    const ipAddress =
      req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

    const user = await User.findById(req.user!._id).select("+passwordHash");
    if (!user || !(await user.comparePassword(currentPassword))) {
      logger.warn(
        `[TENANT_AUTH] Failed password change for user: ${req.user!._id} from IP: ${ipAddress} - Reason: Incorrect current password`
      );
      throw ApiError.invalidField(
        "currentPassword",
        "Current password is incorrect."
      );
    }

    const newHash = await hashPassword(newPassword);
    const accessToken = generateAccessToken({
      userId: user._id.toString(),
      organizationId: user.organizationId!.toString(),
      isSuperAdmin: false,
    });
    const { token: refreshToken, hashedToken } = generateRefreshToken();

    const result = await User.updateOne(
      { _id: user._id, passwordHash: user.passwordHash },
      {
        $set: {
          passwordHash: newHash,
          refreshTokens: [
            {
              token: hashedToken,
              createdAt: new Date(),
              expiresAt: getExpiryDate(env.JWT_REFRESH_EXPIRY),
              userAgent: req.headers["user-agent"],
              ipAddress: String(ipAddress),
            },
          ],
        },
      }
    );

    if (result.matchedCount === 0) {
      logger.warn(
        `[TENANT_AUTH] Failed password change for user: ${user._id} from IP: ${ipAddress} - Reason: Password changed concurrently`
      );
      throw ApiError.coded(
        409,
        "PASSWORD_CHANGED_CONCURRENTLY",
        "Your password was changed by another request. Please sign in again."
      );
    }

    logger.info(
      `[TENANT_AUTH] Password changed for user: ${user._id} from IP: ${ipAddress} - All other sessions revoked`
    );

    const userResponse = user.toObject() as any;
    delete userResponse.passwordHash;
    delete userResponse.refreshTokens;

    res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { accessToken, refreshToken, user: userResponse },
          "Password changed successfully. Other devices have been signed out."
        )
      );
  }
);
