/**
 * Purpose: Organization/Tenant Authentication Validators.
 * Provides Zod validation schemas for organization signup and tenant login operations.
 */

import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "./platformAuth.validator";

export const signupSchema = z.object({
  organizationName: z
    .string()
    .trim()
    .min(2, { message: "Organization name must be at least 2 characters long." })
    .max(100, { message: "Organization name must be at most 100 characters long." }),
  contactEmail: z
    .string()
    .trim()
    .email({ message: "Invalid contact email format." }),
  adminFirstName: z
    .string()
    .trim()
    .min(1, { message: "Admin first name is required." })
    .max(50, { message: "Admin first name must be at most 50 characters long." }),
  adminLastName: z
    .string()
    .trim()
    .min(1, { message: "Admin last name is required." })
    .max(50, { message: "Admin last name must be at most 50 characters long." }),
  adminEmail: z
    .string()
    .trim()
    .email({ message: "Invalid admin email format." }),
  adminPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, {
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    }),
});

export const tenantLoginSchema = z.object({
  orgSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, { message: "Organization slug is required." }),
  email: z
    .string()
    .trim()
    .email({ message: "Invalid email format." }),
  password: z
    .string()
    .min(1, { message: "Password is required." }),
});
