/**
 * Purpose: Customer phone matching key (Phase 4a-2).
 *
 * A cashier types a number however the customer says it: "+973 3600 1234", "0097336001234",
 * "36001234", "050 123 4567" (UAE), "+91 98450 12345". All forms of one number must give the
 * same key, so the key is the NATIONAL number of the organization's country:
 *
 * 1. Keep digits only. A leading "+" or "00" marks the number as international.
 * 2. International and starting with the country's calling code: drop the code. International
 *    with another code: a foreign number, kept whole with its own code, prefixed "+" so it can
 *    never collide with a national number.
 * 3. Not international, but the digits are the calling code followed by a full national number
 *    (people often leave out the +): drop the code.
 * 4. Countries dialled with a trunk 0 (AE, SA, IN): drop one leading 0. National numbers there
 *    never start with 0, so this is safe on partial input too.
 *
 * The same function normalises stored numbers (unique per organization) and lookup input
 * (exact match, then "starts with"), so partial typing like "3600" or "+97336" matches.
 */

import { CountryDefinition } from "../config/currencies.config";

type PhoneCountry = Pick<CountryDefinition, "callingCode" | "nationalNumberLength" | "trunkZero">;

export function phoneKey(raw: string, country: PhoneCountry): string {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  let international = trimmed.startsWith("+");
  if (!international && digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }

  const { callingCode, nationalNumberLength, trunkZero } = country;
  if (international) {
    if (!digits.startsWith(callingCode)) return `+${digits}`;
    digits = digits.slice(callingCode.length);
  } else if (
    digits.startsWith(callingCode) &&
    digits.length === callingCode.length + nationalNumberLength
  ) {
    digits = digits.slice(callingCode.length);
  }

  if (trunkZero && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

/** Digits the lookup needs before it searches (the starts-with search is useless below this). */
export const PHONE_LOOKUP_MIN_DIGITS = 4;
