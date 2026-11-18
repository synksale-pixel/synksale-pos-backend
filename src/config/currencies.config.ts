/**
 * Purpose: Supported countries and currencies.
 * v1 targets the GCC, Saudi Arabia and India. An organization trades in exactly one currency, and
 * every store must be in a country that uses it, so money never needs conversion.
 *
 * `decimals` is the number of minor units (BHD has 1000 fils, so 3). Money is stored as an integer
 * count of minor units and the decimals are always read from here, never assumed to be 2.
 */

export interface CurrencyDefinition {
  code: string;
  name: string;
  decimals: number;
  /**
   * Cash rounding steps an organization may choose (settings.sales.cashRounding), as decimal
   * strings in this currency. Applied to the cash tender only, never to invoice or VAT totals.
   */
  cashRoundingSteps: string[];
}

export interface CountryDefinition {
  code: string;
  name: string;
  currency: string;
  /** Standard VAT/GST rate seeded as the organization's default tax rate. Null = no VAT. */
  standardTaxRate: { name: string; rate: number } | null;
  /** First month (1-12) of the fiscal year: receipt numbers restart then. India April, else January. */
  fiscalYearStartMonth: number;
  /** Payment methods enabled for a new organization in this country (cash is always enabled). */
  defaultPaymentMethods: PaymentMethod[];
}

/** Ways a sale can be paid at the till. A fixed set: no card-terminal or wallet integration in v1. */
export const PAYMENT_METHODS = ["cash", "card", "upi", "bank_transfer"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
const GCC_PAYMENTS: PaymentMethod[] = ["cash", "card", "bank_transfer"];

export const CURRENCIES: Record<string, CurrencyDefinition> = {
  BHD: { code: "BHD", name: "Bahraini Dinar", decimals: 3, cashRoundingSteps: ["0.005", "0.010", "0.050", "0.100"] },
  KWD: { code: "KWD", name: "Kuwaiti Dinar", decimals: 3, cashRoundingSteps: ["0.005", "0.010", "0.050", "0.100"] },
  OMR: { code: "OMR", name: "Omani Rial", decimals: 3, cashRoundingSteps: ["0.005", "0.010", "0.050", "0.100"] },
  AED: { code: "AED", name: "UAE Dirham", decimals: 2, cashRoundingSteps: ["0.25"] },
  QAR: { code: "QAR", name: "Qatari Riyal", decimals: 2, cashRoundingSteps: ["0.25", "0.50", "1.00"] },
  SAR: { code: "SAR", name: "Saudi Riyal", decimals: 2, cashRoundingSteps: ["0.05", "0.10", "0.25", "0.50", "1.00"] },
  INR: { code: "INR", name: "Indian Rupee", decimals: 2, cashRoundingSteps: ["0.50", "1.00"] },
};

export const COUNTRIES: Record<string, CountryDefinition> = {
  BH: { code: "BH", name: "Bahrain", currency: "BHD", standardTaxRate: { name: "VAT", rate: 10 }, fiscalYearStartMonth: 1, defaultPaymentMethods: GCC_PAYMENTS },
  KW: { code: "KW", name: "Kuwait", currency: "KWD", standardTaxRate: null, fiscalYearStartMonth: 1, defaultPaymentMethods: GCC_PAYMENTS },
  OM: { code: "OM", name: "Oman", currency: "OMR", standardTaxRate: { name: "VAT", rate: 5 }, fiscalYearStartMonth: 1, defaultPaymentMethods: GCC_PAYMENTS },
  AE: { code: "AE", name: "United Arab Emirates", currency: "AED", standardTaxRate: { name: "VAT", rate: 5 }, fiscalYearStartMonth: 1, defaultPaymentMethods: GCC_PAYMENTS },
  QA: { code: "QA", name: "Qatar", currency: "QAR", standardTaxRate: null, fiscalYearStartMonth: 1, defaultPaymentMethods: GCC_PAYMENTS },
  SA: { code: "SA", name: "Saudi Arabia", currency: "SAR", standardTaxRate: { name: "VAT", rate: 15 }, fiscalYearStartMonth: 1, defaultPaymentMethods: GCC_PAYMENTS },
  // GST is split into components (CGST + SGST): the 4a-1 implementation seeds "GST 18%" (default)
  // and "GST 5%" with two equal components; until then nothing is seeded.
  IN: { code: "IN", name: "India", currency: "INR", standardTaxRate: null, fiscalYearStartMonth: 4, defaultPaymentMethods: ["cash", "card", "upi", "bank_transfer"] },
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
