/**
 * Purpose: Pins the Phase 3b purchase order contract (src/validators/purchaseOrder.validator.ts)
 * before purchase orders exist: the documented Swagger examples must parse, and every rule the
 * frontend relies on must hold.
 */

import { describe, it, expect } from "vitest";
import {
  cancelPurchaseOrderSchema,
  closePurchaseOrderSchema,
  createPurchaseOrderSchema,
  deletePurchaseOrderQuerySchema,
  issuePurchaseOrderSchema,
  updatePurchaseOrderSchema,
} from "../../src/validators/purchaseOrder.validator";
import { minimalPurchaseOrderExample, purchaseOrderExample } from "../../src/docs/purchaseOrder.openapi";

type Parsed = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };

function issues(result: Parsed) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
}

function rejected(result: Parsed, fragment: string) {
  expect(result.success).toBe(false);
  expect(issues(result)).toContain(fragment);
}

const STORE_ID = "665f1c2e8a4b3c0012ab3400";
const VENDOR_ID = "665f1c2e8a4b3c0012ab3900";
const VARIANT_A = "665f1c2e8a4b3c0012ab3801";
const VARIANT_B = "665f1c2e8a4b3c0012ab3802";

const line = (overrides: Record<string, unknown> = {}) => ({ variantId: VARIANT_A, quantity: 24, ...overrides });
const po = (overrides: Record<string, unknown> = {}) => ({ vendorId: VENDOR_ID, lines: [line()], ...overrides });

describe("documented examples", () => {
  it("the full and minimal PO examples are valid", () => {
    for (const example of [purchaseOrderExample, minimalPurchaseOrderExample]) {
      expect(issues(createPurchaseOrderSchema.safeParse(example))).toBe("");
    }
  });
});

describe("create purchase order", () => {
  it("requires vendorId and at least one line, and takes the store from the URL only", () => {
    rejected(createPurchaseOrderSchema.safeParse({}), "vendorId");
    rejected(createPurchaseOrderSchema.safeParse(po({ storeId: STORE_ID })), "the store comes from the URL");
    rejected(createPurchaseOrderSchema.safeParse(po({ vendorId: "abc" })), "vendorId must be a 24-character hex id.");
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [] })), "at least one line");
  });

  it("caps lines at 200 and refuses a variant listed twice", () => {
    const many = Array.from({ length: 201 }, (_, i) => line({ variantId: `665f1c2e8a4b3c0012a${String(i).padStart(5, "0")}` }));
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: many })), "At most 200 lines");
    rejected(
      createPurchaseOrderSchema.safeParse(po({ lines: [line(), line({ variantId: VARIANT_A.toUpperCase() })] })),
      "listed more than once"
    );
    expect(createPurchaseOrderSchema.safeParse(po({ lines: [line(), line({ variantId: VARIANT_B })] })).success).toBe(true);
  });

  it("needs a positive quantity with at most 3 decimals", () => {
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ quantity: 0 })] })), "greater than zero");
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ quantity: -1 })] })), "cannot be negative");
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ quantity: 1.2345 })] })), "at most 3 decimal");
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ quantity: "5" })] })), "Quantity must be a number.");
  });

  it("takes unitCost as an optional non-negative decimal string", () => {
    expect(createPurchaseOrderSchema.parse(po()).lines[0].unitCost).toBeUndefined();
    expect(createPurchaseOrderSchema.parse(po({ lines: [line({ unitCost: " 1.600 " })] })).lines[0].unitCost).toBe("1.600");
    expect(createPurchaseOrderSchema.safeParse(po({ lines: [line({ unitCost: "0" })] })).success).toBe(true);
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ unitCost: 1.6 })] })), "decimal strings");
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ unitCost: "-1" })] })), "non-negative decimal");
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ unitCost: "1.2345" })] })), "at most 3 decimal");
  });

  it("refuses discounts and other unknown line fields", () => {
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ discount: "0.100" })] })), "Unknown purchase order line field");
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ taxRateId: VENDOR_ID })] })), "Unknown purchase order line field");
  });

  it("limits the line note to 200 characters and refuses an empty one", () => {
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ note: "x".repeat(201) })] })), "at most 200");
    rejected(createPurchaseOrderSchema.safeParse(po({ lines: [line({ note: "  " })] })), "cannot be empty");
  });

  it("accepts only real calendar dates and keeps expectedDate on or after orderDate", () => {
    expect(createPurchaseOrderSchema.safeParse(po({ orderDate: "2028-02-29" })).success).toBe(true);
    for (const orderDate of ["2026-02-30", "2026-13-01", "27-10-2026", "2026-10-27T00:00:00Z", "2026-1-5"]) {
      rejected(createPurchaseOrderSchema.safeParse(po({ orderDate })), "YYYY-MM-DD");
    }
    rejected(createPurchaseOrderSchema.safeParse(po({ orderDate: "2026-10-27", expectedDate: "2026-10-26" })), "cannot be before orderDate");
    expect(createPurchaseOrderSchema.safeParse(po({ orderDate: "2026-10-27", expectedDate: "2026-10-27" })).success).toBe(true);
    expect(createPurchaseOrderSchema.safeParse(po({ expectedDate: null })).success).toBe(true);
  });

  it("limits vendorReference and notes, refusing empty strings", () => {
    rejected(createPurchaseOrderSchema.safeParse(po({ vendorReference: "x".repeat(51) })), "at most 50");
    rejected(createPurchaseOrderSchema.safeParse(po({ notes: "x".repeat(1001) })), "at most 1000");
    rejected(createPurchaseOrderSchema.safeParse(po({ notes: "" })), "cannot be empty");
  });

  it("refuses unknown fields, including status, number and a currency", () => {
    for (const extra of [{ status: "issued" }, { number: "PO-00001" }, { currency: "USD" }, { version: 1 }]) {
      rejected(createPurchaseOrderSchema.safeParse(po(extra)), "Unknown purchase order field");
    }
  });
});

describe("update purchase order", () => {
  it("requires version and at least one other field", () => {
    rejected(updatePurchaseOrderSchema.safeParse({ notes: "x" }), "version is required.");
    rejected(updatePurchaseOrderSchema.safeParse({ version: 3 }), "At least one field besides version");
    rejected(updatePurchaseOrderSchema.safeParse({ version: 0, notes: "x" }), "at least 1");
    rejected(updatePurchaseOrderSchema.safeParse({ version: 1.5, notes: "x" }), "whole number");
    expect(updatePurchaseOrderSchema.safeParse({ version: 3, expectedDate: null }).success).toBe(true);
  });

  it("refuses storeId: the store is fixed", () => {
    rejected(updatePurchaseOrderSchema.safeParse({ version: 3, storeId: STORE_ID }), "the store is fixed");
  });

  it("applies the same line rules when lines are sent", () => {
    rejected(updatePurchaseOrderSchema.safeParse({ version: 3, lines: [] }), "at least one line");
    rejected(updatePurchaseOrderSchema.safeParse({ version: 3, lines: [line(), line()] }), "listed more than once");
    expect(updatePurchaseOrderSchema.safeParse({ version: 3, lines: [line({ unitCost: "1.650" })] }).success).toBe(true);
  });

  it("checks the date order only when both dates are sent", () => {
    rejected(updatePurchaseOrderSchema.safeParse({ version: 3, orderDate: "2026-10-27", expectedDate: "2026-10-01" }), "cannot be before");
    expect(updatePurchaseOrderSchema.safeParse({ version: 3, expectedDate: "2026-10-01" }).success).toBe(true);
  });
});

describe("status changes", () => {
  it("issue takes only version", () => {
    expect(issuePurchaseOrderSchema.safeParse({ version: 2 }).success).toBe(true);
    rejected(issuePurchaseOrderSchema.safeParse({}), "version is required.");
    rejected(issuePurchaseOrderSchema.safeParse({ version: 2, reason: "x" }), "Only version");
  });

  it("cancel and close take version and an optional reason up to 500 characters", () => {
    for (const schema of [cancelPurchaseOrderSchema, closePurchaseOrderSchema]) {
      expect(schema.safeParse({ version: 2 }).success).toBe(true);
      expect(schema.parse({ version: 2, reason: "  Out of stock  " }).reason).toBe("Out of stock");
      rejected(schema.safeParse({ version: 2, reason: "x".repeat(501) }), "at most 500");
      rejected(schema.safeParse({ reason: "x" }), "version is required.");
    }
  });

  it("delete reads version from the query string", () => {
    expect(deletePurchaseOrderQuerySchema.parse({ version: "2" }).version).toBe(2);
    rejected(deletePurchaseOrderQuerySchema.safeParse({ version: "abc" }), "version");
    rejected(deletePurchaseOrderQuerySchema.safeParse({ version: "0" }), "at least 1");
  });
});
