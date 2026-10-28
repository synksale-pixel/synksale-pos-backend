/**
 * Purpose: Stock Validators (Phase 2 stock ledger).
 *
 * Contract rules:
 * - Stock is held per store and per variant. Every change is an append-only stock movement; a
 *   correction is a new movement, never an edit.
 * - Quantities are numbers with at most 3 decimals; whole numbers unless the product's unit
 *   allows decimals. The unit is only known to the service, so it checks that rule.
 * - Costs are VAT-exclusive decimal strings, valued at weighted average cost.
 * - Adjustments and transfers need an `Idempotency-Key` header so a retried request can never
 *   apply twice.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import {
  moneyField,
  objectIdField,
  positiveQuantityField,
  quantityChangeField,
  quantityField,
} from "./product.validator";

// ==========================================
// Shared vocabulary
// ==========================================

export const ADJUSTMENT_REASONS = [
  "damaged",
  "expired",
  "theft_loss",
  "found",
  "count_correction",
  "opening_balance",
  "other",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/**
 * Which way each reason may move stock, so reason-based reports stay meaningful. Counts
 * (`countedQuantity`) are allowed only where `count` is true. `opening_balance` gives a product
 * created before stock tracking its first stock and writes `opening` movements.
 */
export const REASON_RULES: Record<AdjustmentReason, { direction: "remove" | "add" | "either"; count: boolean }> = {
  damaged: { direction: "remove", count: false },
  expired: { direction: "remove", count: false },
  theft_loss: { direction: "remove", count: false },
  found: { direction: "add", count: false },
  count_correction: { direction: "either", count: true },
  opening_balance: { direction: "add", count: true },
  other: { direction: "either", count: false },
};

/**
 * Movement types (`opening` comes from product opening stock and from `opening_balance`
 * adjustments; `purchase` from goods receipts, Phase 3c). Later phases will add
 * `purchase_return`, `sale` and `sale_return`; clients must tolerate types they do not know.
 */
export const MOVEMENT_TYPES = ["opening", "adjustment", "transfer_out", "transfer_in", "purchase"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

const MAX_LINES = 200;

const noteField = z
  .string()
  .trim()
  .min(1, { message: "note cannot be empty. Omit it instead." })
  .max(500, { message: "note must be at most 500 characters long." });

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
// Idempotency
// ==========================================

export const IDEMPOTENCY_HEADER = "idempotency-key";

export const idempotencyHeadersSchema = z.object({
  [IDEMPOTENCY_HEADER]: z
    .string({ required_error: "The Idempotency-Key header is required." })
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/, {
      message: "Idempotency-Key must be 8-128 characters of letters, digits, '-' or '_' (a UUID works).",
    })
    .openapi({
      description:
        "A unique key per intended action (a UUID generated when the user presses Save). Retrying with the same key and the same body replays the original response instead of applying the change again.",
      example: "6c8e4f0e-2a7b-4d3c-9f51-0b2d7a1e9c44",
    }),
});

// ==========================================
// Adjustments
// ==========================================

export const adjustmentLineSchema = z
  .object({
    variantId: objectIdField("variantId", "665f1c2e8a4b3c0012ab3801"),
    quantityChange: quantityChangeField("Signed change: positive adds stock, negative removes it.", -2).optional(),
    countedQuantity: quantityField(
      "The quantity physically counted. The server records the difference from the current stock (no movement when it matches).",
      18
    ).optional(),
    unitCost: moneyField(
      "VAT-exclusive cost per unit for stock being added. Defaults to the current average cost, then the variant's cost price, then 0. Refused with a negative quantityChange; on a count line it is used only if the count raises stock, and ignored otherwise.",
      "1.600"
    ).optional(),
  })
  .strict({ message: "Unknown adjustment line field. Use variantId, quantityChange or countedQuantity, and unitCost." })
  .superRefine((line, ctx) => {
    const hasChange = line.quantityChange !== undefined;
    const hasCount = line.countedQuantity !== undefined;
    if (hasChange === hasCount) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "Send exactly one of quantityChange or countedQuantity." });
    }
    if (line.unitCost !== undefined && hasChange && (line.quantityChange as number) < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unitCost"], message: "unitCost applies only when stock is added." });
    }
  })
  .openapi("StockAdjustmentLineInput");

export const createStockAdjustmentSchema = z
  .object({
    reason: z
      .enum(ADJUSTMENT_REASONS, { message: `reason must be one of: ${ADJUSTMENT_REASONS.join(", ")}.` })
      .openapi({ example: "damaged" }),
    note: noteField.optional().openapi({ description: "Required when reason is `other`.", example: "Carton dropped in the stockroom." }),
    lines: z
      .array(adjustmentLineSchema)
      .min(1, { message: "An adjustment needs at least one line." })
      .max(MAX_LINES, { message: `At most ${MAX_LINES} lines per adjustment.` }),
  })
  .strict({ message: "Unknown adjustment field. The store comes from the URL." })
  .superRefine((body, ctx) => {
    if (body.reason === "other" && !body.note) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "A note is required when reason is other." });
    }
    for (const variantId of duplicateValues(body.lines.map((line) => line.variantId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: `Variant '${variantId}' is listed more than once.` });
    }
    const rule = REASON_RULES[body.reason];
    body.lines.forEach((line, index) => {
      if (line.countedQuantity !== undefined && !rule.count) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines", index, "countedQuantity"],
          message: `A counted quantity needs reason count_correction or opening_balance, not ${body.reason}.`,
        });
      }
      const change = line.quantityChange;
      if (change === undefined) return;
      if (rule.direction === "remove" && change > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines", index, "quantityChange"],
          message: `Reason ${body.reason} only removes stock: send a negative quantityChange.`,
        });
      }
      if (rule.direction === "add" && change < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines", index, "quantityChange"],
          message: `Reason ${body.reason} only adds stock: send a positive quantityChange.`,
        });
      }
    });
  })
  .openapi("CreateStockAdjustmentInput");

// ==========================================
// Transfers
// ==========================================

export const transferLineSchema = z
  .object({
    variantId: objectIdField("variantId", "665f1c2e8a4b3c0012ab3801"),
    quantity: positiveQuantityField("Quantity to move.", 6),
  })
  .strict({ message: "Unknown transfer line field. Use variantId and quantity." })
  .openapi("StockTransferLineInput");

export const createStockTransferSchema = z
  .object({
    fromStoreId: objectIdField("fromStoreId", "665f1c2e8a4b3c0012ab3400"),
    toStoreId: objectIdField("toStoreId", "665f1c2e8a4b3c0012ab3401"),
    note: noteField.optional().openapi({ example: "Weekend restock for the mall branch." }),
    lines: z
      .array(transferLineSchema)
      .min(1, { message: "A transfer needs at least one line." })
      .max(MAX_LINES, { message: `At most ${MAX_LINES} lines per transfer.` }),
  })
  .strict({ message: "Unknown transfer field." })
  .superRefine((body, ctx) => {
    if (body.fromStoreId.toLowerCase() === body.toStoreId.toLowerCase()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["toStoreId"], message: "Choose a different store to transfer to." });
    }
    for (const variantId of duplicateValues(body.lines.map((line) => line.variantId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: `Variant '${variantId}' is listed more than once.` });
    }
  })
  .openapi("CreateStockTransferInput");

// ==========================================
// Query strings (documented; parsed leniently by the controller)
// ==========================================

const pageField = z.number().int().optional().openapi({ description: "1-based page number (default 1; values above 1,000,000 are clamped).", example: 1 });
const limitField = z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 });
// Bare dates are read in the organization's timezone, not UTC: a Bahrain store's 1am sale belongs
// to the local day. This is the first date filter in the API and the rule for reports to follow.
const fromField = z.string().optional().openapi({
  description:
    "Inclusive start. A bare date (`2026-10-01`) means local midnight in the organization's timezone; a date-time keeps its own offset.",
  example: "2026-10-01",
});
const toField = z.string().optional().openapi({
  description:
    "Inclusive end date. A bare date includes that whole local day in the organization's timezone (the range is up to the next local midnight); a date-time is an exclusive end and keeps its own offset.",
  example: "2026-10-31",
});

export const listStockQuerySchema = z.object({
  search: z.string().optional().openapi({
    description: "Case-insensitive prefix match on product name, SKU or barcode (UPC/EAN/ISBN), as in the product list.",
    example: "coffee",
  }),
  categoryId: z.string().optional().openapi({
    description: "Filter by category, including its subcategories unless includeSubcategories=false. Use `none` for uncategorised.",
    example: "665f1c2e8a4b3c0012ab3700",
  }),
  includeSubcategories: z.enum(["true", "false"]).optional().openapi({
    description: "With categoryId: `false` returns only that category itself (default `true`).",
    example: "true",
  }),
  status: z.enum(["in_stock", "out_of_stock", "low", "negative"]).optional().openapi({
    description:
      "`in_stock`: quantity > 0. `out_of_stock`: quantity <= 0. `low`: a reorder point is set and quantity is at or below it. `negative`: quantity < 0 (only possible when the organization allows negative stock).",
    example: "low",
  }),
  includeInactive: z.enum(["true", "false"]).optional().openapi({
    description: "Send `true` to include inactive products and variants (default: active only).",
    example: "true",
  }),
  page: pageField,
  limit: limitField,
});

export const listStockMovementsQuerySchema = z.object({
  productId: z.string().optional().openapi({ description: "Only movements of this product's variants.", example: "665f1c2e8a4b3c0012ab3800" }),
  variantId: z.string().optional().openapi({ description: "Only movements of this variant.", example: "665f1c2e8a4b3c0012ab3801" }),
  type: z.enum(MOVEMENT_TYPES).optional().openapi({
    description: "Only movements of this type. An unrecognised value is ignored.",
    example: "adjustment",
  }),
  from: fromField,
  to: toField,
  page: pageField,
  limit: limitField,
});

export const listStockAdjustmentsQuerySchema = z.object({
  reason: z.enum(ADJUSTMENT_REASONS).optional().openapi({
    description: "Only adjustments with this reason. An unrecognised value is ignored.",
    example: "damaged",
  }),
  from: fromField,
  to: toField,
  page: pageField,
  limit: limitField,
});

export const listStockTransfersQuerySchema = z.object({
  storeId: z.string().optional().openapi({
    description: "Only transfers into or out of this store.",
    example: "665f1c2e8a4b3c0012ab3400",
  }),
  from: fromField,
  to: toField,
  page: pageField,
  limit: limitField,
});

export type CreateStockAdjustmentInput = z.infer<typeof createStockAdjustmentSchema>;
export type CreateStockTransferInput = z.infer<typeof createStockTransferSchema>;
