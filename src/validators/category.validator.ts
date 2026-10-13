/**
 * Purpose: Category Validators.
 * Categories are a flat, organization-wide list used to group products. A `parentId` may be added
 * later without breaking this contract.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

const nameField = z
  .string()
  .trim()
  .min(1, { message: "Category name is required." })
  .max(60, { message: "Category name must be at most 60 characters long." })
  .openapi({ description: "Unique within your organization (case-insensitive).", example: "Beverages" });

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
  })
  .strict({ message: "Unknown field. Only name and sortOrder are accepted." });

export const updateCategorySchema = z
  .object({
    name: nameField.optional(),
    sortOrder: sortOrderField.optional(),
  })
  .strict({ message: "Unknown field. Only name and sortOrder can be updated." })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field (name, sortOrder) must be provided.",
  });

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
