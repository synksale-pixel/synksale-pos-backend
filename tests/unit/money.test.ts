/**
 * Purpose: Tests for the exact money helpers (src/utils/money.ts): parsing decimal strings to
 * minor units, formatting back, half-up rounding on multiplication and percentages, and the
 * guards against over-precise input and unsafe integers.
 */

import { describe, it, expect } from "vitest";
import {
  parseMoney,
  formatMoney,
  multiplyMoney,
  applyRate,
  sumMoney,
} from "../../src/utils/money";
import { ApiError } from "../../src/utils/ApiError";

function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected an error");
}

describe("parseMoney", () => {
  it("converts decimal strings to minor units for 3- and 2-decimal currencies", () => {
    expect(parseMoney("1.250", 3)).toBe(1250);
    expect(parseMoney("1.25", 3)).toBe(1250);
    expect(parseMoney("1", 3)).toBe(1000);
    expect(parseMoney("0.001", 3)).toBe(1);
    expect(parseMoney("19.99", 2)).toBe(1999);
    expect(parseMoney("-2.5", 2)).toBe(-250);
  });

  it("is exact where floating point is not (1.005, 0.1 + 0.2 territory)", () => {
    expect(parseMoney("1.005", 3)).toBe(1005);
    expect(parseMoney("0.3", 3)).toBe(300);
    expect(parseMoney("4.35", 2)).toBe(435); // 4.35 * 100 === 434.99999999999994 in JS
  });

  it("trims surrounding whitespace", () => {
    expect(parseMoney(" 2.000 ", 3)).toBe(2000);
  });

  it("rejects more decimal places than the currency has, with a coded error", () => {
    const error = errorOf(() => parseMoney("1.2345", 3, "sellingPrice"));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("TOO_MANY_DECIMALS");
    expect(error.errors[0]).toMatchObject({ field: "sellingPrice", meta: { decimals: 3 } });
    expect(() => parseMoney("1.005", 2)).toThrow();
  });

  it("rejects non-numeric input", () => {
    for (const bad of ["", "abc", "1,000", "1.2.3", "1e3", ".5", "5."]) {
      expect(errorOf(() => parseMoney(bad, 3)).code).toBe("INVALID_AMOUNT");
    }
  });

  it("rejects amounts beyond the safe integer range", () => {
    expect(errorOf(() => parseMoney("99999999999999999", 3)).code).toBe("AMOUNT_OUT_OF_RANGE");
  });
});

describe("formatMoney", () => {
  it("formats minor units with the currency's fixed decimals", () => {
    expect(formatMoney(1250, 3)).toBe("1.250");
    expect(formatMoney(1, 3)).toBe("0.001");
    expect(formatMoney(0, 3)).toBe("0.000");
    expect(formatMoney(1999, 2)).toBe("19.99");
    expect(formatMoney(-250, 2)).toBe("-2.50");
  });

  it("round-trips with parseMoney", () => {
    for (const value of ["0.000", "1.005", "147.950", "1234567.891"]) {
      expect(formatMoney(parseMoney(value, 3), 3)).toBe(value);
    }
  });
});

describe("multiplyMoney", () => {
  it("multiplies by whole and fractional quantities, rounding half-up", () => {
    expect(multiplyMoney(1250, 4)).toBe(5000);
    expect(multiplyMoney(1250, "1.5")).toBe(1875);
    expect(multiplyMoney(333, "0.5")).toBe(167); // 166.5 rounds up
    expect(multiplyMoney(1001, "0.333")).toBe(333); // 333.333 rounds down
  });

  it("rounds negative halves away from zero", () => {
    expect(multiplyMoney(-333, "0.5")).toBe(-167);
  });
});

describe("applyRate", () => {
  it("applies a percentage, rounding half-up to minor units", () => {
    expect(applyRate(1000, 10)).toBe(100);
    expect(applyRate(1005, 10)).toBe(101); // 100.5 rounds up
    expect(applyRate(1004, 10)).toBe(100); // 100.4 rounds down
    expect(applyRate(1999, 5)).toBe(100); // 99.95 rounds up
    expect(applyRate(1000, "2.5")).toBe(25);
    expect(applyRate(1000, 0)).toBe(0);
  });
});

describe("sumMoney", () => {
  it("sums minor units", () => {
    expect(sumMoney([1250, 1005, -255])).toBe(2000);
    expect(sumMoney([])).toBe(0);
  });
});

describe("money edge cases", () => {
  it("never returns negative zero", () => {
    expect(Object.is(parseMoney("-0", 3), 0)).toBe(true);
    expect(Object.is(parseMoney("-0.000", 3), 0)).toBe(true);
    expect(Object.is(multiplyMoney(0, -1), 0)).toBe(true);
    expect(Object.is(applyRate(0, -5), 0)).toBe(true);
    expect(Object.is(multiplyMoney(1, "-0.4"), 0)).toBe(true);
    expect(Object.is(sumMoney([-1, 1]), 0)).toBe(true);
  });

  it("rejects values at and beyond the safe integer boundary", () => {
    expect(parseMoney("9007199254740.991", 3)).toBe(9007199254740991);
    expect(() => parseMoney("9007199254740.992", 3)).toThrow();
    expect(() => parseMoney("1e5", 3)).toThrow();
    expect(() => parseMoney(".5", 3)).toThrow();
    expect(() => parseMoney("1.", 3)).toThrow();
    expect(() => parseMoney("", 3)).toThrow();
  });

  it("handles quantities with many decimals", () => {
    expect(multiplyMoney(1000, "0.0005")).toBe(1);
    expect(multiplyMoney(1000, "0.00049999999999999999999")).toBe(0);
    expect(multiplyMoney(3, "0.1666666666666666666667")).toBe(1);
  });

  it("throws a client-safe 400 ApiError (not a raw Decimal error) for an invalid quantity or rate", () => {
    for (const fn of [() => multiplyMoney(100, "abc"), () => applyRate(100, "x%"), () => multiplyMoney(100, NaN)]) {
      expect(errorOf(fn).statusCode).toBe(400);
    }
  });

  it("formatMoney handles negatives and zero", () => {
    expect(formatMoney(-1250, 3)).toBe("-1.250");
    expect(formatMoney(0, 2)).toBe("0.00");
    expect(formatMoney(5, 3)).toBe("0.005");
  });
});
