/**
 * Purpose: Category Validators.
 * Categories group products organization-wide and may be nested one level (Category →
 * Subcategory). Sending `parentId` on create nests the new category; on update it moves the
 * category (null makes it a root). Depth and cycle rules are checked by the service, which knows
 * the stored tree.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

const nameField = z
  .string()
  .trim()
  .min(1, { message: "Category name is required." })
  .max(60, { message: "Category name must be at most 60 characters long." })
  .openapi({ description: "Unique within your organization (case-insensitive).", example: "Beverages" });

const parentIdField = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, { message: "parentId must be a 24-character hex id." })
  .nullable()
  .openapi({
    description:
      "The parent category, or null for a top-level category. Categories nest at most 2 levels, so the parent must itself be top-level.",
    example: "665f1c2e8a4b3c0012ab3701",
  });

const sortOrderField = z
  .number({ invalid_type_error: "sortOrder must be a number." })
  .int({ message: "sortOrder must be a whole number." })
  .min(0, { message: "sortOrder cannot be negative." })
  .max(100000, { message: "sortOrder must be at most 100000." })
  .openapi({ description: "Display order, ascending. Defaults to 0; ties sort by name.", example: 10 });

export const createCategorySchema = z
  .object({
    name: nameField,
    sortOrder: sortOrderField.optional(),
    parentId: parentIdField.optional(),
  })
  .strict({ message: "Unknown field. Only name, sortOrder and parentId are accepted." });

export const updateCategorySchema = z
  .object({
    name: nameField.optional(),
    sortOrder: sortOrderField.optional(),
    parentId: parentIdField.optional().openapi({
      description: "Moves the category under another top-level category, or to the top level with null.",
    }),
  })
  .strict({ message: "Unknown field. Only name, sortOrder and parentId can be updated." })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field (name, sortOrder, parentId) must be provided.",
  });

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
