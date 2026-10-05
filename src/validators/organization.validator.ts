/**
 * Purpose: Organization Validators (tenant side).
 * Provides the Zod schema for updating the caller's organization profile and settings.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { CURRENCY_CODES } from "../config/currencies.config";
import { timezoneField } from "./store.validator";

export const currencyField = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(CURRENCY_CODES, { message: `currency must be one of: ${CURRENCY_CODES.join(", ")}.` }))
  .openapi({ description: "ISO 4217 currency code.", example: "BHD" });

export const updateOrganizationSchema = z
  .object({
    legalName: z
      .string()
      .trim()
      .min(1, { message: "Legal name cannot be empty. Send null to clear it." })
      .max(200, { message: "Legal name must be at most 200 characters long." })
      .nullable()
      .optional()
      .openapi({ description: "Registered legal name printed on documents. null clears it.", example: "Al Noor Trading W.L.L." }),
    taxRegistrationNumber: z
      .string()
      .trim()
      .transform((value) => value.replace(/[\s-]/g, "").toUpperCase())
      .pipe(
        z.string().regex(/^[A-Z0-9]{5,20}$/, {
          message: "Tax registration number must be 5-20 letters or digits.",
        })
      )
      .nullable()
      .optional()
      .openapi({ description: "VAT Tax Registration Number (TRN). Spaces and hyphens are removed. null clears it.", example: "220000123400002" }),
    settings: z
      .object({
        currency: currencyField.optional(),
        timezone: timezoneField.optional(),
        inventory: z
          .object({
            allowNegativeStock: z.boolean().optional().openapi({
              description: "Allow sales and adjustments to take stock below zero. Default false.",
              example: false,
            }),
          })
          .strict()
          .optional(),
      })
      .strict({ message: "Unknown settings field. Only currency, timezone and inventory can be updated." })
      .optional(),
  })
  .strict({ message: "Unknown field. Only legalName, taxRegistrationNumber and settings can be updated." })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field (legalName, taxRegistrationNumber, settings) must be provided.",
  });

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
