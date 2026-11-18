/**
 * Purpose: Store Validators.
 * Provides Zod validation schemas for creating and updating stores.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { COUNTRY_CODES } from "../config/currencies.config";
import { GST_STATE_CODES } from "../config/gstStates.config";
import { normalizeTaxId, taxIdProblem } from "../utils/taxId";

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
  stateCode: z
    .enum(GST_STATE_CODES, { message: "stateCode must be a two-digit GST state code (e.g. 29 for Karnataka)." })
    .nullable()
    .optional()
    .openapi({
      description:
        "India only: the two-digit GST state code of the store, printed as the place of supply. Required for a store in India (countryCode IN), and its effective GSTIN must start with it. Must be absent or null elsewhere.",
      example: "29",
    }),
};

// ==========================================
// Phase 4a-1: tax ID, receipt header and invoice numbering
// ==========================================

const optionalText = (label: string, max: number, example: string) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} cannot be empty. Send null to clear it.` })
    .max(max, { message: `${label} must be at most ${max} characters long.` })
    .nullable()
    .optional()
    .openapi({ example });

/** A tax ID with only the generic rule; the country format is checked where the country is known. */
export const storeTaxIdField = z
  .string()
  .transform(normalizeTaxId)
  .refine((value) => taxIdProblem(null, value) === null, { message: "Tax registration number must be 5-20 letters or digits." });

const phase4aStoreFields = {
  legalName: optionalText("Legal name", 200, "Al Noor Trading W.L.L. - Seef Branch").openapi({
    description: "Legal name printed on this store's receipts. null/absent uses the organization's legalName.",
  }),
  legalNameAr: optionalText("Arabic legal name", 200, "شركة النور للتجارة").openapi({
    description: "Arabic legal name for Saudi receipts and the ZATCA QR code. null/absent uses the organization's legalNameAr.",
  }),
  taxRegistrationNumber: storeTaxIdField.nullable().optional().openapi({
    description:
      "This store's own VAT TRN / GSTIN, when it differs from the organization's (e.g. an Indian store in another state). Spaces and hyphens are removed and it is uppercased, then checked against the store's country: IN a valid GSTIN (with check character) starting with the store's stateCode; SA 15 digits starting and ending with 3; AE/BH 15 digits; elsewhere 5-20 letters/digits. null/absent uses the organization's TRN.",
    example: "29ABCDE1234F1ZW",
  }),
  phone: optionalText("Phone", 30, "+973 1700 0001").openapi({ description: "Printed on receipts." }),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email({ message: "email must be a valid email address." })
    .max(254)
    .nullable()
    .optional()
    .openapi({ description: "Printed on receipts.", example: "seef@alnoor.bh" }),
  invoicePrefix: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.string().regex(/^[A-Z0-9]{1,5}$/, { message: "invoicePrefix must be 1-5 letters or digits." }))
    .optional()
    .openapi({
      description:
        "Starts this store's sale invoice and credit note numbers: {invoicePrefix}-{YY}-{000123} and {invoicePrefix}-{YY}-R{000045}, where YY is the fiscal year's start year (at most 16 characters, India's limit). Stored uppercase, unique within the organization, required before the store's first sale, and fixed once it has one.",
      example: "SEEF",
    }),
  receipt: z
    .object({
      headerText: optionalText("Receipt header text", 200, "Welcome to Al Noor"),
      footerText: optionalText("Receipt footer text", 500, "Exchange within 7 days with this receipt."),
    })
    .strict({ message: "Unknown receipt field. Only headerText and footerText can be set." })
    .optional()
    .openapi({ description: "Free text printed at the top and bottom of this store's receipts. null clears a field." }),
};

/**
 * Country-dependent store rules that need both countryCode and the fields in one body. "A store in
 * India needs a stateCode" depends on the stored store too, so the service checks it (Phase 4a-1
 * implementation; existing Indian stores are backfilled).
 */
function checkCountryRules(
  body: { countryCode?: string; taxRegistrationNumber?: string | null; address?: { stateCode?: string | null } },
  ctx: z.RefinementCtx
) {
  const country = body.countryCode;
  const stateCode = body.address?.stateCode;
  if (country && country !== "IN" && stateCode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["address", "stateCode"], message: "stateCode is only for stores in India." });
  }
  if (country && body.taxRegistrationNumber) {
    const problem = taxIdProblem(country, body.taxRegistrationNumber);
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["taxRegistrationNumber"], message: problem });
    } else if (country === "IN" && stateCode && body.taxRegistrationNumber.slice(0, 2) !== stateCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["taxRegistrationNumber"],
        message: `GSTIN must start with the store's stateCode (${stateCode}).`,
      });
    }
  }
}

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

export const createStoreSchema = z
  .object({
    name: nameField,
    code: codeField,
    address: z.object(addressShape),
    countryCode: countryCodeField,
    timezone: timezoneField,
    ...phase4aStoreFields,
  })
  .superRefine((body, ctx) => checkCountryRules(body, ctx));

export const updateStoreSchema = z
  .object({
    name: nameField.optional(),
    address: z.object(addressShape).partial().optional().openapi({
      description: "Any subset of address fields; omitted fields are left unchanged.",
    }),
    countryCode: countryCodeField.optional(),
    timezone: timezoneField.optional(),
    ...phase4aStoreFields,
  })
  .strict({
    message:
      "Unknown or immutable field. Only name, address, countryCode, timezone, legalName, legalNameAr, taxRegistrationNumber, phone, email, invoicePrefix and receipt can be updated.",
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  })
  // Rules that also depend on the stored store (its country, state code, GSTIN, sales) are checked by the service.
  .superRefine((body, ctx) => checkCountryRules(body, ctx));

export type CreateStoreInput = z.infer<typeof createStoreSchema>;
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;
