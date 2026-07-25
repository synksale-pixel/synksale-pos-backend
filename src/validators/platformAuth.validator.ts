/**
 * Purpose: Platform Authentication Validators.
 * Provides Zod validation schemas for Super Admin login and logout/refresh operations.
 */

import { z } from "zod";

// Shared password minimum length constant (will eventually be shared with tenant validation rules)
export const PASSWORD_MIN_LENGTH = 8;

export const loginSchema = z.object({
  email: z.string().trim().email({ message: "Invalid email format." }),
  password: z.string().min(PASSWORD_MIN_LENGTH, {
    message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
  }),
});

export const refreshSchema = z.object({
  refreshToken: z
    .string()
    .trim()
    .min(1, { message: "Refresh token is required." }),
});

export const logoutSchema = z.object({
  refreshToken: z
    .string()
    .trim()
    .min(1, { message: "Refresh token is required." }),
});
