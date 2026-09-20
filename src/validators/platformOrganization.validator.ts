/**
 * Purpose: Platform Organization Review Validators.
 * Provides Zod validation schemas for Super Admin organization approve/reject operations.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

export const approveOrganizationSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(3, { message: "Slug must be at least 3 characters long." })
      .max(60, { message: "Slug must be at most 60 characters long." })
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: "Slug may contain only lowercase letters, numbers, and single hyphens.",
      })
      .optional()
      .openapi({
        description:
          "Optional slug correction applied at approval time (e.g. to fix a suffixed slug). 3-60 chars, lowercase letters/numbers/single hyphens. 409 if used by another organization.",
        example: "sharma-general-store",
      }),
  })
  .default({});

export const rejectOrganizationSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, { message: "Rejection reason must be at least 5 characters long." })
    .max(500, { message: "Rejection reason must be at most 500 characters long." })
    .openapi({
      description: "Why the application was rejected (5-500 chars). Stored on the organization.",
      example: "Business registration documents could not be verified.",
    }),
});
