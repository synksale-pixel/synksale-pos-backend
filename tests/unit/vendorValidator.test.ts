/**
 * Purpose: Pins the Phase 3a vendor contract (src/validators/vendor.validator.ts and the
 * preferredVendorId field in product.validator.ts) before vendors exist: the documented Swagger
 * examples must parse, and every rule the frontend relies on must hold.
 */

import { describe, it, expect } from "vitest";
import { createVendorSchema, listVendorsQuerySchema, updateVendorSchema } from "../../src/validators/vendor.validator";
import { createProductSchema, updateProductSchema } from "../../src/validators/product.validator";
import { foreignVendorExample, minimalVendorExample, vendorExample } from "../../src/docs/vendor.openapi";
import { singleExample } from "../../src/docs/product.openapi";
import { ISO_COUNTRY_CODES } from "../../src/config/isoCountries.config";
import { COUNTRY_CODES } from "../../src/config/currencies.config";

type Parsed = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };

function issues(result: Parsed) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
}

function rejected(result: Parsed, fragment: string) {
  expect(result.success).toBe(false);
  expect(issues(result)).toContain(fragment);
}

const VENDOR_ID = "665f1c2e8a4b3c0012ab3900";

describe("documented examples", () => {
  it("the local, minimal and foreign vendor examples are valid", () => {
    for (const example of [vendorExample, minimalVendorExample, foreignVendorExample]) {
      expect(issues(createVendorSchema.safeParse(example))).toBe("");
    }
  });
});

describe("create vendor", () => {
  it("requires a non-blank name of at most 120 characters", () => {
    rejected(createVendorSchema.safeParse({}), "name");
    rejected(createVendorSchema.safeParse({ name: "   " }), "Vendor name is required.");
    rejected(createVendorSchema.safeParse({ name: "x".repeat(121) }), "at most 120");
    expect(createVendorSchema.parse({ name: "  Al Safa  " }).name).toBe("Al Safa");
  });

  it("normalises the TRN like the organization's and rejects malformed ones", () => {
    expect(createVendorSchema.parse({ name: "V", taxRegistrationNumber: "2200-0098 7600003" }).taxRegistrationNumber).toBe(
      "220000987600003"
    );
    rejected(createVendorSchema.safeParse({ name: "V", taxRegistrationNumber: "12" }), "5-20 letters or digits");
    rejected(createVendorSchema.safeParse({ name: "V", taxRegistrationNumber: "2200#0098" }), "5-20 letters or digits");
    expect(createVendorSchema.parse({ name: "V", taxRegistrationNumber: null }).taxRegistrationNumber).toBeNull();
  });

  it("accepts any assigned ISO country, uppercased, and rejects everything else", () => {
    expect(createVendorSchema.parse({ name: "V", countryCode: "cn" }).countryCode).toBe("CN");
    expect(createVendorSchema.parse({ name: "V", countryCode: " gb " }).countryCode).toBe("GB");
    for (const countryCode of ["IN", "AE", "SA", "US", "DE"]) {
      expect(createVendorSchema.safeParse({ name: "V", countryCode }).success, countryCode).toBe(true);
    }
    // UK is not an ISO code (GB is); XX and EU are not countries.
    for (const countryCode of ["UK", "XX", "EU", "CHN", "C", "12", "Bahrain"]) {
      rejected(createVendorSchema.safeParse({ name: "V", countryCode }), "ISO 3166-1 alpha-2");
    }
    rejected(createVendorSchema.safeParse({ name: "V", countryCode: null }), "countryCode");
  });

  it("the ISO list has the 249 assigned codes, no duplicates, and covers every store country", () => {
    expect(ISO_COUNTRY_CODES).toHaveLength(249);
    expect(new Set(ISO_COUNTRY_CODES).size).toBe(249);
    for (const code of COUNTRY_CODES) {
      expect(ISO_COUNTRY_CODES, code).toContain(code);
    }
  });

  it("takes an optional VAT treatment from the fixed list", () => {
    for (const vatTreatment of ["not_registered", "overseas"]) {
      expect(createVendorSchema.safeParse({ name: "V", vatTreatment }).success, vatTreatment).toBe(true);
    }
    rejected(createVendorSchema.safeParse({ name: "V", vatTreatment: "reverse_charge" }), "vatTreatment must be one of");
    expect(createVendorSchema.parse({ name: "V" }).vatTreatment).toBeUndefined();
  });

  it("vat_registered needs a TRN", () => {
    rejected(createVendorSchema.safeParse({ name: "V", vatTreatment: "vat_registered" }), "needs a taxRegistrationNumber");
    rejected(
      createVendorSchema.safeParse({ name: "V", vatTreatment: "vat_registered", taxRegistrationNumber: null }),
      "needs a taxRegistrationNumber"
    );
    expect(
      createVendorSchema.safeParse({ name: "V", vatTreatment: "vat_registered", taxRegistrationNumber: "220000987600003" }).success
    ).toBe(true);
  });

  it("validates and lowercases email, and validates phone", () => {
    expect(createVendorSchema.parse({ name: "V", email: " Orders@Gulf.BH " }).email).toBe("orders@gulf.bh");
    rejected(createVendorSchema.safeParse({ name: "V", email: "not-an-email" }), "Invalid vendor email format.");
    rejected(createVendorSchema.safeParse({ name: "V", phone: "abc" }), "Invalid vendor phone number format.");
    expect(createVendorSchema.parse({ name: "V", phone: "+973 1700-1234" }).phone).toBe("+973 1700-1234");
  });

  it("takes payment terms as whole days 0-365", () => {
    expect(createVendorSchema.parse({ name: "V", paymentTermsDays: 0 }).paymentTermsDays).toBe(0);
    expect(createVendorSchema.parse({ name: "V", paymentTermsDays: 365 }).paymentTermsDays).toBe(365);
    rejected(createVendorSchema.safeParse({ name: "V", paymentTermsDays: -1 }), "cannot be negative");
    rejected(createVendorSchema.safeParse({ name: "V", paymentTermsDays: 366 }), "at most 365");
    rejected(createVendorSchema.safeParse({ name: "V", paymentTermsDays: 7.5 }), "whole number");
    rejected(createVendorSchema.safeParse({ name: "V", paymentTermsDays: "30" }), "must be a number");
  });

  it("rejects empty strings for optional text (null clears instead)", () => {
    for (const field of ["legalName", "contactName", "notes"]) {
      rejected(createVendorSchema.safeParse({ name: "V", [field]: "  " }), "Send null to clear it.");
      expect(createVendorSchema.safeParse({ name: "V", [field]: null }).success, field).toBe(true);
    }
  });

  it("takes a partial address and rejects unknown address fields, including country", () => {
    expect(createVendorSchema.safeParse({ name: "V", address: { city: "Dubai" } }).success).toBe(true);
    rejected(createVendorSchema.safeParse({ name: "V", address: { city: "Dubai", country: "UAE" } }), "Unknown address field");
    rejected(createVendorSchema.safeParse({ name: "V", address: { line1: "x".repeat(201) } }), "at most 200");
  });

  it("rejects unknown fields, including a currency (bills are in the organization's currency in v1)", () => {
    rejected(createVendorSchema.safeParse({ name: "V", currency: "USD" }), "Unknown field");
    rejected(createVendorSchema.safeParse({ name: "V", organizationId: VENDOR_ID }), "Unknown field");
  });
});

describe("update vendor", () => {
  it("needs at least one field", () => {
    rejected(updateVendorSchema.safeParse({}), "At least one field");
  });

  it("allows a single field, deactivation and clearing", () => {
    expect(updateVendorSchema.safeParse({ paymentTermsDays: 45 }).success).toBe(true);
    expect(updateVendorSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updateVendorSchema.safeParse({ taxRegistrationNumber: null, address: null }).success).toBe(true);
  });

  it("refuses vat_registered with the TRN cleared in the same request, and leaves other combinations to the service", () => {
    rejected(updateVendorSchema.safeParse({ vatTreatment: "vat_registered", taxRegistrationNumber: null }), "needs a taxRegistrationNumber");
    // Without the TRN in the body the stored one decides, which only the service knows.
    expect(updateVendorSchema.safeParse({ vatTreatment: "vat_registered" }).success).toBe(true);
    expect(updateVendorSchema.safeParse({ taxRegistrationNumber: null, vatTreatment: "not_registered" }).success).toBe(true);
  });

  it("does not let the name be cleared", () => {
    rejected(updateVendorSchema.safeParse({ name: null }), "name");
    rejected(updateVendorSchema.safeParse({ name: "" }), "Vendor name is required.");
  });
});

describe("list vendors query", () => {
  it("accepts the documented filters", () => {
    expect(
      listVendorsQuerySchema.safeParse({ search: "gulf", isActive: "true", countryCode: "BH", vatTreatment: "overseas", page: 1, limit: 20 })
        .success
    ).toBe(true);
  });

  it("uppercases and checks the country filter, and checks the VAT filter", () => {
    expect(listVendorsQuerySchema.parse({ countryCode: "cn" }).countryCode).toBe("CN");
    rejected(listVendorsQuerySchema.safeParse({ countryCode: "UK" }), "ISO 3166-1 alpha-2");
    rejected(listVendorsQuerySchema.safeParse({ vatTreatment: "exempt" }), "vatTreatment must be one of");
  });
});

describe("preferred vendor on the product form", () => {
  it("accepts a vendor id or null on create and update", () => {
    const withVendor = { ...singleExample, purchase: { costPrice: "1.600", preferredVendorId: VENDOR_ID } };
    expect(issues(createProductSchema.safeParse(withVendor))).toBe("");
    expect(updateProductSchema.safeParse({ purchase: { preferredVendorId: null } }).success).toBe(true);
  });

  it("rejects a malformed vendor id", () => {
    rejected(updateProductSchema.safeParse({ purchase: { preferredVendorId: "abc" } }), "preferredVendorId must be a 24-character hex id.");
  });
});
