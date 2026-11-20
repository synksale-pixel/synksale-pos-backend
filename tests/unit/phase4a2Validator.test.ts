/**
 * Purpose: Pins the Phase 4a-2 contract (registers, customers, till) before the routes exist:
 * the Swagger examples must parse, phone normalisation must give one key per number, and every
 * rule the frontend relies on must hold.
 */

import { describe, expect, it } from "vitest";
import { COUNTRIES } from "../../src/config/currencies.config";
import { phoneKey } from "../../src/utils/phone";
import { taxIdProblem } from "../../src/utils/taxId";
import { createRegisterSchema, updateRegisterSchema } from "../../src/validators/register.validator";
import {
  createCustomerSchema,
  CUSTOMER_IMPORT_MAX_ROWS,
  importCustomersSchema,
  updateCustomerSchema,
} from "../../src/validators/customer.validator";
import { registerExample, updateRegisterExample } from "../../src/docs/register.openapi";
import {
  businessCustomerExample,
  customerExample,
  importCustomersExample,
  indiaBusinessCustomerExample,
  updateCustomerExample,
} from "../../src/docs/customer.openapi";

const fails = (result: { success: boolean }) => expect(result.success).toBe(false);

describe("phoneKey", () => {
  const { BH, AE, SA, IN } = COUNTRIES;

  it("gives every written form of one Bahrain number the same key", () => {
    for (const raw of ["+973 3600 1234", "0097336001234", "36001234", "973-3600-1234", "(+973) 3600 1234", " 3600 1234 "]) {
      expect(phoneKey(raw, BH), raw).toBe("36001234");
    }
  });

  it("drops the trunk 0 where numbers are dialled with one (AE, SA, IN)", () => {
    expect(phoneKey("050 123 4567", AE)).toBe("501234567");
    expect(phoneKey("+971 50 123 4567", AE)).toBe("501234567");
    expect(phoneKey("0551234567", SA)).toBe("551234567");
    expect(phoneKey("+966 55 123 4567", SA)).toBe("551234567");
    expect(phoneKey("098450 12345", IN)).toBe("9845012345");
    expect(phoneKey("+91 98450 12345", IN)).toBe("9845012345");
    expect(phoneKey("919845012345", IN)).toBe("9845012345");
  });

  it("keeps a foreign number whole, marked so it never equals a national number", () => {
    expect(phoneKey("+91 98450 12345", BH)).toBe("+919845012345");
    expect(phoneKey("0044 20 7946 0958", BH)).toBe("+442079460958");
  });

  it("does not strip a calling code that is really the start of a national number", () => {
    // 97312345 is a full 8-digit Bahrain number, not 973 + a 5-digit number.
    expect(phoneKey("97312345", BH)).toBe("97312345");
  });

  it("normalises partial input the same way, so starts-with matching works while typing", () => {
    expect(phoneKey("+973 36", BH)).toBe("36");
    expect(phoneKey("3600", BH)).toBe("3600");
    expect(phoneKey("050 1", AE)).toBe("501");
    expect("36001234".startsWith(phoneKey("+97336", BH))).toBe(true);
  });
});

describe("registers", () => {
  it("parses the Swagger examples", () => {
    expect(createRegisterSchema.safeParse(registerExample).success).toBe(true);
    expect(updateRegisterSchema.safeParse(updateRegisterExample).success).toBe(true);
  });

  it("trims the name and rejects blank, long or unknown fields", () => {
    expect(createRegisterSchema.parse({ name: "  Counter 1 " }).name).toBe("Counter 1");
    fails(createRegisterSchema.safeParse({ name: "  " }));
    fails(createRegisterSchema.safeParse({ name: "x".repeat(51) }));
    fails(createRegisterSchema.safeParse({ name: "A", storeId: "665f1c2e8a4b3c0012ab3400" }));
    fails(updateRegisterSchema.safeParse({}));
  });
});

describe("customers", () => {
  it("parses the Swagger examples", () => {
    for (const example of [customerExample, businessCustomerExample, indiaBusinessCustomerExample]) {
      expect(createCustomerSchema.safeParse(example).success).toBe(true);
    }
    expect(updateCustomerSchema.safeParse(updateCustomerExample).success).toBe(true);
    expect(importCustomersSchema.safeParse(importCustomersExample).success).toBe(true);
  });

  it("the example tax numbers pass their country's rules", () => {
    expect(taxIdProblem("BH", businessCustomerExample.taxRegistrationNumber)).toBeNull();
    expect(taxIdProblem("IN", indiaBusinessCustomerExample.taxRegistrationNumber)).toBeNull();
  });

  it("needs name and phone, and checks the phone format", () => {
    fails(createCustomerSchema.safeParse({ name: "Ali" }));
    fails(createCustomerSchema.safeParse({ phone: "36001234" }));
    fails(createCustomerSchema.safeParse({ name: "Ali", phone: "12" }));
    fails(createCustomerSchema.safeParse({ name: "Ali", phone: "3600-ABCD" }));
  });

  it("normalises the tax number and email", () => {
    const parsed = createCustomerSchema.parse({ ...customerExample, taxRegistrationNumber: "2200-0055 5500003", email: " A@B.BH " });
    expect(parsed.taxRegistrationNumber).toBe("220000555500003");
    expect(parsed.email).toBe("a@b.bh");
  });

  it("has no loyalty points, wallet balance or stateCode input", () => {
    for (const extra of [{ loyaltyPoints: 10 }, { walletBalance: "1.000" }, { stateCode: "29" }, { saleCount: 0 }]) {
      fails(createCustomerSchema.safeParse({ ...customerExample, ...extra }));
    }
  });

  it("update needs at least one field and allows null to clear optional ones", () => {
    fails(updateCustomerSchema.safeParse({}));
    expect(updateCustomerSchema.safeParse({ taxRegistrationNumber: null, email: null, address: null }).success).toBe(true);
    fails(updateCustomerSchema.safeParse({ phone: null }));
    fails(updateCustomerSchema.safeParse({ name: null }));
  });

  it("import checks only the shape: rows are validated one by one later", () => {
    // An invalid row (the last example row) does not fail the whole body.
    expect(importCustomersSchema.safeParse({ rows: [{ name: "" }] }).success).toBe(true);
    fails(importCustomersSchema.safeParse({ rows: [] }));
    fails(importCustomersSchema.safeParse({ rows: "x" }));
    fails(importCustomersSchema.safeParse({ rows: [customerExample], dryRun: true }));
    const tooMany = Array.from({ length: CUSTOMER_IMPORT_MAX_ROWS + 1 }, () => customerExample);
    fails(importCustomersSchema.safeParse({ rows: tooMany }));
    expect(importCustomersSchema.safeParse({ rows: tooMany.slice(1) }).success).toBe(true);
  });
});
