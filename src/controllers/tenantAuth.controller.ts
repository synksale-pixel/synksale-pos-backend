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
import { generateAccessToken, generateRefreshToken } from "../services/auth.service";
import { hashToken, getExpiryDate } from "../utils/token.util";
import { Organization } from "../models/organization.model";
import { User } from "../models/user.model";
import { getEffectivePermissions } from "../services/permission.service";
import { env } from "../config/env.config";

/**
 * Tenant Signup:
 * Atomically registers a new organization, seeds standard roles, and creates the admin user.
 */
export const signup = asyncHandler(async (req: Request, res: Response) => {
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  const result = await signupOrganization({
    ...req.body,
    ipAddress: String(ipAddress),
    userAgent: req.headers["user-agent"],
  });

  logger.info(
    `[TENANT_AUTH] Successful organization signup: ${result.organization.name} (ID: ${result.organization._id}) and admin email: ${req.body.adminEmail} from IP: ${ipAddress}`
  );

  res.status(201).json(
    new ApiResponse(
      201,
      result,
      "Organization and administrator account registered successfully."
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
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  // 1. Resolve organization by slug
  const organization = await Organization.findOne({ slug: orgSlug.toLowerCase() });

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

  // 4. Safe post-verification check: verify activation states
  // Since password verification succeeded, enumeration risk is resolved.
  if (!organization.isActive) {
    logger.warn(
      `[TENANT_AUTH] Failed login attempt for email: ${email} in org: ${orgSlug} from IP: ${ipAddress} - Reason: Organization suspended`
    );
    throw new ApiError(403, "Access Denied: Your organization account has been suspended.");
  }

  if (!user.isActive) {
    logger.warn(
      `[TENANT_AUTH] Failed login attempt for email: ${email} in org: ${orgSlug} from IP: ${ipAddress} - Reason: User deactivated`
    );
    throw new ApiError(403, "Access Denied: Your user account has been deactivated.");
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
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const hashedToken = hashToken(refreshToken);

  // Find non-super-admin user holding this hashed refresh token
  const user = await User.findOne({
    isSuperAdmin: false,
    "refreshTokens.token": hashedToken,
  });

  if (!user) {
    logger.warn(
      `[TENANT_AUTH] Failed refresh attempt from IP: ${ipAddress} - Reason: Invalid refresh token`
    );
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

  const tokenIndex = user.refreshTokens.findIndex((t) => t.token === hashedToken);
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
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const hashedToken = hashToken(refreshToken);

  const user = await User.findOne({
    isSuperAdmin: false,
    "refreshTokens.token": hashedToken,
  });

  if (user) {
    user.refreshTokens = user.refreshTokens.filter((t) => t.token !== hashedToken);
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
export const logoutAllDevices = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  user.refreshTokens = [];
  await user.save();

  logger.info(
    `[TENANT_AUTH] Successful logout from all devices for user: ${user._id} from IP: ${ipAddress}`
  );

  res.status(200).json(
    new ApiResponse(200, null, "Logged out from all devices successfully")
  );
});

/**
 * Me/Profile Endpoint:
 * Resolves current user's profile and returns their effective permissions.
 * Accepts optional storeId parameter from query string to include store-level authorization context.
 */
export const me = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const storeId = req.query.storeId as string | undefined;

  // Resolve permissions dynamically based on the current context (including store context if provided)
  const permissions = await getEffectivePermissions(user, storeId);

  const userResponse = user.toObject() as any;
  delete userResponse.passwordHash;
  delete userResponse.refreshTokens;

  res.status(200).json(
    new ApiResponse(
      200,
      {
        ...userResponse,
        permissions,
      },
      "Profile and permissions resolved successfully"
    )
  );
});
