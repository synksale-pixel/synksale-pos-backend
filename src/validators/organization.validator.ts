/**
 * Purpose: Organization Validators (tenant side).
 * Provides the Zod schema for updating the caller's organization profile and settings.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { CURRENCY_CODES, SALE_PAYMENT_METHODS } from "../config/currencies.config";
import { timezoneField } from "./store.validator";

export const currencyField = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.enum(CURRENCY_CODES, { message: `currency must be one of: ${CURRENCY_CODES.join(", ")}.` }))
  .openapi({ description: "ISO 4217 currency code.", example: "BHD" });

/** A VAT Tax Registration Number (TRN), normalised: spaces and hyphens removed, uppercased. */
export const taxRegistrationNumberField = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, "").toUpperCase())
  .pipe(
    z.string().regex(/^[A-Z0-9]{5,20}$/, {
      message: "Tax registration number must be 5-20 letters or digits.",
    })
  );

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
    legalNameAr: z
      .string()
      .trim()
      .min(1, { message: "Arabic legal name cannot be empty. Send null to clear it." })
      .max(200, { message: "Arabic legal name must be at most 200 characters long." })
      .nullable()
      .optional()
      .openapi({
        description: "Arabic legal name for Saudi receipts and the ZATCA QR code (stores may override it). null clears it.",
        example: "شركة النور للتجارة",
      }),
    taxRegistrationNumber: taxRegistrationNumberField
      .nullable()
      .optional()
      .openapi({
        description:
          "VAT Tax Registration Number (TRN) or GSTIN. Spaces and hyphens are removed and it is uppercased, then checked against the country of the organization's currency: IN a valid GSTIN (with check character); SA 15 digits starting and ending with 3; AE/BH 15 digits; elsewhere 5-20 letters/digits. null clears it.",
        example: "220000123400002",
      }),
    settings: z
      .object({
        currency: currencyField.optional(),
        timezone: timezoneField.optional(),
        fiscalYearStartMonth: z
          .number()
          .int({ message: "fiscalYearStartMonth must be a whole month number." })
          .min(1, { message: "fiscalYearStartMonth must be 1-12." })
          .max(12, { message: "fiscalYearStartMonth must be 1-12." })
          .optional()
          .openapi({
            description:
              "First month (1 = January) of the fiscal year; sale invoice and credit note numbers restart then. Defaults from the country: 4 (April) for India, 1 elsewhere. Fixed once any store has made a sale (409 FISCAL_YEAR_LOCKED).",
            example: 1,
          }),
        inventory: z
          .object({
            allowNegativeStock: z.boolean().optional().openapi({
              description: "Allow sales and adjustments to take stock below zero. Default false.",
              example: false,
            }),
          })
          .strict()
          .optional(),
        sales: z
          .object({
            pricesIncludeTax: z.boolean().optional().openapi({
              description:
                "Selling prices are entered VAT-inclusive (true, the default and the norm for GCC shelf prices) or VAT-exclusive. Cost prices are always VAT-exclusive.",
              example: true,
            }),
            paymentMethods: z
              .array(z.enum(SALE_PAYMENT_METHODS, { message: `payment methods must be from: ${SALE_PAYMENT_METHODS.join(", ")}.` }))
              .min(1)
              .refine((methods) => new Set(methods).size === methods.length, { message: "paymentMethods must not repeat a method." })
              .refine((methods) => methods.includes("cash"), { message: "cash cannot be disabled: refunds and cash rounding rely on it." })
              .optional()
              .openapi({
                description:
                  "Payment methods the till offers; the full list replaces the stored one. Values: cash, card, wallet (any digital wallet or instant payment: UPI in India, BenefitPay, STC Pay...), bank_transfer. cash is always required. New organizations get all four.",
                example: ["cash", "card", "bank_transfer"],
              }),
            cashRounding: z
              .string()
              .trim()
              .regex(/^\d+(\.\d+)?$/, { message: "cashRounding must be a decimal amount such as '0.25'." })
              .nullable()
              .optional()
              .openapi({
                description:
                  "Step the cash amount due is rounded to (nearest, halves up), as a decimal string in the organization's currency; null turns rounding off (the default). Applied to the cash tender only, never to invoice or VAT totals. Allowed steps: BHD/KWD/OMR 0.005, 0.010, 0.050, 0.100; AED 0.25; QAR 0.25, 0.50, 1.00; SAR 0.05, 0.10, 0.25, 0.50, 1.00; INR 0.50, 1.00. Any other value: 400 on field settings.sales.cashRounding.",
                example: "0.25",
              }),
            maxDiscountPercent: z
              .number()
              .min(0, { message: "maxDiscountPercent must be 0-100." })
              .max(100, { message: "maxDiscountPercent must be 0-100." })
              .refine((value) => Number.isInteger(value * 100), { message: "maxDiscountPercent allows at most 2 decimals." })
              .nullable()
              .optional()
              .openapi({
                description:
                  "Largest discount (percent of a line or of the cart) a cashier with sale:discount may give; null means no cap (the default). sale:price_override lifts the cap. Enforced from Phase 4c.",
                example: 10,
              }),
          })
          .strict()
          .optional(),
      })
      .strict({ message: "Unknown settings field. Only currency, timezone, fiscalYearStartMonth, inventory and sales can be updated." })
      .optional(),
  })
  .strict({ message: "Unknown field. Only legalName, legalNameAr, taxRegistrationNumber and settings can be updated." })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field (legalName, legalNameAr, taxRegistrationNumber, settings) must be provided.",
  });

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
