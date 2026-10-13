/**
 * Purpose: Units of measure a product can be sold in.
 * `allowsDecimal` decides whether quantities in that unit may be fractional (1.5 kg) or must be
 * whole (3 pcs). v1 has no conversions between units (no "buy by the box, sell by the piece").
 */

export interface UnitDefinition {
  code: string;
  name: string;
  allowsDecimal: boolean;
}

export const UNITS: Record<string, UnitDefinition> = {
  pcs: { code: "pcs", name: "Pieces", allowsDecimal: false },
  box: { code: "box", name: "Box", allowsDecimal: false },
  pack: { code: "pack", name: "Pack", allowsDecimal: false },
  dozen: { code: "dozen", name: "Dozen", allowsDecimal: false },
  pair: { code: "pair", name: "Pair", allowsDecimal: false },
  set: { code: "set", name: "Set", allowsDecimal: false },
  bottle: { code: "bottle", name: "Bottle", allowsDecimal: false },
  can: { code: "can", name: "Can", allowsDecimal: false },
  bag: { code: "bag", name: "Bag", allowsDecimal: false },
  kg: { code: "kg", name: "Kilogram", allowsDecimal: true },
  g: { code: "g", name: "Gram", allowsDecimal: true },
  L: { code: "L", name: "Litre", allowsDecimal: true },
  mL: { code: "mL", name: "Millilitre", allowsDecimal: true },
  m: { code: "m", name: "Metre", allowsDecimal: true },
  cm: { code: "cm", name: "Centimetre", allowsDecimal: true },
};

export const DEFAULT_UNIT = "pcs";

/** Quantities are kept to at most this many decimal places (stored scaled by 10^3 in Phase 2). */
export const QUANTITY_DECIMALS = 3;

export const UNIT_CODES = Object.keys(UNITS) as [string, ...string[]];

export function unitAllowsDecimal(code: string): boolean {
  return UNITS[code]?.allowsDecimal ?? false;
}
