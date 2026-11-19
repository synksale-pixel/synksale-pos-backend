/**
 * Purpose: Phase 4a-1 rules that need no database: country-aware tax IDs (GSTIN check
 * character, Saudi and 15-digit TRNs), the new store, organization and product fields, and the
 * per-currency cash rounding and per-country defaults.
 */

import { describe, expect, it } from "vitest";
import { gstinCheckCharacter, normalizeTaxId, taxIdProblem } from "../../src/utils/taxId";
import { createStoreSchema, updateStoreSchema } from "../../src/validators/store.validator";
import { updateOrganizationSchema } from "../../src/validators/organization.validator";
import { createProductSchema, hsnOrSacProblem, updateProductSchema } from "../../src/validators/product.validator";
import { COUNTRIES, CURRENCIES } from "../../src/config/currencies.config";
import { GST_STATES } from "../../src/config/gstStates.config";
import { fiscalYearOf, formatSaleNumber } from "../../src/services/documentNumber.service";
import { singleExample, serviceExample } from "../../src/docs/product.openapi";

const VALID_GSTIN = "29ABCDE1234F1ZW";
const issues = (result: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);

describe("tax IDs", () => {
  it("normalises spaces, hyphens and case", () => {
    expect(normalizeTaxId(" 29abcde-1234 f1zw ")).toBe(VALID_GSTIN);
  });

  it("checks the GSTIN check character on known numbers", () => {
    expect(gstinCheckCharacter("27AAPFU0939F1Z")).toBe("V");
    expect(taxIdProblem("IN", "27AAPFU0939F1ZV")).toBeNull();
    expect(taxIdProblem("IN", VALID_GSTIN)).toBeNull();
    expect(taxIdProblem("IN", "29ABCDE1234F1ZX")).toMatch(/check character/);
  });

  it("refuses a GSTIN with a bad shape or an unknown state code", () => {
    expect(taxIdProblem("IN", "220000123400002")).toMatch(/GSTIN must be 15 characters/);
    const badState = "99ABCDE1234F1Z";
    expect(taxIdProblem("IN", badState + gstinCheckCharacter(badState))).toMatch(/not a GST state code/);
  });

  it("Saudi VAT numbers are 15 digits starting and ending with 3; AE and BH are 15 digits", () => {
    expect(taxIdProblem("SA", "300000000000003")).toBeNull();
    expect(taxIdProblem("SA", "200000000000003")).toMatch(/starting and ending with 3/);
    expect(taxIdProblem("AE", "100000000000003")).toBeNull();
    expect(taxIdProblem("BH", "22000012340000")).toMatch(/15 digits/);
  });

  it("other countries and an unknown country use the generic rule", () => {
    expect(taxIdProblem("KW", "AB123")).toBeNull();
    expect(taxIdProblem(null, "AB12")).toMatch(/5-20/);
  });

  it("every GST state code is two digits", () => {
    for (const code of Object.keys(GST_STATES)) expect(code).toMatch(/^\d{2}$/);
  });
});

describe("store fields", () => {
  const base = {
    name: "Indiranagar",
    code: "BLR-1",
    address: { line1: "12 100 Feet Rd", city: "Bengaluru", state: "Karnataka", country: "India", postalCode: "560038", stateCode: "29" },
    countryCode: "IN",
    timezone: "Asia/Kolkata",
  };

  it("accepts the receipt header, tax ID and invoice prefix, normalised", () => {
    const parsed = createStoreSchema.parse({
      ...base,
      taxRegistrationNumber: "29abcde1234f1zw",
      invoicePrefix: "blr1",
      phone: "+91 80 4000 0000",
      email: "Store@Example.IN",
      legalName: "Sharma Traders Pvt Ltd",
      receipt: { headerText: "Welcome", footerText: null },
    });
    expect(parsed).toMatchObject({ taxRegistrationNumber: VALID_GSTIN, invoicePrefix: "BLR1", email: "store@example.in" });
  });

  it("checks the tax ID against the store's country and the GSTIN against its state", () => {
    expect(issues(createStoreSchema.safeParse({ ...base, taxRegistrationNumber: "29ABCDE1234F1ZX" }))).toEqual([
      "taxRegistrationNumber: GSTIN check character does not match; check it for a typo.",
    ]);
    const otherState = "27ABCDE1234F1Z" + gstinCheckCharacter("27ABCDE1234F1Z");
    expect(issues(createStoreSchema.safeParse({ ...base, taxRegistrationNumber: otherState }))).toEqual([
      "taxRegistrationNumber: GSTIN must start with the store's stateCode (29).",
    ]);
  });

  it("stateCode is only for India", () => {
    const bahrain = { ...base, countryCode: "BH", timezone: "Asia/Bahrain" };
    expect(issues(createStoreSchema.safeParse(bahrain))).toEqual(["address.stateCode: stateCode is only for stores in India."]);
    expect(issues(updateStoreSchema.safeParse({ address: { stateCode: "30" } }))).toEqual([]);
    expect(issues(updateStoreSchema.safeParse({ address: { stateCode: "3" } }))[0]).toMatch(/two-digit GST state code/);
  });

  it("invoicePrefix is 1-5 letters or digits; receipt texts have limits; unknown receipt fields are refused", () => {
    expect(issues(updateStoreSchema.safeParse({ invoicePrefix: "SEEF-1" }))[0]).toMatch(/1-5 letters or digits/);
    expect(issues(updateStoreSchema.safeParse({ receipt: { footerText: "x".repeat(501) } }))[0]).toMatch(/at most 500/);
    expect(issues(updateStoreSchema.safeParse({ receipt: { logo: "x" } }))[0]).toMatch(/Unknown receipt field/);
  });
});

describe("organization settings", () => {
  it("accepts fiscal year, payment methods, cash rounding and discount cap", () => {
    const parsed = updateOrganizationSchema.parse({
      legalNameAr: "شركة النور للتجارة",
      settings: {
        fiscalYearStartMonth: 4,
        sales: { paymentMethods: ["cash", "wallet"], cashRounding: "1.00", maxDiscountPercent: 12.5 },
      },
    });
    expect(parsed.settings?.sales?.paymentMethods).toEqual(["cash", "wallet"]);
  });

  it("refuses a bad month, missing cash, repeats, unknown methods, a bad step and a bad cap", () => {
    const bad = (settings: Record<string, unknown>) => issues(updateOrganizationSchema.safeParse({ settings }))[0];
    expect(bad({ fiscalYearStartMonth: 13 })).toMatch(/1-12/);
    expect(bad({ sales: { paymentMethods: ["card"] } })).toMatch(/cash cannot be disabled/);
    expect(bad({ sales: { paymentMethods: ["cash", "cash"] } })).toMatch(/must not repeat/);
    expect(bad({ sales: { paymentMethods: ["cash", "upi"] } })).toMatch(/payment methods must be from/);
    expect(bad({ sales: { cashRounding: "quarter" } })).toMatch(/decimal amount/);
    expect(bad({ sales: { maxDiscountPercent: 100.5 } })).toMatch(/0-100/);
    expect(bad({ sales: { maxDiscountPercent: 10.125 } })).toMatch(/2 decimals/);
  });

  it("every currency has rounding steps in its own precision and every country has defaults", () => {
    for (const currency of Object.values(CURRENCIES)) {
      expect(currency.cashRoundingSteps.length).toBeGreaterThan(0);
      for (const step of currency.cashRoundingSteps) expect(step.split(".")[1]?.length).toBe(currency.decimals);
    }
    for (const country of Object.values(COUNTRIES)) {
      expect(country.defaultPaymentMethods).toContain("cash");
      expect(country.fiscalYearStartMonth).toBe(country.code === "IN" ? 4 : 1);
    }
  });
});

describe("product fields", () => {
  it("HSN for goods and SAC for services", () => {
    expect(hsnOrSacProblem("goods", "6109")).toBeNull();
    expect(hsnOrSacProblem("goods", "61091000")).toBeNull();
    expect(hsnOrSacProblem("goods", "61091")).not.toBeNull();
    expect(hsnOrSacProblem("goods", "998313")).not.toBeNull();
    expect(hsnOrSacProblem("service", "998313")).toBeNull();
    expect(hsnOrSacProblem("service", "6109")).not.toBeNull();
  });

  it("create checks the code against the type; update checks the shape only", () => {
    const goods = { ...singleExample, categoryId: undefined, taxRateId: undefined, barcodes: undefined };
    expect(issues(createProductSchema.safeParse({ ...goods, hsnOrSac: "61091000", nameAr: "تيشيرت" }))).toEqual([]);
    expect(issues(createProductSchema.safeParse({ ...serviceExample, hsnOrSac: "61091000" }))).toEqual([
      "hsnOrSac: A service takes a 6-digit SAC starting with 99.",
    ]);
    expect(issues(updateProductSchema.safeParse({ hsnOrSac: "12ab" }))[0]).toMatch(/4-8 digits/);
    expect(issues(updateProductSchema.safeParse({ hsnOrSac: null, nameAr: null }))).toEqual([]);
  });
});

describe("sale numbering helpers", () => {
  it("works out the fiscal year from the store's local date", () => {
    // India, April start: 31 March belongs to the year that began the previous April.
    expect(fiscalYearOf(new Date("2027-03-31T12:00:00Z"), 4, "Asia/Kolkata")).toBe(2026);
    expect(fiscalYearOf(new Date("2027-04-01T00:00:00+05:30"), 4, "Asia/Kolkata")).toBe(2027);
    // 22:30 UTC on 31 March is already 1 April in India.
    expect(fiscalYearOf(new Date("2027-03-31T22:30:00Z"), 4, "Asia/Kolkata")).toBe(2027);
    // January start: the calendar year, by the store's clock (Bahrain is UTC+3).
    expect(fiscalYearOf(new Date("2026-12-31T21:30:00Z"), 1, "Asia/Bahrain")).toBe(2027);
    expect(fiscalYearOf(new Date("2026-12-31T20:30:00Z"), 1, "Asia/Bahrain")).toBe(2026);
  });

  it("formats invoice and credit note numbers within India's 16 characters", () => {
    expect(formatSaleNumber("SEEF", 2026, 123, "invoice")).toBe("SEEF-26-000123");
    expect(formatSaleNumber("SEEF", 2026, 45, "credit_note")).toBe("SEEF-26-R000045");
    expect(formatSaleNumber("ABCDE", 2030, 999999, "credit_note").length).toBeLessThanOrEqual(16);
  });

  it("seeds GST as equal CGST + SGST halves in India and VAT elsewhere", () => {
    expect(COUNTRIES.IN.defaultTaxRates.map((rate) => rate.name)).toEqual(["GST 18%", "GST 5%"]);
    expect(COUNTRIES.IN.defaultTaxRates[1].components).toEqual([
      { name: "CGST", rate: 2.5 },
      { name: "SGST", rate: 2.5 },
    ]);
    expect(COUNTRIES.BH.defaultTaxRates).toEqual([{ name: "VAT 10%", components: [{ name: "VAT", rate: 10 }] }]);
    expect(COUNTRIES.KW.defaultTaxRates).toEqual([]);
  });
});
