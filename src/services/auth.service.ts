/**
 * Purpose: Authentication Service.
 * Provides utility methods to generate and verify JWT access tokens and opaque refresh tokens.
 * Secures refresh tokens at rest by hashing them using SHA-256.
 */

import jwt from "jsonwebtoken";
import { env } from "../config/env.config";
import { ApiError } from "../utils/ApiError";
import {
  generateOpaqueToken,
  GeneratedRefreshToken,
} from "../utils/token.util";

export interface AccessTokenPayload {
  userId: string;
  organizationId: string;
  isSuperAdmin: boolean;
}

/**
 * Generates a signed JWT Access Token.
 *
 * DESIGN DECISION:
 * We deliberately omit the user's full permissions array from the JWT payload.
 * Permissions can change server-side (e.g. role modification, user deactivation, store assignment changes)
 * and storing them in the token would cause the token to be stale until it expires.
 * Instead, permissions are fetched fresh from the DB per request (leveraging caching if needed later).
 */
export function generateAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY as never, // Cast if necessary for jsonwebtoken types
  });
}

/**
 * Generates a cryptographically secure opaque refresh token.
 * Returns both the plaintext (sent to client) and its SHA-256 hash (stored in the database).
 *
 * WHY OPAQUE REFRESH TOKENS:
 * Opaque refresh tokens are easier to revoke than self-contained JWT refresh tokens.
 * To revoke an opaque token, we simply delete/modify the matching record in the database.
 * Storing the hashed token at rest prevents an attacker with database read access from using
 * hijacked tokens to spawn new sessions.
 */
export function generateRefreshToken(): GeneratedRefreshToken {
  return generateOpaqueToken();
}

/**
 * Verifies and decodes a JWT Access Token.
 * Throws a structured ApiError (401) on failure.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(
      token,
      env.JWT_ACCESS_SECRET
    ) as AccessTokenPayload;
    return {
      userId: decoded.userId,
      organizationId: decoded.organizationId,
      isSuperAdmin: decoded.isSuperAdmin,
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "TokenExpiredError") {
      throw new ApiError(
        401,
        "Authentication failed: Access token has expired. Please log in again."
      );
    }
    throw new ApiError(
      401,
      "Authentication failed: Access token signature is invalid or corrupted."
    );
  }
}
