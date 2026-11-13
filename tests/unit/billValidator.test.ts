/**
 * Purpose: Pins the Phase 3d vendor bill and payment contract (src/validators/bill.validator.ts)
 * before bills exist: the documented Swagger examples must parse, and every rule the frontend
 * relies on must hold.
 */

import { describe, it, expect } from "vitest";
import {
  createBillSchema,
  createVendorPaymentSchema,
  toThousandths,
  voidBillSchema,
  voidVendorPaymentSchema,
} from "../../src/validators/bill.validator";
import {
  billExample,
  billRoundingExample,
  vendorPaymentExample,
  voidBillExample,
  voidVendorPaymentExample,
} from "../../src/docs/bill.openapi";

type Parsed = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };

function issues(result: Parsed) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
}

function rejected(result: Parsed, fragment: string) {
  expect(result.success).toBe(false);
  expect(issues(result)).toContain(fragment);
}

const VENDOR_ID = "665f1c2e8a4b3c0012ab3900";
const GRN_ID = "665f1c2e8a4b3c0012ab3d00";
const GRN_LINE_A = "665f1c2e8a4b3c0012ab3d01";
const GRN_LINE_B = "665f1c2e8a4b3c0012ab3d02";
const SERVICE_VARIANT = "665f1c2e8a4b3c0012ab3880";
const TAX_RATE_ID = "665f1c2e8a4b3c0012ab3600";
const BILL_A = "665f1c2e8a4b3c0012ab3e00";
const BILL_B = "665f1c2e8a4b3c0012ab3e10";

const goodsLine = (overrides: Record<string, unknown> = {}) => ({ goodsReceiptId: GRN_ID, goodsReceiptLineId: GRN_LINE_A, ...overrides });
const serviceLine = (overrides: Record<string, unknown> = {}) => ({ variantId: SERVICE_VARIANT, quantity: 1, unitCost: "5.000", ...overrides });
const bill = (overrides: Record<string, unknown> = {}) => ({
  vendorId: VENDOR_ID,
  vendorInvoiceNumber: "INV-1",
  lines: [goodsLine()],
  ...overrides,
});
const payment = (overrides: Record<string, unknown> = {}) => ({
  vendorId: VENDOR_ID,
  amount: "100.000",
  method: "cash",
  allocations: [{ billId: BILL_A, amount: "100.000" }],
  ...overrides,
});

const parseBill = (body: unknown) => createBillSchema.safeParse(body);
const parsePayment = (body: unknown) => createVendorPaymentSchema.safeParse(body);

describe("documented examples", () => {
  it("the bill, payment and void examples are valid", () => {
    expect(issues(parseBill(billExample))).toBe("");
    expect(issues(parseBill(billRoundingExample))).toBe("");
    expect(issues(parsePayment(vendorPaymentExample))).toBe("");
    expect(issues(voidBillSchema.safeParse(voidBillExample))).toBe("");
    expect(issues(voidVendorPaymentSchema.safeParse(voidVendorPaymentExample))).toBe("");
  });
});

describe("bill header", () => {
  it("needs vendorId and a vendorInvoiceNumber", () => {
    rejected(parseBill(bill({ vendorId: undefined })), "vendorId");
    rejected(parseBill(bill({ vendorInvoiceNumber: undefined })), "vendorInvoiceNumber is required");
    rejected(parseBill(bill({ vendorInvoiceNumber: "   " })), "vendorInvoiceNumber cannot be empty");
    rejected(parseBill(bill({ vendorInvoiceNumber: "x".repeat(51) })), "at most 50");
  });

  it("refuses unknown fields such as storeId or a status", () => {
    rejected(parseBill(bill({ storeId: "665f1c2e8a4b3c0012ab3400" })), "Unknown bill field");
    rejected(parseBill(bill({ status: "paid" })), "Unknown bill field");
  });

  it("checks calendar dates and dueDate on or after billDate", () => {
    rejected(parseBill(bill({ billDate: "2026-02-30" })), "billDate must be a calendar date");
    rejected(parseBill(bill({ billDate: "2026-11-13", dueDate: "2026-11-12" })), "dueDate cannot be before billDate");
    expect(parseBill(bill({ billDate: "2026-11-13", dueDate: "2026-11-13" })).success).toBe(true);
    expect(parseBill(bill({ dueDate: "2026-12-01" })).success).toBe(true);
  });

  it("vatAdjustment is a signed decimal string", () => {
    expect(parseBill(bill({ vatAdjustment: "-0.002" })).success).toBe(true);
    expect(parseBill(bill({ vatAdjustment: "0.005" })).success).toBe(true);
    rejected(parseBill(bill({ vatAdjustment: 0.002 })), "decimal strings");
    rejected(parseBill(bill({ vatAdjustment: "0.0001" })), "at most 3 decimal places");
  });

  it("needs 1 to 200 lines", () => {
    rejected(parseBill(bill({ lines: [] })), "at least one line");
    const many = Array.from({ length: 201 }, (_, i) => goodsLine({ goodsReceiptLineId: (0x665f1c2e8a4b3c0012ab0000n + BigInt(i)).toString(16) }));
    rejected(parseBill(bill({ lines: many })), "At most 200 lines");
  });
});

describe("goods lines", () => {
  it("need both goodsReceiptId and goodsReceiptLineId", () => {
    rejected(parseBill(bill({ lines: [{ goodsReceiptId: GRN_ID }] })), "lines.0.goodsReceiptLineId: goodsReceiptId needs goodsReceiptLineId");
    rejected(parseBill(bill({ lines: [{ goodsReceiptLineId: GRN_LINE_A }] })), "lines.0.goodsReceiptId: goodsReceiptLineId needs goodsReceiptId");
  });

  it("quantity and unitCost are optional (default from the receipt line)", () => {
    expect(parseBill(bill()).success).toBe(true);
    expect(parseBill(bill({ lines: [goodsLine({ quantity: 6.25, unitCost: "1.650" })] })).success).toBe(true);
  });

  it("refuse variantId (the receipt line has it)", () => {
    rejected(parseBill(bill({ lines: [goodsLine({ variantId: SERVICE_VARIANT })] })), "Do not send variantId on a goods line");
  });

  it("refuse the same receipt line twice", () => {
    rejected(parseBill(bill({ lines: [goodsLine(), goodsLine({ quantity: 1 })] })), "is listed more than once");
    expect(parseBill(bill({ lines: [goodsLine(), goodsLine({ goodsReceiptLineId: GRN_LINE_B })] })).success).toBe(true);
  });
});

describe("service lines", () => {
  it("need quantity and unitCost", () => {
    rejected(parseBill(bill({ lines: [serviceLine({ quantity: undefined })] })), "lines.0.quantity: Each service line needs quantity");
    rejected(parseBill(bill({ lines: [serviceLine({ unitCost: undefined })] })), "lines.0.unitCost: Each service line needs unitCost");
  });

  it("can be mixed with goods lines, each service variant once", () => {
    expect(parseBill(bill({ lines: [goodsLine(), serviceLine()] })).success).toBe(true);
    rejected(parseBill(bill({ lines: [serviceLine(), serviceLine()] })), "Service variant");
  });

  it("a line with neither shape is refused (no free-text expenses)", () => {
    rejected(parseBill(bill({ lines: [{ quantity: 1, unitCost: "50.000" }] })), "Each line needs goodsReceiptId and goodsReceiptLineId");
    rejected(parseBill(bill({ lines: [{ description: "Electricity", unitCost: "50.000" }] })), "Unknown bill line field");
  });
});

describe("line values", () => {
  it("taxRateId may be an id, null (no VAT) or omitted", () => {
    expect(parseBill(bill({ lines: [goodsLine({ taxRateId: TAX_RATE_ID })] })).success).toBe(true);
    expect(parseBill(bill({ lines: [goodsLine({ taxRateId: null })] })).success).toBe(true);
    rejected(parseBill(bill({ lines: [goodsLine({ taxRateId: "abc" })] })), "taxRateId must be a 24-character hex id");
  });

  it("quantities are positive with at most 3 decimals; costs are non-negative decimal strings", () => {
    rejected(parseBill(bill({ lines: [goodsLine({ quantity: 0 })] })), "greater than zero");
    rejected(parseBill(bill({ lines: [goodsLine({ quantity: 1.0005 })] })), "at most 3 decimal places");
    rejected(parseBill(bill({ lines: [goodsLine({ unitCost: "-1.000" })] })), "non-negative decimal string");
    expect(parseBill(bill({ lines: [goodsLine({ unitCost: "0" })] })).success).toBe(true);
  });
});

describe("vendor payments", () => {
  it("amount must equal the sum of the allocations exactly", () => {
    expect(
      parsePayment(payment({ amount: "250.000", allocations: [{ billId: BILL_A, amount: "43.558" }, { billId: BILL_B, amount: "206.442" }] })).success
    ).toBe(true);
    rejected(
      parsePayment(payment({ amount: "250.001", allocations: [{ billId: BILL_A, amount: "43.558" }, { billId: BILL_B, amount: "206.442" }] })),
      "amount must equal the sum of allocations"
    );
    // Same value in different spellings is equal.
    expect(parsePayment(payment({ amount: "100", allocations: [{ billId: BILL_A, amount: "100.0" }] })).success).toBe(true);
  });

  it("amounts must be greater than zero", () => {
    rejected(parsePayment(payment({ amount: "0", allocations: [{ billId: BILL_A, amount: "0" }] })), "amount must be greater than zero");
  });

  it("each bill once, 1 to 100 allocations", () => {
    rejected(
      parsePayment(payment({ amount: "2", allocations: [{ billId: BILL_A, amount: "1" }, { billId: BILL_A.toUpperCase(), amount: "1" }] })),
      "is listed more than once"
    );
    rejected(parsePayment(payment({ allocations: [] })), "at least one bill");
  });

  it("method is one of the fixed values", () => {
    for (const method of ["cash", "bank_transfer", "cheque", "card", "other"]) {
      expect(parsePayment(payment({ method })).success, method).toBe(true);
    }
    rejected(parsePayment(payment({ method: "crypto" })), "method must be one of");
  });

  it("refuses unknown fields (no unallocated credit)", () => {
    rejected(parsePayment(payment({ unallocated: "10.000" })), "Unknown payment field");
    rejected(parsePayment(payment({ allocations: [{ billId: BILL_A, amount: "100.000", note: "x" }] })), "Unknown allocation field");
  });

  it("paymentDate must be a calendar date", () => {
    rejected(parsePayment(payment({ paymentDate: "20-11-2026" })), "paymentDate must be a calendar date");
  });
});

describe("voids", () => {
  it("need version and a reason", () => {
    rejected(voidBillSchema.safeParse({ version: 1 }), "reason is required");
    rejected(voidBillSchema.safeParse({ reason: "x" }), "version is required");
    rejected(voidVendorPaymentSchema.safeParse({ version: 0, reason: "x" }), "version must be at least 1");
    rejected(voidVendorPaymentSchema.safeParse({ version: 1, reason: "  " }), "reason cannot be empty");
  });
});

describe("toThousandths", () => {
  it("parses decimal strings exactly", () => {
    expect(toThousandths("1")).toBe(1000n);
    expect(toThousandths("1.5")).toBe(1500n);
    expect(toThousandths("0.005")).toBe(5n);
    expect(toThousandths("-0.002")).toBe(-2n);
  });
});
