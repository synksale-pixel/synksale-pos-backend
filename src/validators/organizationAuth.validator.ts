/**
 * Purpose: Organization/Tenant Authentication Validators.
 * Provides Zod validation schemas for organization signup and tenant login operations.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "./platformAuth.validator";
import { CURRENCY_CODES, DEFAULT_CURRENCY } from "../config/currencies.config";

export const signupSchema = z.object({
  organizationName: z
    .string()
    .trim()
    .min(2, { message: "Organization name must be at least 2 characters long." })
    .max(100, { message: "Organization name must be at most 100 characters long." })
    .openapi({
      description:
        "Business/organization name. The login slug (orgSlug) is generated from it.",
      example: "Sharma General Store",
    }),
  contactEmail: z
    .string()
    .trim()
    .email({ message: "Invalid contact email format." })
    .optional()
    .openapi({
      description: "Public contact email. Defaults to adminEmail when omitted.",
      example: "contact@sharmastore.in",
    }),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s\-()]{7,20}$/, { message: "Invalid contact phone number format." })
    .openapi({
      description:
        "7-20 characters: digits, spaces, hyphens, parentheses, optional leading +.",
      example: "+91 98765 43210",
    }),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(CURRENCY_CODES, { message: `currency must be one of: ${CURRENCY_CODES.join(", ")}.` }))
    .optional()
    .openapi({
      description: `ISO 4217 currency the organization trades in. Defaults to ${DEFAULT_CURRENCY}. The country's standard VAT rate is seeded as the default tax rate.`,
      example: "BHD",
    }),
  adminFirstName: z
    .string()
    .trim()
    .min(1, { message: "Admin first name is required." })
    .max(50, { message: "Admin first name must be at most 50 characters long." })
    .openapi({ example: "Rohan" }),
  adminLastName: z
    .string()
    .trim()
    .min(1, { message: "Admin last name is required." })
    .max(50, { message: "Admin last name must be at most 50 characters long." })
    .openapi({ example: "Sharma" }),
  adminEmail: z
    .string()
    .trim()
    .email({ message: "Invalid admin email format." })
    .openapi({
      description:
        "Email of the first (organization admin) user; also their login email. Only one pending/approved application is allowed per admin email.",
      example: "rohan@sharmastore.in",
    }),
  adminPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, {
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    })
    .openapi({
      description: `Minimum ${PASSWORD_MIN_LENGTH} characters.`,
      example: "S3cure!Passw0rd",
    }),
});

export const tenantLoginSchema = z.object({
  orgSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, { message: "Organization slug is required." })
    .openapi({
      description:
        "Organization slug (returned as organization.slug at signup). Case-insensitive; lowercased by the server. Identifies which tenant the email belongs to, since the same email can exist in several organizations.",
      example: "sharma-general-store",
    }),
  email: z
    .string()
    .trim()
    .email({ message: "Invalid email format." })
    .openapi({ example: "rohan@sharmastore.in" }),
  password: z
    .string()
    .min(1, { message: "Password is required." })
    .openapi({ example: "S3cure!Passw0rd" }),
});

const profileName = (label: string, example: string) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} cannot be empty.` })
    .max(50, { message: `${label} must be at most 50 characters long.` })
    .openapi({ example });

/**
 * PATCH /auth/me: the signed-in user edits their own display name.
 * Strict on purpose: this route has no permission gate, so any other key (orgRoleId,
 * storeAccess, email, isActive, ...) must be rejected, never silently applied or dropped.
 */
export const updateMeSchema = z
  .object({
    firstName: profileName("First name", "Rohan").optional(),
    lastName: profileName("Last name", "Sharma").optional(),
  })
  .strict()
  .refine((body) => body.firstName !== undefined || body.lastName !== undefined, {
    message: "Provide at least one of firstName or lastName.",
  });

/** POST /auth/change-password */
export const changePasswordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, { message: "Current password is required." })
      .openapi({ description: "The user's current password.", example: "OldPassw0rd!" }),
    newPassword: z
      .string()
      .min(PASSWORD_MIN_LENGTH, {
        message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
      })
      .openapi({ description: `Minimum ${PASSWORD_MIN_LENGTH} characters.`, example: "N3wS3cure!Pass" }),
  })
  .refine((body) => body.newPassword !== body.currentPassword, {
    message: "New password must be different from the current password.",
    path: ["newPassword"],
  });
