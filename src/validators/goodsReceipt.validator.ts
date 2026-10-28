/**
 * Purpose: Goods Receipt Validators (Phase 3c, contract).
 *
 * Contract rules:
 * - A goods receipt (GRN) records goods that arrived at a store. It is the only purchase document
 *   that adds stock. It is final when created: no drafts, no edits, no void. A mistake is fixed
 *   with a stock adjustment (or a return to vendor once 3e ships).
 * - Against a purchase order: each line names a PO line (`purchaseOrderLineId`). Several receipts
 *   per PO are fine; a line can never go above its ordered quantity. The vendor comes from the PO.
 * - Without a purchase order: send `vendorId`, and a `variantId` and `unitCost` on every line.
 * - The store comes from the URL (`/stores/:storeId/goods-receipts`) so scopeToStore verifies it.
 *   A receipt against a PO must be posted in the PO's store.
 * - `unitCost` is VAT-exclusive. Against a PO it defaults to the PO line's cost; sending a
 *   different cost, or receiving without a PO, also needs `purchase:order` (both set what the
 *   stock is worth).
 * - Creating a receipt needs an `Idempotency-Key` header: a double post would count stock twice.
 *   No PO `version` is sent: two people receiving the same PO at once must not block each other.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { moneyField, objectIdField, positiveQuantityField } from "./product.validator";
import { isCalendarDate } from "./purchaseOrder.validator";

const MAX_LINES = 200;

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} cannot be empty. Omit it instead.` })
    .max(max, { message: `${label} must be at most ${max} characters long.` });

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

export const goodsReceiptLineSchema = z
  .object({
    purchaseOrderLineId: objectIdField("purchaseOrderLineId", "665f1c2e8a4b3c0012ab3c01")
      .optional()
      .openapi({
        description: "Receipts against a PO: the PO line received (`lines[].id` on the PO). Not sent without a PO.",
      }),
    variantId: objectIdField("variantId", "665f1c2e8a4b3c0012ab3801")
      .optional()
      .openapi({ description: "Receipts without a PO: the variant received. Not sent against a PO (the PO line has it)." }),
    quantity: positiveQuantityField("Quantity received, in the product's unit.", 24),
    unitCost: moneyField(
      "VAT-exclusive cost per unit. Against a PO: optional, defaults to the PO line's `unitCost`; a different value needs `purchase:order`. Without a PO: required.",
      "1.600"
    ).optional(),
    note: optionalText("Line note", 200)
      .optional()
      .openapi({ description: "E.g. a batch number or the state of the carton.", example: "Batch 2026-10-B" }),
  })
  .strict({ message: "Unknown goods receipt line field. Use purchaseOrderLineId, variantId, quantity, unitCost and note." })
  .openapi("GoodsReceiptLineInput");

// ==========================================
// Create
// ==========================================

const FIELD_LIST = "purchaseOrderId, vendorId, receivedDate, vendorReference, notes and lines";

export const createGoodsReceiptSchema = z
  .object({
    purchaseOrderId: objectIdField("purchaseOrderId", "665f1c2e8a4b3c0012ab3c00").optional().openapi({
      description: "The PO being received: `issued` or `partially_received`, in this store. Omit for a receipt without a PO.",
    }),
    vendorId: objectIdField("vendorId", "665f1c2e8a4b3c0012ab3900").optional().openapi({
      description: "Receipts without a PO only: an active vendor of your organization. Against a PO the vendor comes from the PO.",
    }),
    receivedDate: z
      .string()
      .trim()
      .refine(isCalendarDate, { message: "receivedDate must be a calendar date in the form YYYY-MM-DD." })
      .optional()
      .openapi({
        description:
          "When the goods arrived. Defaults to today in the store's timezone; cannot be in the future, or before the PO's `orderDate`.",
        example: "2026-10-28",
      }),
    vendorReference: optionalText("vendorReference", 50)
      .optional()
      .openapi({ description: "The vendor's delivery note or invoice number, for matching their bill.", example: "DN-55120" }),
    notes: optionalText("notes", 1000)
      .optional()
      .openapi({ description: "Internal note on the delivery.", example: "Two cartons slightly crushed, contents fine." }),
    lines: z
      .array(goodsReceiptLineSchema)
      .min(1, { message: "A goods receipt needs at least one line." })
      .max(MAX_LINES, { message: `At most ${MAX_LINES} lines per goods receipt.` }),
  })
  .strict({ message: `Unknown goods receipt field. Only ${FIELD_LIST} are accepted; the store comes from the URL.` })
  .superRefine((body, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const againstPo = body.purchaseOrderId !== undefined;

    if (againstPo && body.vendorId !== undefined) {
      issue(["vendorId"], "Send vendorId only for a receipt without a purchase order; the PO has the vendor.");
    }
    if (!againstPo && body.vendorId === undefined) {
      issue(["vendorId"], "Send purchaseOrderId, or vendorId for a receipt without a purchase order.");
    }

    (body.lines ?? []).forEach((line, i) => {
      if (againstPo) {
        if (line.purchaseOrderLineId === undefined) {
          issue(["lines", i, "purchaseOrderLineId"], "Each line of a receipt against a purchase order needs purchaseOrderLineId.");
        }
        if (line.variantId !== undefined) {
          issue(["lines", i, "variantId"], "Do not send variantId on a receipt against a purchase order; the PO line has it.");
        }
      } else {
        if (line.variantId === undefined) {
          issue(["lines", i, "variantId"], "Each line of a receipt without a purchase order needs variantId.");
        }
        if (line.purchaseOrderLineId !== undefined) {
          issue(["lines", i, "purchaseOrderLineId"], "purchaseOrderLineId needs purchaseOrderId.");
        }
        if (line.unitCost === undefined) {
          issue(["lines", i, "unitCost"], "Each line of a receipt without a purchase order needs unitCost.");
        }
      }
    });

    const lines = body.lines ?? [];
    for (const id of duplicateValues(lines.flatMap((line) => line.purchaseOrderLineId ?? []))) {
      issue(["lines"], `Purchase order line '${id}' is listed more than once.`);
    }
    for (const id of duplicateValues(lines.flatMap((line) => line.variantId ?? []))) {
      issue(["lines"], `Variant '${id}' is listed more than once.`);
    }
  })
  .openapi("CreateGoodsReceiptInput");

// ==========================================
// Query strings (documented; parsed leniently by the controller)
// ==========================================

export const listGoodsReceiptsQuerySchema = z.object({
  search: z.string().optional().openapi({
    description:
      "Case-insensitive prefix match on the receipt number, with or without `GRN-` (`GRN-0001` and `0001` both find GRN-00010 to GRN-00019), or on `vendorReference`.",
    example: "GRN-0001",
  }),
  storeId: z.string().optional().openapi({
    description: "Cross-store list only: just this store's receipts.",
    example: "665f1c2e8a4b3c0012ab3400",
  }),
  vendorId: z.string().optional().openapi({ description: "Only this vendor's receipts.", example: "665f1c2e8a4b3c0012ab3900" }),
  purchaseOrderId: z.string().optional().openapi({
    description: "Only receipts against this PO (its delivery history).",
    example: "665f1c2e8a4b3c0012ab3c00",
  }),
  withoutPurchaseOrder: z.string().optional().openapi({
    description: "`true`: only receipts without a PO. Any other value is ignored.",
    example: "true",
  }),
  from: z.string().optional().openapi({ description: "Earliest `receivedDate` (YYYY-MM-DD), inclusive.", example: "2026-10-01" }),
  to: z.string().optional().openapi({ description: "Latest `receivedDate` (YYYY-MM-DD), inclusive.", example: "2026-10-31" }),
  page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
  limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
});

export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;
