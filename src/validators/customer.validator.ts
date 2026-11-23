/**
 * Purpose: Customer Validators (Phase 4a-2, contract).
 * Customers are organization-wide (any store can sell to them) and found at the till by phone.
 * A customer with a tax registration number gets a full tax invoice (decision 5); without one,
 * a simplified invoice. No loyalty points or wallet balance in v1 (frontend review decision E).
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { taxRegistrationNumberField } from "./organization.validator";
import { PHONE_LOOKUP_MIN_DIGITS } from "../utils/phone";

/** Most rows one import accepts. Larger lists are sent in several imports. */
export const CUSTOMER_IMPORT_MAX_ROWS = 1000;

const optionalText = (label: string, max: number, example: string) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} cannot be empty. Send null to clear it.` })
    .max(max, { message: `${label} must be at most ${max} characters long.` })
    .openapi({ example });

const nameField = z
  .string()
  .trim()
  .min(1, { message: "Customer name is required." })
  .max(120, { message: "Customer name must be at most 120 characters long." })
  .openapi({
    description: "The customer's name, or the business name for a B2B customer (printed on a full tax invoice). Not unique.",
    example: "Fatima Al Khalifa",
  });

const phoneField = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s\-()]{7,20}$/, {
    message: "Invalid phone number format. Use 7-20 digits, spaces, hyphens or parentheses, with an optional leading +.",
  })
  .openapi({
    description: [
      "Stored as entered, and matched by its normalised form: digits only, with your country's calling code and (AE, SA, IN) the trunk 0 removed. So `+973 3600 1234`, `0097336001234` and `36001234` are the same number. A number with another country's code is kept whole.",
      "**Unique within your organization** by that normalised form: a second customer with the same number is `409 CUSTOMER_PHONE_EXISTS`, and `errors[0].meta` names the existing customer (`customerId`, `name`, `isActive`) so the till can attach them instead.",
    ].join("\n\n"),
    example: "+973 3600 1234",
  });

const addressSchema = z
  .object({
    line1: optionalText("Address line 1", 200, "Flat 21, Building 450").nullable().optional(),
    line2: optionalText("Address line 2", 200, "Road 1705, Block 317").nullable().optional(),
    city: optionalText("City", 100, "Manama").nullable().optional(),
    state: optionalText("State", 100, "Capital Governorate").nullable().optional(),
    postalCode: optionalText("Postal code", 20, "317").nullable().optional(),
  })
  .strict({ message: "Unknown address field. Only line1, line2, city, state and postalCode are accepted." })
  .openapi("CustomerAddressInput", {
    description:
      "Every field is optional. On update, omitted fields are left unchanged and null clears one. Printed on a full tax invoice (B2B customers), so fill it in for customers with a tax number. The country is always your organization's.",
  });

const customerFields = {
  name: nameField,
  phone: phoneField,
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email({ message: "Invalid customer email format." })
    .max(254, { message: "Customer email must be at most 254 characters long." })
    .nullable()
    .optional()
    .openapi({ description: "Not unique.", example: "fatima@example.bh" }),
  address: addressSchema.nullable().optional(),
  taxRegistrationNumber: taxRegistrationNumberField.nullable().optional().openapi({
    description: [
      "The customer's VAT TRN (GCC) or GSTIN (India), for B2B sales: a customer with one gets a **full tax invoice** (decision 5). Spaces and hyphens are removed. Not unique (branches of one company share it).",
      "Checked for your organization's country, like a store's: 15 digits for BH/AE, a Saudi VAT number (15 digits, starting and ending with 3) for SA, a GSTIN with a valid check character for IN, 5-20 letters or digits elsewhere. A wrong one is `400 VALIDATION_FAILED` on this field.",
      "India: the customer's `stateCode` is read from the GSTIN's first two digits.",
    ].join("\n\n"),
    example: "220000555500003",
  }),
  notes: optionalText("Notes", 500, "Prefers WhatsApp receipts.").nullable().optional(),
};

const FIELD_LIST = "name, phone, email, address, taxRegistrationNumber, notes";

export const createCustomerSchema = z
  .object({
    ...customerFields,
    isActive: z.boolean().optional().openapi({ description: "Defaults to true.", example: true }),
  })
  .strict({ message: `Unknown field. Only ${FIELD_LIST} and isActive are accepted.` })
  .openapi("CreateCustomerInput");

export const updateCustomerSchema = z
  .object({
    ...customerFields,
    name: nameField.optional(),
    phone: phoneField.optional(),
    isActive: z.boolean().optional().openapi({
      description:
        "false hides the customer from the phone lookup and, from 4c, blocks attaching them to a new sale. Past sales and returns are unaffected.",
      example: false,
    }),
  })
  .strict({ message: `Unknown field. Only ${FIELD_LIST} and isActive can be updated.` })
  .refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." })
  .openapi("UpdateCustomerInput");

/**
 * The import body only checks its shape. Each row is checked on its own against
 * createCustomerSchema, so one bad row is reported in its result instead of failing the import.
 */
export const importCustomersSchema = z
  .object({
    rows: z
      .array(z.record(z.unknown()), { invalid_type_error: "rows must be an array of customer objects." })
      .min(1, { message: "rows must contain at least one customer." })
      .max(CUSTOMER_IMPORT_MAX_ROWS, {
        message: `An import accepts at most ${CUSTOMER_IMPORT_MAX_ROWS} rows. Split larger lists into several imports.`,
      })
      .openapi({
        description: `1-${CUSTOMER_IMPORT_MAX_ROWS} customers, each with the same fields as a create (\`isActive\` included). Rows are checked one by one: a bad row is reported in its result and the others are still imported.`,
        example: [
          { name: "Fatima Al Khalifa", phone: "+973 3600 1234", email: "fatima@example.bh" },
          { name: "Gulf Traders W.L.L.", phone: "17001234", taxRegistrationNumber: "220000555500003", address: { city: "Manama" } },
        ],
      }),
  })
  .strict({ message: "Unknown field. Only rows is accepted." })
  .openapi("ImportCustomersInput");

export const listCustomersQuerySchema = z.object({
  search: z.string().optional().openapi({
    description: [
      "Matches any of:",
      "- name: case-insensitive prefix of any word (`kha` finds `Fatima Al Khalifa`);",
      `- phone: the normalised number starts with the term's normalised digits, when it has at least ${PHONE_LOOKUP_MIN_DIGITS} digits;`,
      "- email: case-insensitive prefix;",
      "- tax registration number: prefix, after removing spaces and hyphens.",
    ].join("\n"),
    example: "fatima",
  }),
  isActive: z.enum(["true", "false"]).optional().openapi({ description: "Omit for all customers.", example: "true" }),
  hasTaxRegistrationNumber: z.enum(["true", "false"]).optional().openapi({
    description: "`true`: only B2B customers (with a tax number); `false`: only those without.",
    example: "true",
  }),
  page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
  limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
});

export const customerLookupQuerySchema = z.object({
  phone: z.string().openapi({
    description: `What the cashier has typed so far, in any form (\`+973 36\`, \`0097336001234\`, \`3600\`). Normalised like a stored phone. At least ${PHONE_LOOKUP_MIN_DIGITS} digits after normalising, otherwise \`400 VALIDATION_FAILED\` on \`phone\`.`,
    example: "3600",
  }),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
