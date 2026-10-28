/**
 * Purpose: Pins the Phase 3c goods receipt contract (src/validators/goodsReceipt.validator.ts)
 * before goods receipts exist: the documented Swagger examples must parse, and every rule the
 * frontend relies on must hold.
 */

import { describe, it, expect } from "vitest";
import { createGoodsReceiptSchema } from "../../src/validators/goodsReceipt.validator";
import {
  goodsReceiptCostChangeExample,
  goodsReceiptExample,
  goodsReceiptWithoutPoExample,
} from "../../src/docs/goodsReceipt.openapi";

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
const PO_ID = "665f1c2e8a4b3c0012ab3c00";
const PO_LINE_A = "665f1c2e8a4b3c0012ab3c01";
const PO_LINE_B = "665f1c2e8a4b3c0012ab3c02";
const VARIANT_A = "665f1c2e8a4b3c0012ab3801";
const VARIANT_B = "665f1c2e8a4b3c0012ab3802";

const poLine = (overrides: Record<string, unknown> = {}) => ({ purchaseOrderLineId: PO_LINE_A, quantity: 24, ...overrides });
const freeLine = (overrides: Record<string, unknown> = {}) => ({ variantId: VARIANT_A, quantity: 12, unitCost: "1.600", ...overrides });
const againstPo = (overrides: Record<string, unknown> = {}) => ({ purchaseOrderId: PO_ID, lines: [poLine()], ...overrides });
const withoutPo = (overrides: Record<string, unknown> = {}) => ({ vendorId: VENDOR_ID, lines: [freeLine()], ...overrides });

const parse = (body: unknown) => createGoodsReceiptSchema.safeParse(body);

describe("documented examples", () => {
  it("the partial, cost-change and without-PO examples are valid", () => {
    for (const example of [goodsReceiptExample, goodsReceiptCostChangeExample, goodsReceiptWithoutPoExample]) {
      expect(issues(parse(example))).toBe("");
    }
  });
});

describe("against a purchase order", () => {
  it("takes the vendor from the PO, so vendorId is refused", () => {
    rejected(parse(againstPo({ vendorId: VENDOR_ID })), "Send vendorId only for a receipt without a purchase order");
  });

  it("needs purchaseOrderLineId on every line and refuses variantId", () => {
    rejected(parse(againstPo({ lines: [{ quantity: 1 }] })), "lines.0.purchaseOrderLineId: Each line of a receipt against a purchase order");
    rejected(parse(againstPo({ lines: [poLine({ variantId: VARIANT_A })] })), "lines.0.variantId: Do not send variantId");
  });

  it("unitCost is optional (defaults to the PO line's)", () => {
    expect(parse(againstPo()).success).toBe(true);
    expect(parse(againstPo({ lines: [poLine({ unitCost: "1.650" })] })).success).toBe(true);
  });

  it("refuses a PO line listed twice, case-insensitively", () => {
    rejected(
      parse(againstPo({ lines: [poLine(), poLine({ purchaseOrderLineId: PO_LINE_A.toUpperCase() })] })),
      "listed more than once"
    );
    expect(parse(againstPo({ lines: [poLine(), poLine({ purchaseOrderLineId: PO_LINE_B })] })).success).toBe(true);
  });
});

describe("without a purchase order", () => {
  it("needs vendorId when there is no purchaseOrderId", () => {
    rejected(parse({ lines: [freeLine()] }), "Send purchaseOrderId, or vendorId");
  });

  it("needs variantId and unitCost on every line, and refuses purchaseOrderLineId", () => {
    rejected(parse(withoutPo({ lines: [{ quantity: 1, unitCost: "1.000" }] })), "lines.0.variantId: Each line of a receipt without a purchase order");
    rejected(parse(withoutPo({ lines: [{ variantId: VARIANT_A, quantity: 1 }] })), "lines.0.unitCost: Each line of a receipt without a purchase order");
    rejected(parse(withoutPo({ lines: [freeLine({ purchaseOrderLineId: PO_LINE_A })] })), "purchaseOrderLineId needs purchaseOrderId");
  });

  it("refuses a variant listed twice", () => {
    rejected(parse(withoutPo({ lines: [freeLine(), freeLine()] })), "listed more than once");
    expect(parse(withoutPo({ lines: [freeLine(), freeLine({ variantId: VARIANT_B })] })).success).toBe(true);
  });
});

describe("shared rules", () => {
  it("takes the store from the URL only", () => {
    rejected(parse(againstPo({ storeId: STORE_ID })), "the store comes from the URL");
  });

  it("needs 1 to 200 lines", () => {
    rejected(parse(againstPo({ lines: [] })), "at least one line");
    const many = Array.from({ length: 201 }, (_, i) => poLine({ purchaseOrderLineId: `665f1c2e8a4b3c0012a${String(i).padStart(5, "0")}` }));
    rejected(parse(againstPo({ lines: many })), "At most 200 lines");
  });

  it("needs positive quantities with at most 3 decimals", () => {
    rejected(parse(againstPo({ lines: [poLine({ quantity: 0 })] })), "greater than zero");
    rejected(parse(againstPo({ lines: [poLine({ quantity: -1 })] })), "lines.0.quantity");
    rejected(parse(againstPo({ lines: [poLine({ quantity: 1.2345 })] })), "at most 3 decimal places");
    expect(parse(againstPo({ lines: [poLine({ quantity: 6.25 })] })).success).toBe(true);
  });

  it("checks unitCost as a decimal string", () => {
    rejected(parse(againstPo({ lines: [poLine({ unitCost: 1.6 })] })), "decimal strings");
    rejected(parse(againstPo({ lines: [poLine({ unitCost: "-1" })] })), "non-negative decimal string");
  });

  it("receivedDate is a calendar date; future dates are left to the service (store timezone)", () => {
    rejected(parse(againstPo({ receivedDate: "2026-02-30" })), "receivedDate must be a calendar date");
    rejected(parse(againstPo({ receivedDate: "2026-10-28T10:00:00Z" })), "receivedDate must be a calendar date");
    expect(parse(againstPo({ receivedDate: "2026-10-28" })).success).toBe(true);
  });

  it("limits text fields and refuses empty ones", () => {
    rejected(parse(againstPo({ vendorReference: "x".repeat(51) })), "at most 50 characters");
    rejected(parse(againstPo({ notes: "   " })), "notes cannot be empty");
    rejected(parse(againstPo({ lines: [poLine({ note: "x".repeat(201) })] })), "at most 200 characters");
  });

  it("refuses unknown fields on the receipt and on lines", () => {
    rejected(parse(againstPo({ status: "draft" })), "Unknown goods receipt field");
    rejected(parse(againstPo({ lines: [poLine({ discount: "1" })] })), "Unknown goods receipt line field");
  });
});
