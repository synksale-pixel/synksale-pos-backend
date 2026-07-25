/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Platform Authentication Controller.
 * Handles Super Admin login, token refresh (with rotation), logout, and logout-all operations.
 * Enforces security boundaries, prevents user enumeration, and performs structured audit logging.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { ApiResponse } from "../utils/ApiResponse";
import { logger } from "../config/logger.config";
import {
  generateSuperAdminAccessToken,
  generateSuperAdminRefreshToken,
} from "../services/platformAuth.service";
import { hashToken, getExpiryDate } from "../utils/token.util";
import { User } from "../models/user.model";
import { env } from "../config/env.config";

/**
 * Super Admin Login:
 * Validates credentials, checks account status, issues access and refresh tokens,
 * updates lastLoginAt, and logs success/failure attempts.
 */
export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const ipAddress =
    req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  // Find User by email and isSuperAdmin flag (explicitly selecting passwordHash which is hidden by default)
  const user = await User.findOne({
    email: email.toLowerCase(),
    isSuperAdmin: true,
  }).select("+passwordHash");

  // Prevent user enumeration by throwing a generic "Invalid credentials" error regardless of specific failure
  if (!user) {
    logger.warn(
      `[PLATFORM_AUTH] Failed login attempt for email: ${email} from IP: ${ipAddress} - Reason: User not found`
    );
    throw new ApiError(401, "Invalid credentials");
  }

  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    logger.warn(
      `[PLATFORM_AUTH] Failed login attempt for email: ${email} from IP: ${ipAddress} - Reason: Incorrect password`
    );
    throw new ApiError(401, "Invalid credentials");
  }

  if (!user.isActive) {
    logger.warn(
      `[PLATFORM_AUTH] Failed login attempt for email: ${email} from IP: ${ipAddress} - Reason: Account inactive`
    );
    throw new ApiError(401, "Invalid credentials");
  }

  // Generate tokens
  const accessToken = generateSuperAdminAccessToken({
    userId: user._id.toString(),
  });
  const { token, hashedToken } = generateSuperAdminRefreshToken();
  const expiresAt = getExpiryDate(env.JWT_PLATFORM_REFRESH_EXPIRY);

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

  // TODO: promote this to a dedicated immutable AuditLog collection once the audit logging system is built — for now this relies on Winston file logs
  logger.info(
    `[PLATFORM_AUTH] Successful login for super admin user: ${user._id} from IP: ${ipAddress}`
  );

  const userResponse = user.toObject() as any;
  delete userResponse.passwordHash;
  delete userResponse.refreshTokens;

  res.status(200).json(
    new ApiResponse(
      200,
      {
        accessToken,
        refreshToken: token,
        user: userResponse,
      },
      "Logged in successfully"
    )
  );
});

/**
 * Super Admin Token Refresh:
 * Validates a plaintext refresh token against database hashes, rotates the token
 * (invalidates the used refresh token and issues a new one), and returns new tokens.
 */
export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  const ipAddress =
    req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const hashedToken = hashToken(refreshToken);

  // Find user holding the hashed refresh token
  const user = await User.findOne({
    isSuperAdmin: true,
    "refreshTokens.token": hashedToken,
  });

  if (!user) {
    logger.warn(
      `[PLATFORM_AUTH] Failed refresh attempt from IP: ${ipAddress} - Reason: Invalid refresh token`
    );
    throw new ApiError(
      401,
      "Authentication failed: Invalid or expired refresh token."
    );
  }

  if (!user.isActive) {
    logger.warn(
      `[PLATFORM_AUTH] Failed refresh attempt for user: ${user._id} from IP: ${ipAddress} - Reason: Account inactive`
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

  // Check if token has expired
  if (storedToken.expiresAt < new Date()) {
    // Remove expired token from DB
    user.refreshTokens.splice(tokenIndex, 1);
    await user.save();

    logger.warn(
      `[PLATFORM_AUTH] Failed refresh attempt for user: ${user._id} from IP: ${ipAddress} - Reason: Expired refresh token`
    );
    throw new ApiError(
      401,
      "Authentication failed: Refresh token has expired."
    );
  }

  // Token Rotation: Generate new access + refresh tokens and replace the old one in the DB.
  //
  // DESIGN NOTE ON COMPROMISE DETECTION:
  // If a refresh token is ever reused after rotation, it signals a potential token hijacking.
  // FUTURE ENHANCEMENT: Implement a mechanism to check if a revoked/rotated token is reused.
  // If reuse is detected, immediately revoke all active refresh tokens for that user to terminate all sessions.
  const newAccessToken = generateSuperAdminAccessToken({
    userId: user._id.toString(),
  });
  const newRefreshToken = generateSuperAdminRefreshToken();
  const expiresAt = getExpiryDate(env.JWT_PLATFORM_REFRESH_EXPIRY);

  user.refreshTokens[tokenIndex] = {
    token: newRefreshToken.hashedToken,
    createdAt: new Date(),
    expiresAt,
    userAgent: req.headers["user-agent"],
    ipAddress: String(ipAddress),
  };

  await user.save();

  // TODO: promote this to a dedicated immutable AuditLog collection once the audit logging system is built — for now this relies on Winston file logs
  logger.info(
    `[PLATFORM_AUTH] Successful token rotation for super admin user: ${user._id} from IP: ${ipAddress}`
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
 * Super Admin Logout:
 * Revokes the specific refresh token associated with the request (current device).
 */
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  const ipAddress =
    req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const hashedToken = hashToken(refreshToken);

  const user = await User.findOne({
    isSuperAdmin: true,
    "refreshTokens.token": hashedToken,
  });

  if (user) {
    // Remove the current token from the array
    user.refreshTokens = user.refreshTokens.filter(
      (t) => t.token !== hashedToken
    );
    await user.save();

    // TODO: promote this to a dedicated immutable AuditLog collection once the audit logging system is built — for now this relies on Winston file logs
    logger.info(
      `[PLATFORM_AUTH] Successful logout (device token revoked) for super admin user: ${user._id} from IP: ${ipAddress}`
    );
  } else {
    logger.debug(
      `[PLATFORM_AUTH] Logout request with unrecognized token from IP: ${ipAddress}`
    );
  }

  res.status(200).json(new ApiResponse(200, null, "Logged out successfully"));
});

/**
 * Super Admin Logout All Devices:
 * Protected route that clears all refresh tokens for the authenticated Super Admin.
 */
export const logoutAllDevices = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user!;
    const ipAddress =
      req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

    // Clear all sessions
    user.refreshTokens = [];
    await user.save();

    // TODO: promote this to a dedicated immutable AuditLog collection once the audit logging system is built — for now this relies on Winston file logs
    logger.info(
      `[PLATFORM_AUTH] Successful logout from all devices for super admin user: ${user._id} from IP: ${ipAddress}`
    );

    res
      .status(200)
      .json(
        new ApiResponse(200, null, "Logged out from all devices successfully")
      );
  }
);

/**
 * Get Profile:
 * Returns the currently authenticated super admin profile.
 */
export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const userResponse = user.toObject() as any;
  delete userResponse.passwordHash;
  delete userResponse.refreshTokens;

  res
    .status(200)
    .json(new ApiResponse(200, userResponse, "Profile fetched successfully"));
});
