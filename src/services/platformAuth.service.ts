/**
 * Purpose: Platform Authentication Service.
 * Provides utility methods to generate and verify JWT access tokens and opaque refresh tokens specifically for Super Admins.
 * Leverages the platform JWT secrets to enforce a strict security boundary.
 */

import jwt from "jsonwebtoken";
import { env } from "../config/env.config";
import { ApiError } from "../utils/ApiError";
import {
  generateOpaqueToken,
  GeneratedRefreshToken,
} from "../utils/token.util";

export interface SuperAdminAccessTokenPayload {
  userId: string;
  aud: "platform";
  isSuperAdmin: true;
}

/**
 * Generates a signed JWT Access Token for Super Admins.
 * Signed with JWT_PLATFORM_SECRET.
 * Includes fixed claim: { aud: 'platform', isSuperAdmin: true } to distinguish platform tokens.
 */
export function generateSuperAdminAccessToken(payload: {
  userId: string;
}): string {
  const tokenPayload: SuperAdminAccessTokenPayload = {
    userId: payload.userId,
    aud: "platform",
    isSuperAdmin: true,
  };
  // Cast expiry to any to satisfy the jsonwebtoken library's signature requirements
  return jwt.sign(tokenPayload, env.JWT_PLATFORM_SECRET, {
    expiresIn: env.JWT_PLATFORM_ACCESS_EXPIRY as never,
  });
}

/**
 * Generates a cryptographically secure opaque refresh token for Super Admins.
 * Reuses the shared opaque token utility.
 */
export function generateSuperAdminRefreshToken(): GeneratedRefreshToken {
  return generateOpaqueToken();
}

/**
 * Verifies and decodes a Super Admin JWT Access Token.
 * Throws a structured ApiError (401) on failure.
 */
export function verifySuperAdminAccessToken(
  token: string
): SuperAdminAccessTokenPayload {
  try {
    const decoded = jwt.verify(
      token,
      env.JWT_PLATFORM_SECRET
    ) as SuperAdminAccessTokenPayload;

    if (decoded.aud !== "platform" || decoded.isSuperAdmin !== true) {
      throw new ApiError(
        401,
        "Authentication failed: Invalid access token audience or claims."
      );
    }

    return decoded;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "TokenExpiredError") {
      throw new ApiError(
        401,
        "Authentication failed: Platform access token has expired. Please log in again."
      );
    }
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      401,
      "Authentication failed: Platform access token signature is invalid or corrupted."
    );
  }
}
