/**
 * Purpose: Store Validators.
 * Provides Zod validation schemas for creating and updating stores.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { COUNTRY_CODES } from "../config/currencies.config";

const isValidTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const nameField = z
  .string()
  .trim()
  .min(1, { message: "Store name is required." })
  .max(100, { message: "Store name must be at most 100 characters long." })
  .openapi({ description: "Display name of the store.", example: "Al Noor - Seef Mall" });

const codeField = z
  .string()
  .trim()
  .min(1, { message: "Store code is required." })
  .max(20, { message: "Store code must be at most 20 characters long." })
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    message: "Store code may only contain letters, numbers, hyphens and underscores.",
  })
  .openapi({
    description:
      "Short code, unique within your organization. Stored uppercase. Cannot be changed after creation.",
    example: "MNM-001",
  });

export const timezoneField = z
  .string()
  .trim()
  .refine(isValidTimezone, { message: "Invalid timezone. Use an IANA timezone such as 'Asia/Kolkata'." })
  .openapi({ description: "IANA timezone of the store.", example: "Asia/Bahrain" });

const requiredText = (label: string, max: number, example: string) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} is required.` })
    .max(max, { message: `${label} must be at most ${max} characters long.` })
    .openapi({ example });

const addressShape = {
  line1: requiredText("Address line 1", 200, "Building 2102, Road 2825"),
  line2: z
    .string()
    .trim()
    .max(200, { message: "Address line 2 must be at most 200 characters long." })
    .optional()
    .openapi({ example: "Block 428" }),
  city: requiredText("City", 100, "Manama"),
  state: requiredText("State", 100, "Capital Governorate"),
  country: requiredText("Country", 100, "Bahrain"),
  postalCode: requiredText("Postal code", 20, "428"),
};

const countryCodeField = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(COUNTRY_CODES, { message: `countryCode must be one of: ${COUNTRY_CODES.join(", ")}.` }))
  .openapi({
    description:
      "ISO 3166-1 alpha-2 country of the store. Must use the organization's currency (e.g. BH for a BHD organization).",
    example: "BH",
  });

export const createStoreSchema = z.object({
  name: nameField,
  code: codeField,
  address: z.object(addressShape),
  countryCode: countryCodeField,
  timezone: timezoneField,
});

export const updateStoreSchema = z
  .object({
    name: nameField.optional(),
    address: z.object(addressShape).partial().optional().openapi({
      description: "Any subset of address fields; omitted fields are left unchanged.",
    }),
    countryCode: countryCodeField.optional(),
    timezone: timezoneField.optional(),
  })
  .strict({
    message: "Unknown or immutable field. Only name, address, countryCode and timezone can be updated.",
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field (name, address, countryCode, timezone) must be provided.",
  });

export type CreateStoreInput = z.infer<typeof createStoreSchema>;
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;
