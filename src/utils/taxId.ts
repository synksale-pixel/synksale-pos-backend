/**
 * Purpose: Country-aware tax registration number checks (Phase 4a).
 *
 * Every tax ID is first normalised (spaces and hyphens removed, uppercased) and must be 5-20
 * letters or digits. Where the country is known, its own format is checked as well:
 * - IN: a 15-character GSTIN (2-digit state code, PAN, entity number, "Z", check character) with
 *   its mod-36 check character, so a typo is caught before it is printed on an invoice.
 * - SA: a 15-digit VAT number that starts and ends with 3.
 * - AE, BH: a 15-digit TRN.
 * - Anywhere else (KW, QA, OM): the generic rule only.
 */
import { GST_STATES } from "../config/gstStates.config";

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const GENERIC_TAX_ID_PATTERN = /^[A-Z0-9]{5,20}$/;

export function normalizeTaxId(value: string): string {
  return value.trim().replace(/[\s-]/g, "").toUpperCase();
}

/** The GSTIN's check character, worked out from its first 14 characters. */
export function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = GSTIN_CHARS.indexOf(first14[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/**
 * Why a normalised tax ID is not valid for a country, or null when it is. `countryCode` null
 * applies the generic rule only.
 */
export function taxIdProblem(countryCode: string | null | undefined, taxId: string): string | null {
  if (!GENERIC_TAX_ID_PATTERN.test(taxId)) return "Tax registration number must be 5-20 letters or digits.";
  switch (countryCode) {
    case "IN":
      if (!GSTIN_PATTERN.test(taxId)) {
        return "GSTIN must be 15 characters: 2-digit state code, 10-character PAN, entity number, Z and a check character.";
      }
      if (!GST_STATES[taxId.slice(0, 2)]) return `GSTIN state code '${taxId.slice(0, 2)}' is not a GST state code.`;
      if (gstinCheckCharacter(taxId.slice(0, 14)) !== taxId[14]) {
        return "GSTIN check character does not match; check it for a typo.";
      }
      return null;
    case "SA":
      return /^3\d{13}3$/.test(taxId) ? null : "Saudi VAT number must be 15 digits, starting and ending with 3.";
    case "AE":
    case "BH":
      return /^\d{15}$/.test(taxId) ? null : "Tax registration number must be 15 digits.";
    default:
      return null;
  }
}

/** The GST state code a GSTIN belongs to (its first two digits). */
export const gstinStateCode = (gstin: string): string => gstin.slice(0, 2);
