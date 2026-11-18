/**
 * Purpose: Vendor Return and Debit Note Validators (Phase 3e, contract).
 *
 * Contract rules (decisions approved 2026-11-17):
 * - Two documents. A **vendor return** sends goods back from one store: it removes stock and is
 *   store-scoped (`/stores/{storeId}/vendor-returns`, RTN-00001). A **debit note** reduces what the
 *   organization owes a vendor: it is organization-level (`/debit-notes`, DN-00001) and always
 *   against one bill (the invoice it corrects).
 * - Every return line names a goods receipt line (the cost, vendor and ceiling come from it).
 *   Posted on create and final: no drafts, edits or void, like receipts.
 * - A return takes from the receipt line's **unbilled** quantity first. Only the rest (goods that
 *   were already billed) is credited, and the request names the bill line to credit
 *   (`billId` + `billLineId`). Returning billed goods creates the debit note in the same step,
 *   one per bill.
 * - A debit note on its own (no return) corrects a price: VAT-exclusive `amount` per bill line,
 *   VAT reversed at the bill line's rate. It can be voided; one created by a return cannot.
 * - Credit first reduces its own bill's balance. Anything left (the bill was already paid) stays
 *   on the note as unapplied vendor credit, applied later to the vendor's other open bills.
 *   Vendor cash refunds are not in 3e (3e.2).
 * - Creating, applying and voiding need an `Idempotency-Key` header; apply and void also send the
 *   `version` loaded.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { moneyField, objectIdField, positiveQuantityField } from "./product.validator";
import {
  dateField,
  duplicateValues,
  isPositiveAmount,
  optionalText,
  reasonField,
  versionField,
} from "./bill.validator";

// ==========================================
// Shared vocabulary
// ==========================================

/** Why goods go back to the vendor (fixed list, like stock adjustment reasons). */
export const RETURN_REASONS = ["damaged", "expired", "wrong_item", "excess", "other"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/** `return`: created by a vendor return of billed goods. `price_adjustment`: recorded on its own. */
export const DEBIT_NOTE_TYPES = ["return", "price_adjustment"] as const;
export type DebitNoteType = (typeof DEBIT_NOTE_TYPES)[number];

/** `open`: some credit not yet applied. `applied`: all of it used. `void`: cancelled. */
export const DEBIT_NOTE_STATUSES = ["open", "applied", "void"] as const;
export type DebitNoteStatus = (typeof DEBIT_NOTE_STATUSES)[number];

const MAX_RETURN_LINES = 200;
const MAX_DEBIT_NOTE_LINES = 200;
const MAX_APPLICATIONS = 100;

const vendorReferenceField = (description: string, example: string) =>
  optionalText("vendorReference", 50).optional().openapi({ description, example });

// ==========================================
// Vendor returns
// ==========================================

export const vendorReturnLineSchema = z
  .object({
    goodsReceiptId: objectIdField("goodsReceiptId", "665f1c2e8a4b3c0012ab3d00").openapi({
      description: "The receipt that brought the goods in. It must be from this store and the return's vendor.",
    }),
    goodsReceiptLineId: objectIdField("goodsReceiptLineId", "665f1c2e8a4b3c0012ab3d01").openapi({
      description: "The receipt line returned (`lines[].id` on the receipt).",
    }),
    quantity: positiveQuantityField(
      "Quantity sent back, in the product's unit. Taken from the line's unbilled quantity first; any rest must have been billed and is credited on `billLineId`.",
      2
    ),
    billId: objectIdField("billId", "665f1c2e8a4b3c0012ab3e00")
      .optional()
      .openapi({
        description:
          "The bill to credit for the part of `quantity` that was already billed. Sent with `billLineId`. Needed only when `quantity` is more than what is still unbilled on the receipt line; when sent anyway it is still checked (it must be this store's bill and bill this receipt line).",
      }),
    billLineId: objectIdField("billLineId", "665f1c2e8a4b3c0012ab3e01")
      .optional()
      .openapi({ description: "The bill line (`lines[].id` on the bill) that billed this receipt line. Sent with `billId`." }),
    note: optionalText("Line note", 200).optional().openapi({ example: "Seal broken on 2 bags" }),
  })
  .strict({
    message: "Unknown return line field. Use goodsReceiptId, goodsReceiptLineId, quantity, billId, billLineId and note.",
  })
  .superRefine((line, ctx) => {
    if ((line.billId === undefined) !== (line.billLineId === undefined)) {
      const missing = line.billId === undefined ? "billId" : "billLineId";
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [missing], message: "billId and billLineId are sent together." });
    }
  })
  .openapi("VendorReturnLineInput");

const RETURN_FIELDS = "vendorId, returnDate, reason, vendorReference, notes and lines";

export const createVendorReturnSchema = z
  .object({
    vendorId: objectIdField("vendorId", "665f1c2e8a4b3c0012ab3900").openapi({
      description: "The vendor the goods go back to. Every receipt on the return must be from this vendor. A deactivated vendor is fine.",
    }),
    returnDate: dateField("returnDate").optional().openapi({
      description:
        "When the goods left. Defaults to today in the store's timezone; cannot be in the future, before the latest `receivedDate` of the receipts, or before the `billDate` of a bill credited.",
      example: "2026-11-18",
    }),
    reason: z
      .enum(RETURN_REASONS, {
        errorMap: () => ({ message: `reason must be one of: ${RETURN_REASONS.join(", ")}.` }),
      })
      .openapi({
        description: "Why the goods go back. Goods returned for different reasons go on separate returns. Read it as an open-ended string.",
        example: "damaged",
      }),
    vendorReference: vendorReferenceField("The vendor's return authorization (RMA) number, if they gave one.", "RMA-2026-118"),
    notes: optionalText("notes", 1000).optional().openapi({ example: "Collected by the vendor's driver." }),
    lines: z
      .array(vendorReturnLineSchema)
      .min(1, { message: "A return needs at least one line." })
      .max(MAX_RETURN_LINES, { message: `At most ${MAX_RETURN_LINES} lines per return.` }),
  })
  .strict({ message: `Unknown return field. Only ${RETURN_FIELDS} are accepted.` })
  .superRefine((body, ctx) => {
    for (const id of duplicateValues((body.lines ?? []).map((line) => line.goodsReceiptLineId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: `Goods receipt line '${id}' is listed more than once.` });
    }
  })
  .openapi("CreateVendorReturnInput");

// ==========================================
// Debit notes
// ==========================================

export const debitNoteLineSchema = z
  .object({
    billLineId: objectIdField("billLineId", "665f1c2e8a4b3c0012ab3e01").openapi({
      description: "The bill line whose price is corrected (`lines[].id` on the bill). Goods or service lines.",
    }),
    amount: moneyField(
      "VAT-exclusive amount credited on this line (e.g. 24 units × 0.050 over-charged = 1.200). Greater than zero; with earlier credits, at most the line's `subtotal`. VAT is added at the bill line's rate.",
      "1.200"
    ).refine(isPositiveAmount, { message: "amount must be greater than zero." }),
    note: optionalText("Line note", 200).optional().openapi({ example: "Billed 1.650, agreed 1.600" }),
  })
  .strict({ message: "Unknown debit note line field. Use billLineId, amount and note." })
  .openapi("DebitNoteLineInput");

const DEBIT_NOTE_FIELDS = "billId, debitNoteDate, vendorReference, reason, notes and lines";

export const createDebitNoteSchema = z
  .object({
    billId: objectIdField("billId", "665f1c2e8a4b3c0012ab3e00").openapi({
      description: "The bill (vendor invoice) corrected. The vendor comes from it. It must not be void.",
    }),
    debitNoteDate: dateField("debitNoteDate").optional().openapi({
      description: "Defaults to today in the organization's timezone; cannot be in the future or before the bill's `billDate`.",
      example: "2026-11-18",
    }),
    vendorReference: vendorReferenceField("The number of the vendor's credit note, if they issued one.", "CN-2026-031"),
    reason: z
      .string({ required_error: "reason is required." })
      .trim()
      .min(1, { message: "reason cannot be empty." })
      .max(500, { message: "reason must be at most 500 characters long." })
      .openapi({ description: "Why the price is corrected; printed on the debit note.", example: "Billed above the agreed price." }),
    notes: optionalText("notes", 1000).optional().openapi({ example: "Agreed by phone with the vendor's sales rep." }),
    lines: z
      .array(debitNoteLineSchema)
      .min(1, { message: "A debit note needs at least one line." })
      .max(MAX_DEBIT_NOTE_LINES, { message: `At most ${MAX_DEBIT_NOTE_LINES} lines per debit note.` }),
  })
  .strict({ message: `Unknown debit note field. Only ${DEBIT_NOTE_FIELDS} are accepted.` })
  .superRefine((body, ctx) => {
    for (const id of duplicateValues((body.lines ?? []).map((line) => line.billLineId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: `Bill line '${id}' is listed more than once.` });
    }
  })
  .openapi("CreateDebitNoteInput");

export const debitNoteApplicationSchema = z
  .object({
    billId: objectIdField("billId", "665f1c2e8a4b3c0012ab3e10").openapi({
      description: "An `unpaid` or `partially_paid` bill of the debit note's vendor.",
    }),
    amount: moneyField("Credit applied to this bill. Greater than zero, at most the bill's `balanceDue`.", "4.356").refine(isPositiveAmount, {
      message: "amount must be greater than zero.",
    }),
  })
  .strict({ message: "Unknown application field. Use billId and amount." })
  .openapi("DebitNoteApplicationInput");

export const applyDebitNoteSchema = z
  .object({
    version: versionField("debit note", "DEBIT_NOTE_VERSION_CONFLICT"),
    applications: z
      .array(debitNoteApplicationSchema)
      .min(1, { message: "Apply the credit to at least one bill." })
      .max(MAX_APPLICATIONS, { message: `At most ${MAX_APPLICATIONS} bills at once.` }),
  })
  .strict({ message: "Unknown field. Only version and applications are accepted." })
  .superRefine((body, ctx) => {
    for (const id of duplicateValues((body.applications ?? []).map((a) => a.billId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["applications"], message: `Bill '${id}' is listed more than once.` });
    }
  })
  .openapi("ApplyDebitNoteInput");

export const voidDebitNoteSchema = z
  .object({ version: versionField("debit note", "DEBIT_NOTE_VERSION_CONFLICT"), reason: reasonField("debit note") })
  .strict({ message: "Unknown field. Only version and reason are accepted." })
  .openapi("VoidDebitNoteInput");

// ==========================================
// Query strings (documented; parsed leniently by the controller)
// ==========================================

export const listVendorReturnsQuerySchema = z.object({
  search: z.string().optional().openapi({
    description:
      "Case-insensitive prefix match on the return number, with or without `RTN-` (`RTN-0001` and `0001` both find RTN-00010 to RTN-00019), or on `vendorReference`.",
    example: "RTN-0001",
  }),
  storeId: z.string().optional().openapi({ description: "Cross-store list only: just this store's returns.", example: "665f1c2e8a4b3c0012ab3400" }),
  vendorId: z.string().optional().openapi({ description: "Only this vendor's returns.", example: "665f1c2e8a4b3c0012ab3900" }),
  goodsReceiptId: z.string().optional().openapi({
    description: "Only returns with a line from this receipt (a receipt's return history).",
    example: "665f1c2e8a4b3c0012ab3d00",
  }),
  reason: z.string().optional().openapi({
    description: `One reason or several separated by commas. Values: ${RETURN_REASONS.map((r) => `\`${r}\``).join(", ")}. Unrecognised values are ignored.`,
    example: "damaged,expired",
  }),
  from: z.string().optional().openapi({ description: "Earliest `returnDate` (YYYY-MM-DD), inclusive.", example: "2026-11-01" }),
  to: z.string().optional().openapi({ description: "Latest `returnDate` (YYYY-MM-DD), inclusive.", example: "2026-11-30" }),
  page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
  limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
});

export const listDebitNotesQuerySchema = z.object({
  search: z.string().optional().openapi({
    description: "Case-insensitive prefix match on the debit note number, with or without `DN-`, or on `vendorReference`.",
    example: "DN-0001",
  }),
  vendorId: z.string().optional().openapi({
    description: "Only this vendor's notes. With `status=open`: the vendor's credit still to apply.",
    example: "665f1c2e8a4b3c0012ab3900",
  }),
  billId: z.string().optional().openapi({
    description: "Notes against this bill, or with credit applied to it.",
    example: "665f1c2e8a4b3c0012ab3e00",
  }),
  vendorReturnId: z.string().optional().openapi({ description: "Notes created by this return.", example: "665f1c2e8a4b3c0012ab4000" }),
  type: z.string().optional().openapi({
    description: `\`return\` or \`price_adjustment\`; comma-separated for both. Unrecognised values are ignored.`,
    example: "price_adjustment",
  }),
  status: z.string().optional().openapi({
    description: `One status or several separated by commas. Values: ${DEBIT_NOTE_STATUSES.map((s) => `\`${s}\``).join(", ")}. Unrecognised values are ignored.`,
    example: "open",
  }),
  from: z.string().optional().openapi({ description: "Earliest `debitNoteDate` (YYYY-MM-DD), inclusive.", example: "2026-11-01" }),
  to: z.string().optional().openapi({ description: "Latest `debitNoteDate` (YYYY-MM-DD), inclusive.", example: "2026-11-30" }),
  page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
  limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
});

export type CreateVendorReturnInput = z.infer<typeof createVendorReturnSchema>;
export type CreateDebitNoteInput = z.infer<typeof createDebitNoteSchema>;
export type ApplyDebitNoteInput = z.infer<typeof applyDebitNoteSchema>;
export type VoidDebitNoteInput = z.infer<typeof voidDebitNoteSchema>;
