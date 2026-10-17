/**
 * Purpose: Edge cases for the Phase 2 stock validators: float precision, non-finite and
 * wrong-typed values, boundaries, header handling and whitespace-only input.
 */

import { describe, it, expect } from "vitest";
import {
  adjustmentLineSchema,
  createStockAdjustmentSchema,
  createStockTransferSchema,
  idempotencyHeadersSchema,
} from "../../src/validators/stock.validator";
import { createProductSchema } from "../../src/validators/product.validator";

const V = "665f1c2e8a4b3c0012ab3801";
const S1 = "665f1c2e8a4b3c0012ab3400";
const S2 = "665f1c2e8a4b3c0012ab3401";

const line = (fields: Record<string, unknown>) => adjustmentLineSchema.safeParse({ variantId: V, ...fields });
const adjust = (reason: string, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  createStockAdjustmentSchema.safeParse({ reason, lines: [{ variantId: V, ...fields }], ...extra });
const transfer = (quantity: unknown) =>
  createStockTransferSchema.safeParse({ fromStoreId: S1, toStoreId: S2, lines: [{ variantId: V, quantity }] });

describe("quantity precision and range", () => {
  it("accepts floating point sums that are really 3-decimal values", () => {
    expect(line({ quantityChange: 0.1 + 0.2 }).success).toBe(true); // 0.30000000000000004
    expect(line({ quantityChange: 1.005 }).success).toBe(true);
    expect(line({ quantityChange: -0.001 }).success).toBe(true);
    expect(line({ quantityChange: 0.001 }).success).toBe(true);
  });

  it("refuses sub-milli values, including negative ones", () => {
    expect(line({ quantityChange: 0.0001 }).success).toBe(false);
    expect(line({ quantityChange: 1e-4 }).success).toBe(false);
    expect(line({ quantityChange: -0.0005 }).success).toBe(false);
    expect(line({ countedQuantity: 0.0005 }).success).toBe(false);
  });

  it("enforces the magnitude boundary", () => {
    expect(line({ quantityChange: 1_000_000_000 }).success).toBe(true);
    expect(line({ quantityChange: -1_000_000_000 }).success).toBe(true);
    expect(line({ quantityChange: 1_000_000_000.001 }).success).toBe(false);
    expect(line({ quantityChange: 1e21 }).success).toBe(false);
    expect(line({ quantityChange: -1e21 }).success).toBe(false);
    expect(line({ countedQuantity: 1e300 }).success).toBe(false);
  });

  it("refuses NaN, Infinity, strings, null, booleans and objects", () => {
    for (const bad of [NaN, Infinity, -Infinity, "5", "", null, true, {}, [], [1]]) {
      expect(line({ quantityChange: bad }).success, String(bad)).toBe(false);
      expect(line({ countedQuantity: bad }).success, String(bad)).toBe(false);
    }
  });

  it("treats null for either quantity field as invalid rather than as absent", () => {
    expect(line({ quantityChange: null, countedQuantity: 3 }).success).toBe(false);
  });

  it("does not treat -0 as a valid change", () => {
    expect(line({ quantityChange: -0 }).success).toBe(false);
  });
});

describe("adjustment line shapes", () => {
  it("rejects non-string and object variantIds without throwing", () => {
    for (const bad of [{ $ne: null }, ["x"], 123, null, undefined, ""]) {
      expect(() => line({ variantId: bad, quantityChange: 1 })).not.toThrow();
      expect(line({ variantId: bad, quantityChange: 1 }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("does not crash the duplicate check when variantId is invalid", () => {
    expect(() =>
      createStockAdjustmentSchema.safeParse({ reason: "found", lines: [{ variantId: { a: 1 }, quantityChange: 1 }] })
    ).not.toThrow();
  });

  it("accepts a zero count with and without unitCost", () => {
    expect(adjust("count_correction", { countedQuantity: 0 }).success).toBe(true);
    expect(adjust("count_correction", { countedQuantity: 0, unitCost: "1.000" }).success).toBe(true);
  });

  it("rejects a negative count on opening_balance and a negative change", () => {
    expect(adjust("opening_balance", { countedQuantity: -5 }).success).toBe(false);
    expect(adjust("opening_balance", { quantityChange: -5 }).success).toBe(false);
  });

  it("validates unitCost format, not just the sign rule", () => {
    for (const bad of ["-1.000", "1,5", "1e3", " ", "", 1.5, null, "1.2345", "12345678901234.0"]) {
      expect(line({ quantityChange: 1, unitCost: bad }).success, String(bad)).toBe(false);
    }
    expect(line({ quantityChange: 1, unitCost: "0" }).success).toBe(true);
    expect(line({ quantityChange: 1, unitCost: " 1.5 " }).success).toBe(true);
  });

  it("refuses unitCost with a negative change even when the cost is zero", () => {
    expect(line({ quantityChange: -1, unitCost: "0" }).success).toBe(false);
  });

  it("refuses client attempts to inject tenant or ledger fields", () => {
    for (const field of ["organizationId", "storeId", "movementType", "balanceAfter", "createdBy"]) {
      expect(line({ quantityChange: 1, [field]: "x" }).success, field).toBe(false);
      expect(adjust("found", { quantityChange: 1 }, { [field]: "x" }).success, field).toBe(false);
    }
  });
});

describe("adjustment notes and reasons", () => {
  const ok = { quantityChange: 1 };

  it("refuses a whitespace-only note for reason other, and an empty note anywhere", () => {
    expect(adjust("other", ok, { note: "   \n\t " }).success).toBe(false);
    expect(adjust("found", ok, { note: "" }).success).toBe(false);
    expect(adjust("other", ok, { note: null }).success).toBe(false);
  });

  it("trims the note and enforces 500 characters", () => {
    const trimmed = adjust("other", ok, { note: "  hello  " });
    expect(trimmed.success && trimmed.data.note).toBe("hello");
    expect(adjust("other", ok, { note: "a".repeat(500) }).success).toBe(true);
    expect(adjust("other", ok, { note: "a".repeat(501) }).success).toBe(false);
  });

  it("reasons are case-sensitive and not inherited from Object.prototype", () => {
    for (const bad of ["Damaged", "DAMAGED", "constructor", "__proto__", "toString", "", null, 1]) {
      expect(adjust(bad as string, { quantityChange: -1 }).success, String(bad)).toBe(false);
    }
  });

  it("allows exactly 200 lines and flags duplicates among many", () => {
    const ids = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(24, "0"));
    const lines = ids.map((variantId) => ({ variantId, quantityChange: 1 }));
    expect(createStockAdjustmentSchema.safeParse({ reason: "found", lines }).success).toBe(true);
    lines[199] = { variantId: ids[0].toUpperCase(), quantityChange: 1 };
    expect(createStockAdjustmentSchema.safeParse({ reason: "found", lines }).success).toBe(false);
  });
});

describe("transfer edge cases", () => {
  it("applies the same precision and range rules as adjustments", () => {
    expect(transfer(0.1 + 0.2).success).toBe(true);
    expect(transfer(0.001).success).toBe(true);
    for (const bad of [0.0001, NaN, Infinity, "2", null, 1_000_000_001]) {
      expect(transfer(bad).success, String(bad)).toBe(false);
    }
  });

  it("rejects malformed store ids and mixed-case duplicates of the same store", () => {
    expect(createStockTransferSchema.safeParse({ fromStoreId: S1, toStoreId: "abc", lines: [{ variantId: V, quantity: 1 }] }).success).toBe(false);
    expect(
      createStockTransferSchema.safeParse({ fromStoreId: "665F1C2E8A4B3C0012AB3400", toStoreId: S1, lines: [{ variantId: V, quantity: 1 }] }).success
    ).toBe(false);
  });

  it("enforces 1-200 lines and the note rules", () => {
    const base = { fromStoreId: S1, toStoreId: S2 };
    expect(createStockTransferSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(createStockTransferSchema.safeParse({ ...base, lines: [{ variantId: V, quantity: 1 }], note: "  " }).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => ({ variantId: i.toString(16).padStart(24, "0"), quantity: 1 }));
    expect(createStockTransferSchema.safeParse({ ...base, lines: many }).success).toBe(false);
  });
});

describe("Idempotency-Key header", () => {
  const parse = (value: unknown) => idempotencyHeadersSchema.safeParse({ "idempotency-key": value });

  it("trims surrounding whitespace and enforces the 8 and 128 length boundaries", () => {
    expect(parse("  abcd1234  ").success).toBe(true);
    expect(parse("a".repeat(7)).success).toBe(false);
    expect(parse("a".repeat(8)).success).toBe(true);
    expect(parse("a".repeat(128)).success).toBe(true);
    expect(parse("a".repeat(129)).success).toBe(false);
  });

  it("refuses unsafe characters, newlines and non-strings", () => {
    for (const bad of ["abcd1234\nabcd", "abcd 1234", "abcd1234;", "abcd1234$", "../../etc", "ключ-12345678", ["abcdefgh"], 12345678, null]) {
      expect(parse(bad).success, String(bad)).toBe(false);
    }
  });

  it("is keyed on the lower-case header name (Node lower-cases incoming headers)", () => {
    expect(idempotencyHeadersSchema.safeParse({ "Idempotency-Key": "abcd1234" }).success).toBe(false);
  });
});

describe("opening stock edge cases on the product form", () => {
  const single = (openingStock: unknown, unit = "pcs") =>
    createProductSchema.safeParse({ name: "Coffee", type: "goods", unit, sales: { sellingPrice: "2.750" }, inventory: { openingStock } });

  it("applies precision, range and type rules to quantity and unitCost", () => {
    expect(single([{ storeId: S1, quantity: 1.0001 }], "kg").success).toBe(false);
    expect(single([{ storeId: S1, quantity: 1.001 }], "kg").success).toBe(true);
    expect(single([{ storeId: S1, quantity: NaN }]).success).toBe(false);
    expect(single([{ storeId: S1, quantity: 1e12 }]).success).toBe(false);
    expect(single([{ storeId: S1, quantity: 1, unitCost: "-1.000" }]).success).toBe(false);
    expect(single([{ storeId: S1, quantity: 1, unitCost: 1.6 }]).success).toBe(false);
  });

  it("refuses non-array shapes and more than 50 stores", () => {
    expect(single({ storeId: S1, quantity: 1 }).success).toBe(false);
    expect(single(5).success).toBe(false);
    expect(single(null).success).toBe(false);
    const stores = Array.from({ length: 51 }, (_, i) => ({ storeId: i.toString(16).padStart(24, "0"), quantity: 1 }));
    expect(single(stores).success).toBe(false);
    expect(single(stores.slice(0, 50)).success).toBe(true);
  });

  it("flags duplicate stores that differ only by case", () => {
    expect(single([{ storeId: S1, quantity: 1 }, { storeId: S1.toUpperCase(), quantity: 1 }]).success).toBe(false);
  });
});
