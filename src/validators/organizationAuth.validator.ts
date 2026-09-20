/**
 * Purpose: Organization/Tenant Authentication Validators.
 * Provides Zod validation schemas for organization signup and tenant login operations.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "./platformAuth.validator";

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
