/**
 * Purpose: Supported countries and currencies.
 * v1 targets the GCC. An organization trades in exactly one currency, and every store must be in
 * a country that uses it, so money never needs conversion. India is kept so organizations created
 * before the GCC switch (currency "INR") stay valid.
 *
 * `decimals` is the number of minor units (BHD has 1000 fils, so 3). Money is stored as an integer
 * count of minor units and the decimals are always read from here, never assumed to be 2.
 */

export interface CurrencyDefinition {
  code: string;
  name: string;
  decimals: number;
}

export interface CountryDefinition {
  code: string;
  name: string;
  currency: string;
  /** Standard VAT/GST rate seeded as the organization's default tax rate. Null = no VAT. */
  standardTaxRate: { name: string; rate: number } | null;
}

export const CURRENCIES: Record<string, CurrencyDefinition> = {
  BHD: { code: "BHD", name: "Bahraini Dinar", decimals: 3 },
  KWD: { code: "KWD", name: "Kuwaiti Dinar", decimals: 3 },
  OMR: { code: "OMR", name: "Omani Rial", decimals: 3 },
  AED: { code: "AED", name: "UAE Dirham", decimals: 2 },
  QAR: { code: "QAR", name: "Qatari Riyal", decimals: 2 },
  SAR: { code: "SAR", name: "Saudi Riyal", decimals: 2 },
  INR: { code: "INR", name: "Indian Rupee", decimals: 2 },
};

export const COUNTRIES: Record<string, CountryDefinition> = {
  BH: { code: "BH", name: "Bahrain", currency: "BHD", standardTaxRate: { name: "VAT", rate: 10 } },
  KW: { code: "KW", name: "Kuwait", currency: "KWD", standardTaxRate: null },
  OM: { code: "OM", name: "Oman", currency: "OMR", standardTaxRate: { name: "VAT", rate: 5 } },
  AE: { code: "AE", name: "United Arab Emirates", currency: "AED", standardTaxRate: { name: "VAT", rate: 5 } },
  QA: { code: "QA", name: "Qatar", currency: "QAR", standardTaxRate: null },
  SA: { code: "SA", name: "Saudi Arabia", currency: "SAR", standardTaxRate: { name: "VAT", rate: 15 } },
  // GST is split into components (CGST/SGST/IGST) and is not seeded; added when India is targeted.
  IN: { code: "IN", name: "India", currency: "INR", standardTaxRate: null },
};

export const DEFAULT_CURRENCY = "BHD";

export const CURRENCY_CODES = Object.keys(CURRENCIES) as [string, ...string[]];
export const COUNTRY_CODES = Object.keys(COUNTRIES) as [string, ...string[]];

export function getCurrency(code: string): CurrencyDefinition {
  const currency = CURRENCIES[code];
  if (!currency) {
    throw new Error(`Unsupported currency: ${code}`);
  }
  return currency;
}

/** The country whose currency is `currencyCode` (one-to-one in v1). */
export function getCountryForCurrency(currencyCode: string): CountryDefinition | undefined {
  return Object.values(COUNTRIES).find((country) => country.currency === currencyCode);
}
