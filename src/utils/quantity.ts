/**
 * Purpose: Stock quantities in storage.
 * Quantities travel over the API as numbers with at most 3 decimals (1.5 kg) and are stored as
 * integer thousandths ("milli" units), so sums and comparisons are exact. The validators already
 * refuse more than 3 decimals, so the rounding here only removes float noise (0.1 + 0.2).
 */

import { QUANTITY_DECIMALS } from "../config/units.config";

const SCALE = 10 ** QUANTITY_DECIMALS;

export function toMilli(quantity: number): number {
  const milli = Math.round(quantity * SCALE);
  return milli === 0 ? 0 : milli; // never -0
}

export function fromMilli(milli: number): number {
  const quantity = milli / SCALE;
  return quantity === 0 ? 0 : quantity;
}
