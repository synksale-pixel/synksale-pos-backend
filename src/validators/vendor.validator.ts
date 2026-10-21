/**
 * Purpose: Vendor Validators (Phase 3a, contract).
 * Vendors are the organization's suppliers, shared by every store. Purchase orders, receipts,
 * bills and returns (Phases 3b-3e) reference them. Bills are in the organization's currency in
 * v1, so a vendor has no currency of its own.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { taxRegistrationNumberField } from "./organization.validator";
import { isIsoCountryCode } from "../config/isoCountries.config";

const nameField = z
  .string()
  .trim()
  .min(1, { message: "Vendor name is required." })
  .max(120, { message: "Vendor name must be at most 120 characters long." })
  .openapi({
    description: "Display name, unique within your organization (case-insensitive). Shown in pickers and on documents.",
    example: "Gulf Roasters W.L.L.",
  });

const optionalText = (label: string, max: number, example: string) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} cannot be empty. Send null to clear it.` })
    .max(max, { message: `${label} must be at most ${max} characters long.` })
    .openapi({ example });

const COUNTRY_MESSAGE = "countryCode must be an ISO 3166-1 alpha-2 country code, e.g. BH (GB, not UK).";

const countryCodeField = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isIsoCountryCode, { message: COUNTRY_MESSAGE })
  .openapi({
    description:
      "ISO 3166-1 alpha-2 country the vendor is based in. Any country, not only the GCC. Defaults to your organization's own country (from its currency, e.g. BH for BHD).",
    example: "BH",
  });

export const VAT_TREATMENTS = ["vat_registered", "not_registered", "overseas"] as const;

const vatTreatmentField = z
  .enum(VAT_TREATMENTS, { message: `vatTreatment must be one of: ${VAT_TREATMENTS.join(", ")}.` })
  .openapi({
    description: [
      "How VAT applies to purchases from this vendor. Bills (Phase 3d) use it to decide whether input VAT can be charged, and each posted document keeps a copy.",
      "- `vat_registered`: a local vendor that charges VAT. Needs a `taxRegistrationNumber`.",
      "- `not_registered`: a local vendor that is not VAT-registered, so its bills carry no VAT.",
      "- `overseas`: a vendor outside your VAT jurisdiction (imports: reverse charge or VAT paid at customs).",
      "When omitted on create it is derived: a TRN gives `vat_registered`; otherwise a country other than yours gives `overseas`, and your own country gives `not_registered`. On update it never changes unless sent, so send it again if the TRN or country changes.",
    ].join("\n"),
    example: "vat_registered",
  });

const addressSchema = z
  .object({
    line1: optionalText("Address line 1", 200, "Building 1180, Road 3621").nullable().optional(),
    line2: optionalText("Address line 2", 200, "Block 436").nullable().optional(),
    city: optionalText("City", 100, "Manama").nullable().optional(),
    state: optionalText("State", 100, "Capital Governorate").nullable().optional(),
    postalCode: optionalText("Postal code", 20, "436").nullable().optional(),
  })
  .strict({ message: "Unknown address field. Only line1, line2, city, state and postalCode are accepted." })
  .openapi("VendorAddressInput", {
    description: "Every field is optional. On update, omitted fields are left unchanged and null clears one. The country is `countryCode`.",
  });

const vendorFields = {
  name: nameField,
  legalName: optionalText("Legal name", 200, "Gulf Roasters Trading W.L.L.").nullable().optional().openapi({
    description: "Registered name as printed on the vendor's tax invoices, when it differs from `name`.",
  }),
  taxRegistrationNumber: taxRegistrationNumberField.nullable().optional().openapi({
    description:
      "The vendor's VAT TRN, printed on their tax invoices. Spaces and hyphens are removed. null when the vendor is not VAT-registered. Not unique: branches of one company can share a TRN.",
    example: "220000987600003",
  }),
  countryCode: countryCodeField.optional(),
  vatTreatment: vatTreatmentField.optional(),
  contactName: optionalText("Contact name", 100, "Hassan Ali").nullable().optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email({ message: "Invalid vendor email format." })
    .max(254, { message: "Vendor email must be at most 254 characters long." })
    .nullable()
    .optional()
    .openapi({ example: "orders@gulfroasters.bh" }),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s\-()]{7,20}$/, { message: "Invalid vendor phone number format." })
    .nullable()
    .optional()
    .openapi({ example: "+973 1700 1234" }),
  address: addressSchema.nullable().optional(),
  paymentTermsDays: z
    .number({ invalid_type_error: "paymentTermsDays must be a number." })
    .int({ message: "paymentTermsDays must be a whole number of days." })
    .min(0, { message: "paymentTermsDays cannot be negative." })
    .max(365, { message: "paymentTermsDays must be at most 365." })
    .optional()
    .openapi({
      description: "Days after the bill date that payment is due (0 = due on receipt, 30 = net 30). Defaults to 0. New bills copy it as their default due date.",
      example: 30,
    }),
  notes: optionalText("Notes", 1000, "Delivers Sunday and Wednesday mornings.").nullable().optional(),
};

const FIELD_LIST =
  "name, legalName, taxRegistrationNumber, countryCode, vatTreatment, contactName, email, phone, address, paymentTermsDays, notes";

const TRN_REQUIRED_MESSAGE = "A vat_registered vendor needs a taxRegistrationNumber.";

export const createVendorSchema = z
  .object({
    ...vendorFields,
    isActive: z.boolean().optional().openapi({ description: "Defaults to true.", example: true }),
  })
  .strict({ message: `Unknown field. Only ${FIELD_LIST} and isActive are accepted.` })
  .superRefine((body, ctx) => {
    if (body.vatTreatment === "vat_registered" && !body.taxRegistrationNumber) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["taxRegistrationNumber"], message: TRN_REQUIRED_MESSAGE });
    }
  })
  .openapi("CreateVendorInput");

export const updateVendorSchema = z
  .object({
    ...vendorFields,
    name: nameField.optional(),
    isActive: z.boolean().optional().openapi({
      description:
        "false hides the vendor from pickers and blocks new purchase orders and receipts without a PO. Receipts against its open POs, bills, payments and returns are still allowed, so goods in transit and money owed can be settled. Products keep it as their preferred vendor.",
      example: false,
    }),
  })
  .strict({ message: `Unknown field. Only ${FIELD_LIST} and isActive can be updated.` })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  })
  .superRefine((body, ctx) => {
    // Only checkable here when both are sent; the service checks the stored TRN otherwise.
    if (body.vatTreatment === "vat_registered" && body.taxRegistrationNumber === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["taxRegistrationNumber"], message: TRN_REQUIRED_MESSAGE });
    }
  })
  .openapi("UpdateVendorInput");

export const listVendorsQuerySchema = z.object({
  search: z.string().optional().openapi({
    description: [
      "Matches any of:",
      "- name or legal name: case-insensitive prefix;",
      "- TRN: prefix, after removing spaces and hyphens from the term;",
      "- email: case-insensitive prefix;",
      "- phone: the term's digits anywhere in the phone's digits, when the term has at least 4 digits (so `17001234` finds `+973 1700 1234`).",
    ].join("\n"),
    example: "gulf",
  }),
  isActive: z.enum(["true", "false"]).optional().openapi({
    description: "Omit for all vendors; `true` for a picker.",
    example: "true",
  }),
  countryCode: countryCodeField.optional().openapi({ description: "Only vendors in this country (ISO 3166-1 alpha-2, case-insensitive).", example: "BH" }),
  vatTreatment: vatTreatmentField.optional().openapi({ description: "Only vendors with this VAT treatment.", example: "overseas" }),
  page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
  limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
});

export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
