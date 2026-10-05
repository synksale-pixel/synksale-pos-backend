/**
 * Purpose: Exact money arithmetic.
 * Money is stored as an integer count of minor units (fils, cents, paise) and travels over the API
 * as a decimal string ("1.250"). JavaScript numbers cannot represent 1.005 exactly, so every
 * conversion and multiplication goes through decimal.js and only the final, rounded minor-unit
 * integer is turned back into a number.
 *
 * Rounding is half-up (away from zero on .5), applied per line; document totals are the sum of
 * the rounded lines, never a re-rounded grand total.
 */

import Decimal from "decimal.js";
import { ApiError } from "./ApiError";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const MONEY_PATTERN = /^-?\d+(\.\d+)?$/;

function toSafeInteger(value: Decimal): number {
  const result = value.toNumber();
  if (!Number.isSafeInteger(result)) {
    throw ApiError.coded(400, "AMOUNT_OUT_OF_RANGE", "Amount is too large.");
  }
  // Normalise -0 (e.g. "-0.000", or a tiny negative product rounding to zero) to 0.
  return result === 0 ? 0 : result;
}

/**
 * Converts a quantity or rate to a Decimal, turning invalid input into a 400 instead of letting
 * decimal.js throw a raw DecimalError (which the error handler would report as a 500).
 */
function toDecimal(value: string | number, code: "INVALID_QUANTITY" | "INVALID_RATE"): Decimal {
  try {
    const decimal = new D(value);
    if (decimal.isFinite()) {
      return decimal;
    }
  } catch {
    // Falls through to the coded error below.
  }
  const label = code === "INVALID_QUANTITY" ? "Quantity" : "Rate";
  throw ApiError.coded(400, code, `${label} must be a finite number.`);
}

/**
 * Parses a decimal money string into minor units. Rejects more fractional digits than the
 * currency has rather than silently rounding what the user typed.
 *
 * @example parseMoney("1.25", 3) === 1250
 */
export function parseMoney(value: string, decimals: number, field = "amount"): number {
  const text = String(value).trim();
  if (!MONEY_PATTERN.test(text)) {
    throw ApiError.coded(400, "INVALID_AMOUNT", `${field} must be a decimal number such as "1.250".`, [
      { field, code: "INVALID_AMOUNT", message: "Not a decimal number." },
    ]);
  }
  const fraction = text.split(".")[1] ?? "";
  if (fraction.length > decimals) {
    throw ApiError.coded(400, "TOO_MANY_DECIMALS", `${field} may have at most ${decimals} decimal places.`, [
      { field, code: "TOO_MANY_DECIMALS", message: `At most ${decimals} decimal places.`, meta: { decimals } },
    ]);
  }
  return toSafeInteger(new D(text).times(new D(10).pow(decimals)));
}

/** Formats minor units as a fixed decimal string. @example formatMoney(1250, 3) === "1.250" */
export function formatMoney(minor: number, decimals: number): string {
  return new D(minor).dividedBy(new D(10).pow(decimals)).toFixed(decimals);
}

/**
 * Multiplies a minor-unit amount by a (possibly fractional) quantity and rounds half-up to
 * minor units. Quantities are passed as strings or numbers with few decimals (e.g. "1.5" kg).
 */
export function multiplyMoney(minor: number, quantity: string | number): number {
  return toSafeInteger(new D(minor).times(toDecimal(quantity, "INVALID_QUANTITY")).toDecimalPlaces(0));
}

/** Applies a percentage to a minor-unit amount, rounded half-up. @example applyRate(1000, 10) === 100 */
export function applyRate(minor: number, ratePercent: string | number): number {
  return toSafeInteger(
    new D(minor).times(toDecimal(ratePercent, "INVALID_RATE")).dividedBy(100).toDecimalPlaces(0)
  );
}

/** Sums minor-unit amounts exactly. */
export function sumMoney(amounts: number[]): number {
  return toSafeInteger(amounts.reduce((total, amount) => total.plus(amount), new D(0)));
}
