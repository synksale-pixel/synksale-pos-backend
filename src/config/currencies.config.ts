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

export interface SeedTaxRate {
  name: string;
  components: { name: string; rate: number }[];
}

/**
 * Ways a sale can be paid at the till. A fixed set: no card-terminal or wallet integration in v1.
 * `wallet` is any digital wallet or instant payment (UPI in India, BenefitPay, STC Pay...); the
 * till labels it per country. Not the vendor payment methods, which live in bill.validator.
 */
export const SALE_PAYMENT_METHODS = ["cash", "card", "wallet", "bank_transfer"] as const;
export type SalePaymentMethod = (typeof SALE_PAYMENT_METHODS)[number];

export interface CountryDefinition {
  code: string;
  name: string;
  currency: string;
  /** Tax rates seeded for a new organization; the first becomes its default. Empty = no VAT. */
  defaultTaxRates: SeedTaxRate[];
  /** First month (1-12) of the fiscal year: receipt numbers restart then. India April, else January. */
  fiscalYearStartMonth: number;
  /** Payment methods enabled for a new organization in this country (cash is always enabled). */
  defaultPaymentMethods: SalePaymentMethod[];
}

const ALL_PAYMENTS: SalePaymentMethod[] = [...SALE_PAYMENT_METHODS];

const vat = (rate: number): SeedTaxRate[] => [{ name: `VAT ${rate}%`, components: [{ name: "VAT", rate }] }];

/** GST split equally into CGST + SGST: till sales are always intra-state in v1. */
const gst = (rate: number): SeedTaxRate => ({
  name: `GST ${rate}%`,
  components: [
    { name: "CGST", rate: rate / 2 },
    { name: "SGST", rate: rate / 2 },
  ],
});

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
  BH: { code: "BH", name: "Bahrain", currency: "BHD", defaultTaxRates: vat(10), fiscalYearStartMonth: 1, defaultPaymentMethods: ALL_PAYMENTS },
  KW: { code: "KW", name: "Kuwait", currency: "KWD", defaultTaxRates: [], fiscalYearStartMonth: 1, defaultPaymentMethods: ALL_PAYMENTS },
  OM: { code: "OM", name: "Oman", currency: "OMR", defaultTaxRates: vat(5), fiscalYearStartMonth: 1, defaultPaymentMethods: ALL_PAYMENTS },
  AE: { code: "AE", name: "United Arab Emirates", currency: "AED", defaultTaxRates: vat(5), fiscalYearStartMonth: 1, defaultPaymentMethods: ALL_PAYMENTS },
  QA: { code: "QA", name: "Qatar", currency: "QAR", defaultTaxRates: [], fiscalYearStartMonth: 1, defaultPaymentMethods: ALL_PAYMENTS },
  SA: { code: "SA", name: "Saudi Arabia", currency: "SAR", defaultTaxRates: vat(15), fiscalYearStartMonth: 1, defaultPaymentMethods: ALL_PAYMENTS },
  IN: { code: "IN", name: "India", currency: "INR", defaultTaxRates: [gst(18), gst(5)], fiscalYearStartMonth: 4, defaultPaymentMethods: ALL_PAYMENTS },
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

/** The sales defaults a new organization gets from its currency's country. */
export function countrySalesDefaults(currencyCode: string) {
  const country = getCountryForCurrency(currencyCode);
  return {
    fiscalYearStartMonth: country?.fiscalYearStartMonth ?? 1,
    paymentMethods: [...(country?.defaultPaymentMethods ?? ["cash"])] as SalePaymentMethod[],
  };
}
