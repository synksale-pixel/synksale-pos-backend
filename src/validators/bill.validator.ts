/**
 * Purpose: Vendor Bill and Vendor Payment Validators (Phase 3d, contract).
 *
 * Contract rules (decisions approved 2026-11-13):
 * - A bill is the vendor's invoice: what the organization owes. Bills and payments are
 *   organization-level (`/bills`, `/vendor-payments`): one vendor invoice often covers deliveries
 *   to several stores. They never change stock.
 * - Posted on create: no drafts, no edits, no deletes. A mistake is fixed by voiding and entering
 *   the bill again. Numbered BILL-00001 / PAY-00001 per organization.
 * - Goods lines bill a goods receipt line (`goodsReceiptId` + `goodsReceiptLineId`); the variant,
 *   product and store come from the receipt. A receipt line can be billed across several bills,
 *   but never above what was received. Goods cannot be billed without a receipt.
 * - Service lines (`variantId` of a service product, e.g. a delivery charge) need no receipt.
 *   Free-text expenses are not in v1.
 * - A billed price different from the received cost is kept as a variance; stock is not revalued.
 * - VAT is per line (the receipt's rate by default, changeable to match the invoice), with one
 *   small bill-level `vatAdjustment` so the total matches the paper invoice.
 * - A payment pays one vendor and is split across one or more of its open bills; partial
 *   payments are fine, overpayment and advances are not (v1).
 * - Creating and voiding need an `Idempotency-Key` header; voids also send the `version` loaded.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { moneyField, objectIdField, positiveQuantityField } from "./product.validator";
import { isCalendarDate } from "./purchaseOrder.validator";

// ==========================================
// Shared vocabulary
// ==========================================

export const BILL_STATUSES = ["unpaid", "partially_paid", "paid", "void"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

/** Statuses a payment can still be allocated to. */
export const PAYABLE_BILL_STATUSES: readonly BillStatus[] = ["unpaid", "partially_paid"];

export const VENDOR_PAYMENT_STATUSES = ["posted", "void"] as const;
export type VendorPaymentStatus = (typeof VENDOR_PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ["cash", "bank_transfer", "cheque", "card", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** The bill-level VAT adjustment may move the total by at most this many of the currency's smallest units. */
export const MAX_VAT_ADJUSTMENT_MINOR = 5;

const MAX_BILL_LINES = 200;
const MAX_ALLOCATIONS = 100;

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} cannot be empty. Omit it instead.` })
    .max(max, { message: `${label} must be at most ${max} characters long.` });

const dateField = (label: string) =>
  z
    .string()
    .trim()
    .refine(isCalendarDate, { message: `${label} must be a calendar date in the form YYYY-MM-DD.` });

/** Signed decimal string with at most 3 decimals; the currency's own limit is checked later. */
const signedMoneyField = (description: string, example: string) =>
  z
    .string({ invalid_type_error: 'Amounts are sent as decimal strings, e.g. "-0.002".' })
    .trim()
    .regex(/^-?\d{1,13}(\.\d{1,3})?$/, {
      message: 'Must be a decimal string such as "0.002" or "-0.002" (at most 3 decimal places).',
    })
    .openapi({ description, example });

/** Exact thousandths of a decimal string, so sums are compared without floating point. */
export function toThousandths(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const milli = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
  return negative ? -milli : milli;
}

const isPositiveAmount = (value: string) => toThousandths(value) > 0n;

const versionField = (document: string, conflictCode: string) =>
  z
    .number({ required_error: "version is required.", invalid_type_error: "version must be a number." })
    .int({ message: "version must be a whole number." })
    .min(1, { message: "version must be at least 1." })
    .openapi({
      description: `The \`version\` of the ${document} you loaded. If it changed since, the request is refused with 409 \`${conflictCode}\`: reload and try again.`,
      example: 1,
    });

const reasonField = (document: string) =>
  z
    .string({ required_error: "reason is required." })
    .trim()
    .min(1, { message: "reason cannot be empty." })
    .max(500, { message: "reason must be at most 500 characters long." })
    .openapi({ description: `Why the ${document} is voided; kept on it.`, example: "Entered against the wrong vendor." });

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const value of values.map((v) => v.toLowerCase())) {
    if (seen.has(value)) dup.add(value);
    seen.add(value);
  }
  return [...dup];
}

// ==========================================
// Bill lines
// ==========================================

export const billLineSchema = z
  .object({
    goodsReceiptId: objectIdField("goodsReceiptId", "665f1c2e8a4b3c0012ab3d00")
      .optional()
      .openapi({ description: "Goods lines: the receipt that brought the goods in. Not sent on a service line." }),
    goodsReceiptLineId: objectIdField("goodsReceiptLineId", "665f1c2e8a4b3c0012ab3d01")
      .optional()
      .openapi({ description: "Goods lines: the receipt line billed (`lines[].id` on the receipt). Sent with `goodsReceiptId`." }),
    variantId: objectIdField("variantId", "665f1c2e8a4b3c0012ab3880")
      .optional()
      .openapi({ description: "Service lines: a variant of a **service** product (e.g. a delivery charge). Not sent on a goods line (the receipt line has it)." }),
    quantity: positiveQuantityField(
      "Quantity billed, in the product's unit. Goods lines: optional, defaults to what is still unbilled on the receipt line. Service lines: required.",
      24
    ).optional(),
    unitCost: moneyField(
      "VAT-exclusive price per unit as on the vendor's invoice. Goods lines: optional, defaults to the receipt line's `unitCost`. Service lines: required.",
      "1.650"
    ).optional(),
    taxRateId: objectIdField("taxRateId", "665f1c2e8a4b3c0012ab3600")
      .nullable()
      .optional()
      .openapi({
        description:
          "The VAT rate on the invoice for this line. Omit for the default (the receipt line's PO rate, else the product's, else the organization's default). `null`: no VAT on this line. VAT is only charged for a `vat_registered` vendor and a `standard` product.",
      }),
    note: optionalText("Line note", 200).optional().openapi({ example: "Price increase from 1 Nov" }),
  })
  .strict({
    message: "Unknown bill line field. Use goodsReceiptId, goodsReceiptLineId, variantId, quantity, unitCost, taxRateId and note.",
  })
  .openapi("BillLineInput");

// ==========================================
// Create bill
// ==========================================

const BILL_FIELDS = "vendorId, vendorInvoiceNumber, billDate, dueDate, vatAdjustment, notes and lines";

export const createBillSchema = z
  .object({
    vendorId: objectIdField("vendorId", "665f1c2e8a4b3c0012ab3900").openapi({
      description: "The vendor who issued the invoice. Every receipt on the bill must be from this vendor. A deactivated vendor can still be billed.",
    }),
    vendorInvoiceNumber: z
      .string({ required_error: "vendorInvoiceNumber is required." })
      .trim()
      .min(1, { message: "vendorInvoiceNumber cannot be empty." })
      .max(50, { message: "vendorInvoiceNumber must be at most 50 characters long." })
      .openapi({
        description: "The number printed on the vendor's invoice. Unique per vendor among bills that are not void (case-insensitive).",
        example: "INV-2026-4471",
      }),
    billDate: dateField("billDate").optional().openapi({
      description:
        "The invoice date. Defaults to today in the organization's timezone; cannot be in the future, or before the latest `receivedDate` of the receipts billed.",
      example: "2026-11-13",
    }),
    dueDate: dateField("dueDate").optional().openapi({
      description: "When payment is due. Defaults to `billDate` + the vendor's `paymentTermsDays`; cannot be before `billDate`.",
      example: "2026-12-13",
    }),
    vatAdjustment: signedMoneyField(
      `Optional rounding correction added to the bill's VAT, so the total matches the invoice when the vendor rounded VAT on the total. At most ${MAX_VAT_ADJUSTMENT_MINOR} of the currency's smallest unit either way (0.005 BHD, 0.05 AED).`,
      "-0.002"
    ).optional(),
    notes: optionalText("notes", 1000).optional().openapi({ example: "October statement, two deliveries." }),
    lines: z
      .array(billLineSchema)
      .min(1, { message: "A bill needs at least one line." })
      .max(MAX_BILL_LINES, { message: `At most ${MAX_BILL_LINES} lines per bill.` }),
  })
  .strict({ message: `Unknown bill field. Only ${BILL_FIELDS} are accepted.` })
  .superRefine((body, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (body.billDate !== undefined && body.dueDate !== undefined && body.dueDate < body.billDate) {
      issue(["dueDate"], "dueDate cannot be before billDate.");
    }

    (body.lines ?? []).forEach((line, i) => {
      const goods = line.goodsReceiptId !== undefined || line.goodsReceiptLineId !== undefined;
      if (goods) {
        if (line.goodsReceiptId === undefined) {
          issue(["lines", i, "goodsReceiptId"], "goodsReceiptLineId needs goodsReceiptId.");
        }
        if (line.goodsReceiptLineId === undefined) {
          issue(["lines", i, "goodsReceiptLineId"], "goodsReceiptId needs goodsReceiptLineId.");
        }
        if (line.variantId !== undefined) {
          issue(["lines", i, "variantId"], "Do not send variantId on a goods line; the receipt line has it.");
        }
      } else if (line.variantId === undefined) {
        issue(
          ["lines", i],
          "Each line needs goodsReceiptId and goodsReceiptLineId (goods), or variantId of a service product (services)."
        );
      } else {
        if (line.quantity === undefined) issue(["lines", i, "quantity"], "Each service line needs quantity.");
        if (line.unitCost === undefined) issue(["lines", i, "unitCost"], "Each service line needs unitCost.");
      }
    });

    const lines = body.lines ?? [];
    for (const id of duplicateValues(lines.flatMap((line) => line.goodsReceiptLineId ?? []))) {
      issue(["lines"], `Goods receipt line '${id}' is listed more than once.`);
    }
    for (const id of duplicateValues(lines.flatMap((line) => line.variantId ?? []))) {
      issue(["lines"], `Service variant '${id}' is listed more than once.`);
    }
  })
  .openapi("CreateBillInput");

export const voidBillSchema = z
  .object({ version: versionField("bill", "BILL_VERSION_CONFLICT"), reason: reasonField("bill") })
  .strict({ message: "Unknown field. Only version and reason are accepted." })
  .openapi("VoidBillInput");

// ==========================================
// Vendor payments
// ==========================================

export const paymentAllocationSchema = z
  .object({
    billId: objectIdField("billId", "665f1c2e8a4b3c0012ab3e00").openapi({
      description: "An `unpaid` or `partially_paid` bill of the payment's vendor.",
    }),
    amount: moneyField("How much of the payment goes to this bill. Greater than zero, at most the bill's `balanceDue`.", "150.000").refine(
      isPositiveAmount,
      { message: "amount must be greater than zero." }
    ),
  })
  .strict({ message: "Unknown allocation field. Use billId and amount." })
  .openapi("VendorPaymentAllocationInput");

const PAYMENT_FIELDS = "vendorId, paymentDate, amount, method, reference, notes and allocations";

export const createVendorPaymentSchema = z
  .object({
    vendorId: objectIdField("vendorId", "665f1c2e8a4b3c0012ab3900").openapi({
      description: "The vendor paid. A deactivated vendor can still be paid.",
    }),
    paymentDate: dateField("paymentDate").optional().openapi({
      description:
        "When the money was paid. Defaults to today in the organization's timezone; cannot be in the future, or before the `billDate` of a bill it pays.",
      example: "2026-11-20",
    }),
    amount: moneyField("Total paid, in the organization's currency. Must equal the sum of `allocations[].amount`.", "250.000").refine(
      isPositiveAmount,
      { message: "amount must be greater than zero." }
    ),
    method: z
      .enum(PAYMENT_METHODS, {
        errorMap: () => ({ message: `method must be one of: ${PAYMENT_METHODS.join(", ")}.` }),
      })
      .openapi({ description: "How it was paid. Read it as an open-ended string: later phases may add values.", example: "bank_transfer" }),
    reference: optionalText("reference", 50)
      .optional()
      .openapi({ description: "Cheque number, transfer reference or similar.", example: "FT26318XK2" }),
    notes: optionalText("notes", 1000).optional().openapi({ example: "Settles October statement." }),
    allocations: z
      .array(paymentAllocationSchema)
      .min(1, { message: "A payment must pay at least one bill." })
      .max(MAX_ALLOCATIONS, { message: `At most ${MAX_ALLOCATIONS} bills per payment.` }),
  })
  .strict({ message: `Unknown payment field. Only ${PAYMENT_FIELDS} are accepted.` })
  .superRefine((body, ctx) => {
    const allocations = body.allocations ?? [];
    for (const id of duplicateValues(allocations.map((a) => a.billId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["allocations"], message: `Bill '${id}' is listed more than once.` });
    }
    if (body.amount === undefined || allocations.some((a) => a.amount === undefined)) return;
    const sum = allocations.reduce((total, a) => total + toThousandths(a.amount), 0n);
    if (sum !== toThousandths(body.amount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "amount must equal the sum of allocations[].amount (advances and overpayments are not supported).",
      });
    }
  })
  .openapi("CreateVendorPaymentInput");

export const voidVendorPaymentSchema = z
  .object({ version: versionField("payment", "VENDOR_PAYMENT_VERSION_CONFLICT"), reason: reasonField("payment") })
  .strict({ message: "Unknown field. Only version and reason are accepted." })
  .openapi("VoidVendorPaymentInput");

// ==========================================
// Query strings (documented; parsed leniently by the controller)
// ==========================================

export const listBillsQuerySchema = z.object({
  search: z.string().optional().openapi({
    description:
      "Case-insensitive prefix match on the bill number, with or without `BILL-` (`BILL-0001` and `0001` both find BILL-00010 to BILL-00019), or on `vendorInvoiceNumber`.",
    example: "BILL-0001",
  }),
  vendorId: z.string().optional().openapi({ description: "Only this vendor's bills.", example: "665f1c2e8a4b3c0012ab3900" }),
  status: z.string().optional().openapi({
    description: `One status or several separated by commas (\`unpaid,partially_paid\` for bills still owed). Values: ${BILL_STATUSES.map((s) => `\`${s}\``).join(", ")}. Unrecognised values are ignored.`,
    example: "unpaid,partially_paid",
  }),
  overdue: z.string().optional().openapi({
    description: "`true`: only unpaid or partly paid bills whose `dueDate` is before today (organization timezone). Any other value is ignored.",
    example: "true",
  }),
  goodsReceiptId: z.string().optional().openapi({
    description: "Only bills with a line from this receipt (a receipt's billing history).",
    example: "665f1c2e8a4b3c0012ab3d00",
  }),
  from: z.string().optional().openapi({ description: "Earliest `billDate` (YYYY-MM-DD), inclusive.", example: "2026-11-01" }),
  to: z.string().optional().openapi({ description: "Latest `billDate` (YYYY-MM-DD), inclusive.", example: "2026-11-30" }),
  dueFrom: z.string().optional().openapi({ description: "Earliest `dueDate` (YYYY-MM-DD), inclusive.", example: "2026-12-01" }),
  dueTo: z.string().optional().openapi({ description: "Latest `dueDate` (YYYY-MM-DD), inclusive.", example: "2026-12-31" }),
  page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
  limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
});

export const listVendorPaymentsQuerySchema = z.object({
  search: z.string().optional().openapi({
    description: "Case-insensitive prefix match on the payment number, with or without `PAY-`, or on `reference`.",
    example: "PAY-0001",
  }),
  vendorId: z.string().optional().openapi({ description: "Only this vendor's payments.", example: "665f1c2e8a4b3c0012ab3900" }),
  billId: z.string().optional().openapi({ description: "Only payments allocated to this bill.", example: "665f1c2e8a4b3c0012ab3e00" }),
  status: z.string().optional().openapi({
    description: `\`posted\` or \`void\`; comma-separated for both. Unrecognised values are ignored.`,
    example: "posted",
  }),
  method: z.string().optional().openapi({
    description: `One method or several separated by commas. Values: ${PAYMENT_METHODS.map((m) => `\`${m}\``).join(", ")}.`,
    example: "cash",
  }),
  from: z.string().optional().openapi({ description: "Earliest `paymentDate` (YYYY-MM-DD), inclusive.", example: "2026-11-01" }),
  to: z.string().optional().openapi({ description: "Latest `paymentDate` (YYYY-MM-DD), inclusive.", example: "2026-11-30" }),
  page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
  limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
});

export type CreateBillInput = z.infer<typeof createBillSchema>;
export type VoidBillInput = z.infer<typeof voidBillSchema>;
export type CreateVendorPaymentInput = z.infer<typeof createVendorPaymentSchema>;
export type VoidVendorPaymentInput = z.infer<typeof voidVendorPaymentSchema>;
