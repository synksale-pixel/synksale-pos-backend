/**
 * Purpose: Tax Rate Validators.
 * Provides Zod validation schemas for creating and updating tax rates.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

const nameField = z
  .string()
  .trim()
  .min(1, { message: "Tax rate name is required." })
  .max(50, { message: "Tax rate name must be at most 50 characters long." })
  .openapi({ description: "Unique within your organization (case-insensitive).", example: "VAT 10%" });

const componentSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: "Component name is required." })
    .max(30, { message: "Component name must be at most 30 characters long." })
    .openapi({ example: "VAT" }),
  rate: z
    .number({ invalid_type_error: "Component rate must be a number." })
    .min(0, { message: "Component rate cannot be negative." })
    .max(100, { message: "Component rate cannot exceed 100." })
    .refine((value) => Number.isInteger(Number((value * 10000).toFixed(6))), {
      message: "Component rate may have at most 4 decimal places.",
    })
    .openapi({ description: "Percentage, e.g. 10 for 10%.", example: 10 }),
});

const componentsField = z
  .array(componentSchema)
  .min(1, { message: "At least one tax component is required." })
  .max(5, { message: "At most 5 tax components are allowed." })
  .refine((components) => components.reduce((total, c) => total + c.rate, 0) <= 100, {
    message: "The combined rate cannot exceed 100%.",
  })
  .openapi({
    description:
      "One entry for a single-rate VAT; several for a split tax. The rate applied is their sum.",
    example: [{ name: "VAT", rate: 10 }],
  });

export const createTaxRateSchema = z.object({
  name: nameField,
  components: componentsField,
  isDefault: z
    .boolean()
    .optional()
    .openapi({ description: "Make this the organization's default rate (unsets the previous one).", example: false }),
});

export const updateTaxRateSchema = z
  .object({
    name: nameField.optional(),
    components: componentsField.optional(),
  })
  .strict({ message: "Unknown field. Only name and components can be updated." })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field (name, components) must be provided.",
  });

export type CreateTaxRateInput = z.infer<typeof createTaxRateSchema>;
export type UpdateTaxRateInput = z.infer<typeof updateTaxRateSchema>;
