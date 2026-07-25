/**
 * Purpose: Token utilities.
 * Provides utility methods for generating opaque tokens, hashing, and parsing durations.
 */

import crypto from "crypto";

export interface GeneratedRefreshToken {
  token: string; // Plaintext token to return to the client
  hashedToken: string; // Hashed version to store in the database
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
export function generateOpaqueToken(): GeneratedRefreshToken {
  const plaintext = crypto.randomBytes(40).toString("hex");
  const hashedToken = crypto
    .createHash("sha256")
    .update(plaintext)
    .digest("hex");

  return {
    token: plaintext,
    hashedToken,
  };
}

/**
 * Hashes a plaintext token using SHA-256.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Parses a simple duration string (e.g. '3d', '10m', '1h', '30s') and returns the expiry Date.
 */
export function getExpiryDate(duration: string): Date {
  const matches = duration.match(/^(\d+)([smhd])$/);
  if (!matches) {
    // Default to 3 days if unparseable
    return new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  }
  const value = parseInt(matches[1], 10);
  const unit = matches[2];
  let ms = 0;
  switch (unit) {
    case "s":
      ms = value * 1000;
      break;
    case "m":
      ms = value * 60 * 1000;
      break;
    case "h":
      ms = value * 60 * 60 * 1000;
      break;
    case "d":
      ms = value * 24 * 60 * 60 * 1000;
      break;
  }
  return new Date(Date.now() + ms);
}
