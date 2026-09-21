/**
 * Purpose: Store Validators.
 * Provides Zod validation schemas for creating and updating stores.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

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
  .openapi({ description: "Display name of the store.", example: "Sharma Store - Indiranagar" });

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
    example: "BLR-001",
  });

const timezoneField = z
  .string()
  .trim()
  .refine(isValidTimezone, { message: "Invalid timezone. Use an IANA timezone such as 'Asia/Kolkata'." })
  .openapi({ description: "IANA timezone of the store.", example: "Asia/Kolkata" });

const requiredText = (label: string, max: number, example: string) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} is required.` })
    .max(max, { message: `${label} must be at most ${max} characters long.` })
    .openapi({ example });

const addressShape = {
  line1: requiredText("Address line 1", 200, "12, 100 Feet Road"),
  line2: z
    .string()
    .trim()
    .max(200, { message: "Address line 2 must be at most 200 characters long." })
    .optional()
    .openapi({ example: "Indiranagar" }),
  city: requiredText("City", 100, "Bengaluru"),
  state: requiredText("State", 100, "Karnataka"),
  country: requiredText("Country", 100, "India"),
  postalCode: requiredText("Postal code", 20, "560038"),
};

export const createStoreSchema = z.object({
  name: nameField,
  code: codeField,
  address: z.object(addressShape),
  timezone: timezoneField,
});

export const updateStoreSchema = z
  .object({
    name: nameField.optional(),
    address: z.object(addressShape).partial().optional().openapi({
      description: "Any subset of address fields; omitted fields are left unchanged.",
    }),
    timezone: timezoneField.optional(),
  })
  .strict({ message: "Unknown or immutable field. Only name, address and timezone can be updated." })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field (name, address, timezone) must be provided.",
  });

export type CreateStoreInput = z.infer<typeof createStoreSchema>;
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;
