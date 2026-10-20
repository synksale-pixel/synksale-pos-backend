/**
 * Purpose: Pins the weighted-average costing in stockLedger.service (computeAddition /
 * computeRemoval) and the organization-timezone date filters (utils/dateRange.ts).
 */

import { describe, it, expect } from "vitest";
import { computeAddition, computeRemoval, EMPTY_LEVEL, LevelState } from "../../src/services/stockLedger.service";
import { createdAtRange, localMidnight } from "../../src/utils/dateRange";
import { toMilli, fromMilli } from "../../src/utils/quantity";

const level = (quantity: number, valueMinor: number, avgCostMinor: number | null = null): LevelState => ({
  quantityMilli: toMilli(quantity),
  valueMinor,
  avgCostMinor,
});

describe("computeAddition", () => {
  it("starts the average at the cost of the first receipt", () => {
    const math = computeAddition(EMPTY_LEVEL, toMilli(10), 1000);
    expect(math).toEqual({ after: { quantityMilli: 10000, valueMinor: 10000, avgCostMinor: 1000 }, unitCostMinor: 1000, valueChangeMinor: 10000 });
  });

  it("blends receipts at different costs", () => {
    const math = computeAddition(level(8, 8000, 1000), toMilli(10), 2500);
    expect(math.after).toEqual({ quantityMilli: 18000, valueMinor: 33000, avgCostMinor: 1833 });
  });

  it("values fractional quantities with half-up rounding", () => {
    // 1.255 kg × 0.333 = 0.417915 → 418 fils
    expect(computeAddition(EMPTY_LEVEL, toMilli(1.255), 333).valueChangeMinor).toBe(418);
  });

  it("restarts at the new cost when the stock was negative, valuing only what is above zero", () => {
    const math = computeAddition(level(-3, 0, 1000), toMilli(5), 2000);
    expect(math.after).toEqual({ quantityMilli: 2000, valueMinor: 4000, avgCostMinor: 2000 });
    expect(math.valueChangeMinor).toBe(10000);
  });

  it("stays worth nothing while still at or below zero", () => {
    const math = computeAddition(level(-5, 0, 1000), toMilli(2), 2000);
    expect(math.after).toEqual({ quantityMilli: -3000, valueMinor: 0, avgCostMinor: 2000 });
  });

  it("uses an exact total when given (transfers)", () => {
    const math = computeAddition(level(2, 4000, 2000), toMilli(3), 1333, 4000);
    expect(math.after).toEqual({ quantityMilli: 5000, valueMinor: 8000, avgCostMinor: 1600 });
    expect(math.valueChangeMinor).toBe(4000);
  });
});

describe("computeRemoval", () => {
  it("removes at the exact average and keeps it", () => {
    const math = computeRemoval(level(3, 1000, 333), toMilli(1));
    expect(math.valueChangeMinor).toBe(-333);
    expect(math.after).toEqual({ quantityMilli: 2000, valueMinor: 667, avgCostMinor: 333 });
    expect(math.unitCostMinor).toBe(333);
  });

  it("empties the remaining value exactly, leaving no rounding residue", () => {
    let state = level(3, 1000, 333);
    for (let i = 0; i < 3; i += 1) state = computeRemoval(state, toMilli(1)).after;
    expect(state).toEqual({ quantityMilli: 0, valueMinor: 0, avgCostMinor: 333 });
  });

  it("goes negative at the last average and is then worth nothing", () => {
    const math = computeRemoval(level(2, 2000, 1000), toMilli(5));
    expect(math.after).toEqual({ quantityMilli: -3000, valueMinor: 0, avgCostMinor: 1000 });
    expect(math.valueChangeMinor).toBe(-5000);
  });

  it("removes never-received stock at zero cost", () => {
    const math = computeRemoval(EMPTY_LEVEL, toMilli(1));
    expect(math).toMatchObject({ unitCostMinor: 0, valueChangeMinor: 0, after: { quantityMilli: -1000, valueMinor: 0 } });
  });
});

describe("quantities", () => {
  it("store thousandths exactly and never -0", () => {
    expect(toMilli(0.1 + 0.2)).toBe(300);
    expect(toMilli(-0)).toBe(0);
    expect(Object.is(fromMilli(0), 0)).toBe(true);
    expect(fromMilli(1500)).toBe(1.5);
  });
});

describe("createdAtRange", () => {
  it("reads bare dates as local days in the organization's timezone", () => {
    // Bahrain is UTC+3: local midnight is 21:00 UTC the day before.
    expect(localMidnight(2026, 10, 1, "Asia/Bahrain").toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(createdAtRange("2026-10-01", "2026-10-31", "Asia/Bahrain")).toEqual({
      $gte: new Date("2026-09-30T21:00:00.000Z"),
      $lt: new Date("2026-10-31T21:00:00.000Z"),
    });
  });

  it("keeps a date-time's own offset and ignores unusable values", () => {
    expect(createdAtRange("2026-10-01T10:00:00+04:00", undefined, "Asia/Bahrain")).toEqual({
      $gte: new Date("2026-10-01T06:00:00.000Z"),
    });
    expect(createdAtRange("2026-02-30", "not a date", "Asia/Bahrain")).toBeUndefined();
    expect(createdAtRange(undefined, "  ", "UTC")).toBeUndefined();
  });

  it("handles month ends and UTC", () => {
    expect(createdAtRange(undefined, "2026-12-31", "UTC")).toEqual({ $lt: new Date("2027-01-01T00:00:00.000Z") });
  });
});
