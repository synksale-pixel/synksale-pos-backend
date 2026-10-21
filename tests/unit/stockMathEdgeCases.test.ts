/**
 * Purpose: Edge cases of the weighted-average math in stockLedger.service that stockMath.test.ts
 * does not cover: tiny quantities at high costs, rounding that meets the remaining value, long
 * random sequences that must keep every invariant, and pagination clamping.
 */

import { describe, it, expect } from "vitest";
import { computeAddition, computeRemoval, EMPTY_LEVEL, LevelState } from "../../src/services/stockLedger.service";
import { resolvePaging, MAX_PAGE } from "../../src/utils/pagination";
import { toMilli, fromMilli } from "../../src/utils/quantity";

const lvl = (quantityMilli: number, valueMinor: number, avgCostMinor: number | null = null): LevelState => ({
  quantityMilli,
  valueMinor,
  avgCostMinor,
});

describe("computeAddition / computeRemoval edge cases", () => {
  it("values 0.001 at a very high cost and empties it exactly", () => {
    const added = computeAddition(EMPTY_LEVEL, 1, 999_999_999);
    // 999,999,999 minor × 0.001 = 999,999.999 → 1,000,000
    expect(added.valueChangeMinor).toBe(1_000_000);
    expect(added.after).toEqual({ quantityMilli: 1, valueMinor: 1_000_000, avgCostMinor: 1_000_000_000 });
    const removed = computeRemoval(added.after, 1);
    expect(removed.valueChangeMinor).toBe(-1_000_000);
    expect(removed.after.valueMinor).toBe(0);
    expect(removed.after.quantityMilli).toBe(0);
  });

  it("values a tiny quantity at a tiny cost as zero without going negative", () => {
    const added = computeAddition(EMPTY_LEVEL, 1, 1); // 0.001 × 1 fil = 0.001 fil
    expect(added.valueChangeMinor).toBe(0);
    expect(added.after.valueMinor).toBe(0);
    const removed = computeRemoval(added.after, 1);
    expect(removed.valueChangeMinor).toBe(0);
    expect(Object.is(removed.valueChangeMinor, -0)).toBe(false);
    expect(removed.after.valueMinor).toBe(0);
  });

  it("never removes more value than remains when rounding half-up meets the remaining value", () => {
    // 2 units worth 1 fil: removing one rounds 0.5 up to 1, leaving 0 for the remaining unit.
    const math = computeRemoval(lvl(2000, 1, 1), 1000);
    expect(math.valueChangeMinor).toBe(-1);
    expect(math.after).toEqual({ quantityMilli: 1000, valueMinor: 0, avgCostMinor: 1 });
    // Emptying then takes the exact remainder (nothing).
    const rest = computeRemoval(math.after, 1000);
    expect(rest.valueChangeMinor).toBe(0);
    expect(rest.after.valueMinor).toBe(0);
  });

  it("removes at the last average while negative, valuing the level at zero", () => {
    const math = computeRemoval(lvl(-3000, 0, 1500), 2000);
    expect(math.unitCostMinor).toBe(1500);
    expect(math.valueChangeMinor).toBe(-3000);
    expect(math.after).toEqual({ quantityMilli: -5000, valueMinor: 0, avgCostMinor: 1500 });
  });

  it("removes from a never-stocked level at cost zero without inventing an average", () => {
    const math = computeRemoval(EMPTY_LEVEL, 1000);
    expect(math.unitCostMinor).toBe(0);
    expect(math.valueChangeMinor).toBe(0);
    expect(math.after.quantityMilli).toBe(-1000);
    expect(math.after.valueMinor).toBe(0);
  });

  it("crossing zero in one removal charges the whole quantity but values the level at zero", () => {
    const math = computeRemoval(lvl(2000, 2000, 1000), 5000);
    expect(math.valueChangeMinor).toBe(-5000);
    expect(math.after).toEqual({ quantityMilli: -3000, valueMinor: 0, avgCostMinor: 1000 });
  });

  it("an addition that only reaches zero from negative stock has no value", () => {
    const math = computeAddition(lvl(-3000, 0, 1000), 3000, 2000);
    expect(math.after.quantityMilli).toBe(0);
    expect(math.after.valueMinor).toBe(0);
    expect(math.after.avgCostMinor).toBe(2000);
  });

  it("an addition with an exact total (a transfer) into negative stock values only the part above zero", () => {
    const math = computeAddition(lvl(-2000, 0, 5000), 5000, 1000, 5000);
    expect(math.after).toEqual({ quantityMilli: 3000, valueMinor: 3000, avgCostMinor: 1000 });
    expect(math.valueChangeMinor).toBe(5000);
  });

  it("keeps a zero-cost receipt at zero value and average", () => {
    const math = computeAddition(EMPTY_LEVEL, 5000, 0);
    expect(math.after).toEqual({ quantityMilli: 5000, valueMinor: 0, avgCostMinor: 0 });
  });

  it("stays exact with large (but safe) figures", () => {
    // 1,000,000 units at 1,000,000 fils each = 1e12 fils.
    const math = computeAddition(EMPTY_LEVEL, 1_000_000_000, 1_000_000);
    expect(math.after.valueMinor).toBe(1_000_000_000_000);
    expect(Number.isSafeInteger(math.after.valueMinor)).toBe(true);
    const emptied = computeRemoval(math.after, 1_000_000_000);
    expect(emptied.after.valueMinor).toBe(0);
    expect(emptied.valueChangeMinor).toBe(-1_000_000_000_000);
  });

  it("keeps every invariant over a long pseudo-random run of receipts and removals", () => {
    let seed = 987654321;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let level = lvl(0, 0, null);
    let quantitySum = 0;
    let valueFromMovements = 0;
    for (let step = 0; step < 5000; step += 1) {
      const quantity = 1 + Math.floor(next() * 5000);
      const adding = next() < 0.55 || level.quantityMilli <= 0;
      const math = adding
        ? computeAddition(level, quantity, Math.floor(next() * 5000))
        : computeRemoval(level, Math.min(quantity, level.quantityMilli));
      if (!adding) {
        // Removal from positive stock never removes more value than the level holds.
        expect(-math.valueChangeMinor).toBeLessThanOrEqual(level.valueMinor);
      }
      quantitySum += adding ? quantity : -Math.min(quantity, level.quantityMilli);
      valueFromMovements += math.valueChangeMinor;
      level = math.after;

      expect(level.quantityMilli).toBe(quantitySum);
      expect(Number.isSafeInteger(level.valueMinor)).toBe(true);
      expect(level.valueMinor).toBeGreaterThanOrEqual(0);
      expect(level.quantityMilli >= 0).toBe(true);
      if (level.quantityMilli === 0) expect(level.valueMinor).toBe(0);
      expect(Object.is(math.valueChangeMinor, -0)).toBe(false);
    }
    // With no negative stock, the movements' values add up to the level's value.
    expect(valueFromMovements).toBe(level.valueMinor);
  });
});

describe("quantity conversion", () => {
  it("round-trips float noise exactly", () => {
    expect(toMilli(0.1 + 0.2)).toBe(300);
    expect(toMilli(1.005)).toBe(1005);
    expect(toMilli(-0.0004)).toBe(0);
    expect(Object.is(toMilli(-0.0004), -0)).toBe(false);
    expect(fromMilli(toMilli(1_000_000_000))).toBe(1_000_000_000);
    expect(Object.is(fromMilli(0), -0)).toBe(false);
  });
});

describe("resolvePaging clamping", () => {
  it("clamps absurd pages so skip stays a small whole number", () => {
    for (const page of [1e30, 9007199254740993, 1e308]) {
      const paging = resolvePaging({ page, limit: 100 });
      expect(paging.page).toBe(MAX_PAGE);
      expect(Number.isSafeInteger(paging.skip)).toBe(true);
    }
  });

  it("falls back to defaults for NaN, Infinity, negative and zero", () => {
    for (const page of [NaN, Infinity, -1, 0, undefined]) {
      expect(resolvePaging({ page, limit: NaN })).toEqual({ page: 1, limit: 20, skip: 0 });
    }
    expect(resolvePaging({ page: 2.9, limit: 500 })).toEqual({ page: 2, limit: 100, skip: 100 });
  });
});
