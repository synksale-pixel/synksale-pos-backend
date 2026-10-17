/**
 * Purpose: Pins the Phase 2 stock contract (src/validators/stock.validator.ts and the opening
 * stock fields in product.validator.ts) before the ledger exists: the documented Swagger examples
 * must parse, and every rule the frontend relies on must hold.
 */

import { describe, it, expect } from "vitest";
import {
  createStockAdjustmentSchema,
  createStockTransferSchema,
  idempotencyHeadersSchema,
} from "../../src/validators/stock.validator";
import { createProductSchema, createVariantSchema, updateProductSchema } from "../../src/validators/product.validator";
import { adjustmentExample, countExample, foundExample, transferExample } from "../../src/docs/stock.openapi";
import { singleWithOpeningStockExample } from "../../src/docs/product.openapi";

type Parsed = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };

function issues(result: Parsed) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
}

function rejected(result: Parsed, fragment: string) {
  expect(result.success).toBe(false);
  expect(issues(result)).toContain(fragment);
}

const VARIANT_A = "665f1c2e8a4b3c0012ab3801";
const VARIANT_B = "665f1c2e8a4b3c0012ab3802";
const STORE_A = "665f1c2e8a4b3c0012ab3400";
const STORE_B = "665f1c2e8a4b3c0012ab3401";

describe("documented examples", () => {
  it("the adjustment, count, found and transfer examples are valid", () => {
    for (const example of [adjustmentExample, countExample, foundExample]) {
      expect(issues(createStockAdjustmentSchema.safeParse(example))).toBe("");
    }
    expect(issues(createStockTransferSchema.safeParse(transferExample))).toBe("");
  });

  it("the product-with-opening-stock example is valid", () => {
    expect(issues(createProductSchema.safeParse(singleWithOpeningStockExample))).toBe("");
  });
});

describe("stock adjustments", () => {
  // count_correction allows both directions and counts, so the line rules are tested in isolation.
  const adjust = (lines: unknown[], extra: Record<string, unknown> = {}) =>
    createStockAdjustmentSchema.safeParse({ reason: "count_correction", lines, ...extra });

  it("needs exactly one of quantityChange or countedQuantity per line", () => {
    rejected(adjust([{ variantId: VARIANT_A }]), "Send exactly one of quantityChange or countedQuantity");
    rejected(adjust([{ variantId: VARIANT_A, quantityChange: 1, countedQuantity: 3 }]), "Send exactly one");
  });

  it("refuses a zero change but accepts a zero count", () => {
    rejected(adjust([{ variantId: VARIANT_A, quantityChange: 0 }]), "cannot be zero");
    expect(adjust([{ variantId: VARIANT_A, countedQuantity: 0 }]).success).toBe(true);
  });

  it("refuses a negative count and more than 3 decimals", () => {
    rejected(adjust([{ variantId: VARIANT_A, countedQuantity: -1 }]), "cannot be negative");
    rejected(adjust([{ variantId: VARIANT_A, quantityChange: 1.2345 }]), "at most 3 decimal places");
    expect(adjust([{ variantId: VARIANT_A, quantityChange: -1.25 }]).success).toBe(true);
  });

  it("accepts unitCost only when stock may be added", () => {
    rejected(adjust([{ variantId: VARIANT_A, quantityChange: -2, unitCost: "1.000" }]), "lines.0.unitCost");
    expect(adjust([{ variantId: VARIANT_A, quantityChange: 2, unitCost: "1.000" }]).success).toBe(true);
    expect(adjust([{ variantId: VARIANT_A, countedQuantity: 9, unitCost: "1.000" }]).success).toBe(true);
    rejected(adjust([{ variantId: VARIANT_A, quantityChange: 2, unitCost: "1.2345" }]), "at most 3 decimal places");
  });

  it("refuses the same variant twice, case-insensitively", () => {
    rejected(
      adjust([
        { variantId: VARIANT_A, quantityChange: 1 },
        { variantId: VARIANT_A.toUpperCase(), quantityChange: 2 },
      ]),
      "listed more than once"
    );
  });

  it("needs a note for reason other, and a known reason", () => {
    rejected(adjust([{ variantId: VARIANT_A, quantityChange: 1 }], { reason: "other" }), "note: A note is required");
    expect(adjust([{ variantId: VARIANT_A, quantityChange: 1 }], { reason: "other", note: "Sample for display" }).success).toBe(true);
    rejected(adjust([{ variantId: VARIANT_A, quantityChange: 1 }], { reason: "stolen" }), "reason must be one of");
  });

  it("needs 1-200 lines and rejects unknown fields such as storeId", () => {
    rejected(adjust([]), "at least one line");
    const many = Array.from({ length: 201 }, (_, i) => ({ variantId: i.toString(16).padStart(24, "0"), quantityChange: 1 }));
    rejected(adjust(many), "At most 200 lines");
    rejected(adjust([{ variantId: VARIANT_A, quantityChange: 1 }], { storeId: STORE_A }), "The store comes from the URL");
    rejected(adjust([{ variantId: VARIANT_A, quantityChange: 1, quantity: 1 }]), "Unknown adjustment line field");
  });

  it("refuses a malformed variantId", () => {
    rejected(adjust([{ variantId: "abc", quantityChange: 1 }]), "24-character hex id");
  });
});

describe("adjustment reasons decide the direction", () => {
  const line = (fields: Record<string, unknown>) => [{ variantId: VARIANT_A, ...fields }];
  const withReason = (reason: string, fields: Record<string, unknown>) =>
    createStockAdjustmentSchema.safeParse({ reason, note: "n", lines: line(fields) });

  it("damaged, expired and theft_loss only remove stock and never take a count", () => {
    for (const reason of ["damaged", "expired", "theft_loss"]) {
      expect(withReason(reason, { quantityChange: -1 }).success, reason).toBe(true);
      rejected(withReason(reason, { quantityChange: 1 }), `lines.0.quantityChange: Reason ${reason} only removes stock`);
      rejected(withReason(reason, { countedQuantity: 3 }), "lines.0.countedQuantity: A counted quantity needs reason count_correction or opening_balance");
    }
  });

  it("found only adds stock", () => {
    expect(withReason("found", { quantityChange: 2, unitCost: "1.000" }).success).toBe(true);
    rejected(withReason("found", { quantityChange: -2 }), "Reason found only adds stock");
    rejected(withReason("found", { countedQuantity: 2 }), "A counted quantity needs");
  });

  it("opening_balance adds stock or takes a count", () => {
    expect(withReason("opening_balance", { quantityChange: 10, unitCost: "1.600" }).success).toBe(true);
    expect(withReason("opening_balance", { countedQuantity: 10, unitCost: "1.600" }).success).toBe(true);
    rejected(withReason("opening_balance", { quantityChange: -1 }), "Reason opening_balance only adds stock");
  });

  it("count_correction and other go either way, but other takes no count", () => {
    for (const reason of ["count_correction", "other"]) {
      expect(withReason(reason, { quantityChange: 1 }).success, reason).toBe(true);
      expect(withReason(reason, { quantityChange: -1 }).success, reason).toBe(true);
    }
    expect(withReason("count_correction", { countedQuantity: 4 }).success).toBe(true);
    rejected(withReason("other", { countedQuantity: 4 }), "A counted quantity needs");
  });
});

describe("stock transfers", () => {
  const transfer = (overrides: Record<string, unknown> = {}) =>
    createStockTransferSchema.safeParse({
      fromStoreId: STORE_A,
      toStoreId: STORE_B,
      lines: [{ variantId: VARIANT_A, quantity: 2 }],
      ...overrides,
    });

  it("refuses the same store on both sides", () => {
    rejected(transfer({ toStoreId: STORE_A.toUpperCase() }), "toStoreId: Choose a different store");
  });

  it("needs positive quantities", () => {
    rejected(transfer({ lines: [{ variantId: VARIANT_A, quantity: 0 }] }), "greater than zero");
    rejected(transfer({ lines: [{ variantId: VARIANT_A, quantity: -1 }] }), "cannot be negative");
  });

  it("refuses duplicate variants and unknown fields", () => {
    rejected(
      transfer({
        lines: [
          { variantId: VARIANT_A, quantity: 1 },
          { variantId: VARIANT_A, quantity: 1 },
        ],
      }),
      "listed more than once"
    );
    rejected(transfer({ lines: [{ variantId: VARIANT_B, quantity: 1, unitCost: "1.000" }] }), "Unknown transfer line field");
    rejected(transfer({ status: "in_transit" }), "Unknown transfer field");
  });
});

describe("Idempotency-Key header", () => {
  it("is required and limited to 8-128 safe characters", () => {
    rejected(idempotencyHeadersSchema.safeParse({}), "Idempotency-Key header is required");
    rejected(idempotencyHeadersSchema.safeParse({ "idempotency-key": "short" }), "8-128 characters");
    rejected(idempotencyHeadersSchema.safeParse({ "idempotency-key": "has spaces in it" }), "8-128 characters");
    expect(idempotencyHeadersSchema.safeParse({ "idempotency-key": "6c8e4f0e-2a7b-4d3c-9f51-0b2d7a1e9c44" }).success).toBe(true);
  });
});

describe("opening stock on the product form", () => {
  const single = (inventory: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
    createProductSchema.safeParse({ name: "Coffee", type: "goods", sales: { sellingPrice: "2.750" }, inventory, ...overrides });

  it("accepts a per-store list on a single item", () => {
    expect(issues(single({ openingStock: [{ storeId: STORE_A, quantity: 5 }, { storeId: STORE_B, quantity: 2, unitCost: "1.000" }] }))).toBe("");
  });

  it("refuses the same store twice, zero quantities and empty lists", () => {
    rejected(single({ openingStock: [{ storeId: STORE_A, quantity: 5 }, { storeId: STORE_A, quantity: 1 }] }), "listed more than once");
    rejected(single({ openingStock: [{ storeId: STORE_A, quantity: 0 }] }), "greater than zero");
    rejected(single({ openingStock: [] }), "Omit openingStock");
  });

  it("applies the unit rule to opening quantities", () => {
    rejected(single({ openingStock: [{ storeId: STORE_A, quantity: 1.5 }] }), "inventory.openingStock.0.quantity: Unit 'pcs' only allows whole quantities");
    expect(single({ openingStock: [{ storeId: STORE_A, quantity: 1.5 }] }, { unit: "kg" }).success).toBe(true);
  });

  it("refuses opening stock for services and for goods that do not track inventory", () => {
    rejected(
      createProductSchema.safeParse({
        name: "Gift wrap",
        type: "service",
        sales: { sellingPrice: "0.500" },
        inventory: { openingStock: [{ storeId: STORE_A, quantity: 1 }] },
      }),
      "Opening stock needs a goods item that tracks inventory"
    );
    rejected(single({ trackInventory: false, openingStock: [{ storeId: STORE_A, quantity: 1 }] }), "Opening stock needs a goods item");
  });

  it("goes on each variant of a variant item, not at the top level", () => {
    const variantItem = (variantExtra: Record<string, unknown>, inventory?: Record<string, unknown>) =>
      createProductSchema.safeParse({
        name: "T-shirt",
        type: "goods",
        itemType: "variant",
        attributes: [{ name: "Size", options: ["S", "M"] }],
        variants: [
          { attributeValues: { Size: "S" }, sellingPrice: "4.500", ...variantExtra },
          { attributeValues: { Size: "M" }, sellingPrice: "4.500" },
        ],
        ...(inventory ? { inventory } : {}),
      });
    expect(issues(variantItem({ openingStock: [{ storeId: STORE_A, quantity: 3 }] }))).toBe("");
    rejected(variantItem({ openingStock: [{ storeId: STORE_A, quantity: 2.5 }] }), "variants.0.openingStock.0.quantity");
    rejected(variantItem({}, { openingStock: [{ storeId: STORE_A, quantity: 3 }] }), "inventory.openingStock: Variant items set this on each variant");
  });

  it("is accepted on add-variant and refused on product update", () => {
    expect(
      createVariantSchema.safeParse({ attributeValues: { Size: "L" }, sellingPrice: "4.500", openingStock: [{ storeId: STORE_A, quantity: 1 }] }).success
    ).toBe(true);
    rejected(updateProductSchema.safeParse({ inventory: { openingStock: [{ storeId: STORE_A, quantity: 1 }] } }), "Use a stock adjustment");
  });
});
