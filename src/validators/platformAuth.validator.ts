/**
 * Purpose: Platform Authentication Validators.
 * Provides Zod validation schemas for Super Admin login and logout/refresh operations.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

// Shared password minimum length constant (will eventually be shared with tenant validation rules)
export const PASSWORD_MIN_LENGTH = 8;

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email({ message: "Invalid email format." })
    .openapi({
      description: "Super Admin email address.",
      example: "admin@synksale.com",
    }),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, {
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    })
    .openapi({
      description: `Minimum ${PASSWORD_MIN_LENGTH} characters.`,
      example: "S3cure!Passw0rd",
    }),
});

export const refreshSchema = z.object({
  refreshToken: z
    .string()
    .trim()
    .min(1, { message: "Refresh token is required." })
    .openapi({
      description:
        "Opaque refresh token issued at login/refresh. Single-use: it is rotated on every refresh.",
      example:
        "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e",
    }),
});

export const logoutSchema = z.object({
  refreshToken: z
    .string()
    .trim()
    .min(1, { message: "Refresh token is required." })
    .openapi({
      description: "The refresh token of the session/device to sign out.",
      example:
        "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e",
    }),
});
