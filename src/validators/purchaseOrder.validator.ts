/**
 * Purpose: Purchase Order Validators (Phase 3b, contract).
 *
 * Contract rules:
 * - A purchase order (PO) is what a store plans to buy from one vendor. It never changes stock:
 *   goods receipts (Phase 3c) do.
 * - Lifecycle: `draft` → `issued` → `partially_received` → `received`, plus `cancelled` (issued,
 *   nothing received) and `closed` (partly received, the rest will not come). Drafts can be
 *   deleted; nothing else can.
 * - The PO number (PO-00001) is given when the draft is created, so deleted drafts leave gaps.
 * - Drafts and issued POs are editable until the first receipt; after that the PO is locked.
 * - Lines are goods only (services go straight onto bills in 3d), with VAT-exclusive unit costs
 *   and no discounts in v1. VAT is shown as an estimate: the vendor's bill has the final figure.
 * - A PO belongs to one store, which comes from the URL (`/stores/:storeId/purchase-orders`) so
 *   scopeToStore verifies it before the store-level permission is checked.
 * - Creating a PO needs an `Idempotency-Key` header. Every change to an existing PO sends the
 *   `version` it was based on, so two people editing at once cannot overwrite each other.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { moneyField, objectIdField, positiveQuantityField } from "./product.validator";

// ==========================================
// Shared vocabulary
// ==========================================

export const PURCHASE_ORDER_STATUSES = [
  "draft",
  "issued",
  "partially_received",
  "received",
  "cancelled",
  "closed",
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

/** Statuses that still expect goods. A product or variant on one of these cannot be deleted. */
export const OPEN_PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] = ["draft", "issued", "partially_received"];

const MAX_LINES = 200;

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} cannot be empty. Send null to clear it.` })
    .max(max, { message: `${label} must be at most ${max} characters long.` });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date (`YYYY-MM-DD`), with no time or timezone. */
const isCalendarDate = (value: string) => {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

const dateField = (label: string) =>
  z
    .string()
    .trim()
    .refine(isCalendarDate, { message: `${label} must be a calendar date in the form YYYY-MM-DD.` });

const versionField = z
  .number({ required_error: "version is required.", invalid_type_error: "version must be a number." })
  .int({ message: "version must be a whole number." })
  .min(1, { message: "version must be at least 1." })
  .openapi({
    description:
      "The `version` of the purchase order you loaded. If someone changed it since, the request is refused with 409 `PURCHASE_ORDER_VERSION_CONFLICT`: reload and try again.",
    example: 3,
  });

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
// Lines
// ==========================================

export const purchaseOrderLineSchema = z
  .object({
    variantId: objectIdField("variantId", "665f1c2e8a4b3c0012ab3801"),
    quantity: positiveQuantityField("Quantity ordered, in the product's unit.", 24),
    unitCost: moneyField(
      "VAT-exclusive cost per unit agreed with the vendor. Defaults to the variant's cost price; when the variant has none, it must be sent (`UNIT_COST_REQUIRED`).",
      "1.600"
    ).optional(),
    note: optionalText("Line note", 200)
      .optional()
      .openapi({ description: "Printed under the line, e.g. a vendor item code or pack size.", example: "Vendor code GR-250" }),
  })
  .strict({ message: "Unknown purchase order line field. Use variantId, quantity, unitCost and note." })
  .openapi("PurchaseOrderLineInput");

const linesField = z
  .array(purchaseOrderLineSchema)
  .min(1, { message: "A purchase order needs at least one line." })
  .max(MAX_LINES, { message: `At most ${MAX_LINES} lines per purchase order.` });

const poFields = {
  vendorId: objectIdField("vendorId", "665f1c2e8a4b3c0012ab3900").openapi({
    description: "An active vendor of your organization.",
  }),
  orderDate: dateField("orderDate").openapi({
    description: "The date on the PO. Defaults to today in the store's timezone.",
    example: "2026-10-27",
  }),
  expectedDate: dateField("expectedDate")
    .nullable()
    .openapi({ description: "When the goods are expected. On or after `orderDate`.", example: "2026-11-03" }),
  vendorReference: optionalText("vendorReference", 50)
    .nullable()
    .openapi({ description: "The vendor's quotation or order number, for matching their documents.", example: "Q-2026-118" }),
  notes: optionalText("notes", 1000)
    .nullable()
    .openapi({ description: "Printed on the PO for the vendor (delivery instructions, terms).", example: "Deliver to the back entrance before 10am." }),
  lines: linesField,
};

const FIELD_LIST = "vendorId, orderDate, expectedDate, vendorReference, notes and lines";

const DATE_ORDER_MESSAGE = "expectedDate cannot be before orderDate.";

function checkLines(lines: { variantId: string }[] | undefined, ctx: z.RefinementCtx) {
  for (const variantId of duplicateValues((lines ?? []).map((line) => line.variantId))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: `Variant '${variantId}' is listed more than once.` });
  }
}

// ==========================================
// Create / update
// ==========================================

export const createPurchaseOrderSchema = z
  .object({
    vendorId: poFields.vendorId,
    orderDate: poFields.orderDate.optional(),
    expectedDate: poFields.expectedDate.optional(),
    vendorReference: poFields.vendorReference.optional(),
    notes: poFields.notes.optional(),
    lines: poFields.lines,
  })
  .strict({ message: `Unknown purchase order field. Only ${FIELD_LIST} are accepted; the store comes from the URL.` })
  .superRefine((body, ctx) => {
    // Without an orderDate the service compares against today in the store's timezone.
    if (body.orderDate && body.expectedDate && body.expectedDate < body.orderDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedDate"], message: DATE_ORDER_MESSAGE });
    }
    checkLines(body.lines, ctx);
  })
  .openapi("CreatePurchaseOrderInput");

export const updatePurchaseOrderSchema = z
  .object({
    version: versionField,
    vendorId: poFields.vendorId.optional().openapi({ description: "Drafts only: an issued PO keeps its vendor." }),
    orderDate: poFields.orderDate.optional().openapi({ description: "The date on the PO." }),
    expectedDate: poFields.expectedDate.optional(),
    vendorReference: poFields.vendorReference.optional(),
    notes: poFields.notes.optional(),
    lines: poFields.lines.optional().openapi({
      description: "When sent, replaces every line (send the full list). Line ids change; nothing refers to them until goods are received.",
    }),
  })
  .strict({ message: `Unknown purchase order field. Only version, ${FIELD_LIST} can be updated; the store is fixed.` })
  .refine((body) => Object.keys(body).length > 1, {
    message: "At least one field besides version must be provided.",
  })
  .superRefine((body, ctx) => {
    // Only checkable here when both are sent; the service checks against the stored dates otherwise.
    if (body.orderDate && body.expectedDate && body.expectedDate < body.orderDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedDate"], message: DATE_ORDER_MESSAGE });
    }
    checkLines(body.lines, ctx);
  })
  .openapi("UpdatePurchaseOrderInput");

// ==========================================
// Status changes
// ==========================================

export const issuePurchaseOrderSchema = z
  .object({ version: versionField })
  .strict({ message: "Unknown field. Only version is accepted." })
  .openapi("IssuePurchaseOrderInput");

const reasonField = optionalText("reason", 500).openapi({
  description: "Why the PO was stopped; kept on the PO.",
  example: "Vendor cannot supply before the promotion ends.",
});

export const cancelPurchaseOrderSchema = z
  .object({ version: versionField, reason: reasonField.optional() })
  .strict({ message: "Unknown field. Only version and reason are accepted." })
  .openapi("CancelPurchaseOrderInput");

export const closePurchaseOrderSchema = z
  .object({ version: versionField, reason: reasonField.optional() })
  .strict({ message: "Unknown field. Only version and reason are accepted." })
  .openapi("ClosePurchaseOrderInput");

/** DELETE has no body, so the version travels in the query string. */
export const deletePurchaseOrderQuerySchema = z.object({
  version: z.coerce
    .number({ required_error: "version is required.", invalid_type_error: "version must be a number." })
    .int({ message: "version must be a whole number." })
    .min(1, { message: "version must be at least 1." })
    .openapi({ description: "The `version` of the draft you loaded.", example: 2 }),
});

// ==========================================
// Query strings (documented; parsed leniently by the controller)
// ==========================================

export const listPurchaseOrdersQuerySchema = z.object({
  search: z.string().optional().openapi({
    description:
      "Case-insensitive prefix match on the PO number, with or without `PO-` (`PO-0001` and `0001` both find PO-00010 to PO-00019), or on `vendorReference`.",
    example: "PO-0001",
  }),
  storeId: z.string().optional().openapi({
    description: "Cross-store list only: just this store's POs.",
    example: "665f1c2e8a4b3c0012ab3400",
  }),
  vendorId: z.string().optional().openapi({ description: "Only this vendor's POs.", example: "665f1c2e8a4b3c0012ab3900" }),
  status: z.string().optional().openapi({
    description: `One status or several separated by commas (\`issued,partially_received\` for POs still awaiting goods). Values: ${PURCHASE_ORDER_STATUSES.map((s) => `\`${s}\``).join(", ")}. Unrecognised values are ignored.`,
    example: "issued,partially_received",
  }),
  from: z.string().optional().openapi({ description: "Earliest `orderDate` (YYYY-MM-DD), inclusive.", example: "2026-10-01" }),
  to: z.string().optional().openapi({ description: "Latest `orderDate` (YYYY-MM-DD), inclusive.", example: "2026-10-31" }),
  page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
  limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
});

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;
export type CancelPurchaseOrderInput = z.infer<typeof cancelPurchaseOrderSchema>;
export type ClosePurchaseOrderInput = z.infer<typeof closePurchaseOrderSchema>;
