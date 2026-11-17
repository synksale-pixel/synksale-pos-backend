/**
 * Purpose: Pins the Phase 3e vendor return and debit note contract
 * (src/validators/vendorReturn.validator.ts) before the routes exist: the Swagger examples must
 * parse, and every rule the frontend relies on must hold.
 */

import { describe, it, expect } from "vitest";
import {
  applyDebitNoteSchema,
  createDebitNoteSchema,
  createVendorReturnSchema,
  RETURN_REASONS,
  voidDebitNoteSchema,
} from "../../src/validators/vendorReturn.validator";
import {
  applyDebitNoteExample,
  debitNoteExample,
  vendorReturnExample,
  vendorReturnUnbilledExample,
  voidDebitNoteExample,
} from "../../src/docs/vendorReturn.openapi";

type Parsed = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };

const issues = (result: Parsed) => (result.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");

function rejected(result: Parsed, fragment: string) {
  expect(result.success).toBe(false);
  expect(issues(result)).toContain(fragment);
}

const VENDOR_ID = "665f1c2e8a4b3c0012ab3900";
const GRN_ID = "665f1c2e8a4b3c0012ab3d00";
const GRN_LINE_A = "665f1c2e8a4b3c0012ab3d01";
const BILL_ID = "665f1c2e8a4b3c0012ab3e00";
const BILL_LINE = "665f1c2e8a4b3c0012ab3e01";
const BILL_LINE_B = "665f1c2e8a4b3c0012ab3e02";

const returnLine = (overrides: Record<string, unknown> = {}) => ({ goodsReceiptId: GRN_ID, goodsReceiptLineId: GRN_LINE_A, quantity: 2, ...overrides });
const vendorReturn = (overrides: Record<string, unknown> = {}) => ({ vendorId: VENDOR_ID, reason: "damaged", lines: [returnLine()], ...overrides });
const debitNote = (overrides: Record<string, unknown> = {}) => ({
  billId: BILL_ID,
  reason: "Billed above the agreed price.",
  lines: [{ billLineId: BILL_LINE, amount: "1.200" }],
  ...overrides,
});

const parseReturn = (body: unknown) => createVendorReturnSchema.safeParse(body);
const parseNote = (body: unknown) => createDebitNoteSchema.safeParse(body);

describe("Swagger examples parse", () => {
  it.each([
    ["vendor return (billed)", createVendorReturnSchema, vendorReturnExample],
    ["vendor return (unbilled)", createVendorReturnSchema, vendorReturnUnbilledExample],
    ["debit note", createDebitNoteSchema, debitNoteExample],
    ["apply", applyDebitNoteSchema, applyDebitNoteExample],
    ["void", voidDebitNoteSchema, voidDebitNoteExample],
  ])("%s", (_name, schema, example) => {
    const result = schema.safeParse(example);
    expect(result.success, issues(result as Parsed)).toBe(true);
  });
});

describe("createVendorReturnSchema", () => {
  it("needs vendorId, reason and at least one line", () => {
    rejected(parseReturn({ reason: "damaged", lines: [returnLine()] }), "vendorId");
    rejected(parseReturn({ vendorId: VENDOR_ID, lines: [returnLine()] }), "reason");
    rejected(parseReturn(vendorReturn({ lines: [] })), "at least one line");
  });

  it("accepts every reason on the fixed list and nothing else", () => {
    for (const reason of RETURN_REASONS) expect(parseReturn(vendorReturn({ reason })).success, reason).toBe(true);
    rejected(parseReturn(vendorReturn({ reason: "changed_mind" })), "reason must be one of");
  });

  it("each line names a receipt line and a positive quantity", () => {
    rejected(parseReturn(vendorReturn({ lines: [{ goodsReceiptLineId: GRN_LINE_A, quantity: 1 }] })), "lines.0.goodsReceiptId");
    rejected(parseReturn(vendorReturn({ lines: [{ goodsReceiptId: GRN_ID, quantity: 1 }] })), "lines.0.goodsReceiptLineId");
    rejected(parseReturn(vendorReturn({ lines: [returnLine({ quantity: undefined })] })), "lines.0.quantity");
    rejected(parseReturn(vendorReturn({ lines: [returnLine({ quantity: 0 })] })), "lines.0.quantity");
    rejected(parseReturn(vendorReturn({ lines: [returnLine({ quantity: -1 })] })), "lines.0.quantity");
  });

  it("billId and billLineId come together, and are optional", () => {
    expect(parseReturn(vendorReturn()).success).toBe(true);
    expect(parseReturn(vendorReturn({ lines: [returnLine({ billId: BILL_ID, billLineId: BILL_LINE })] })).success).toBe(true);
    rejected(parseReturn(vendorReturn({ lines: [returnLine({ billId: BILL_ID })] })), "lines.0.billLineId: billId and billLineId are sent together.");
    rejected(parseReturn(vendorReturn({ lines: [returnLine({ billLineId: BILL_LINE })] })), "lines.0.billId: billId and billLineId are sent together.");
  });

  it("refuses a receipt line listed twice (case-insensitive ids)", () => {
    const twice = [returnLine(), returnLine({ goodsReceiptLineId: GRN_LINE_A.toUpperCase() })];
    rejected(parseReturn(vendorReturn({ lines: twice })), "is listed more than once");
  });

  it("refuses unknown fields, a bad date and a too-long reference", () => {
    rejected(parseReturn(vendorReturn({ storeId: GRN_ID })), "Unknown return field");
    rejected(parseReturn(vendorReturn({ lines: [returnLine({ unitCost: "1.000" })] })), "Unknown return line field");
    rejected(parseReturn(vendorReturn({ returnDate: "2026-02-30" })), "returnDate");
    rejected(parseReturn(vendorReturn({ vendorReference: "x".repeat(51) })), "vendorReference");
    rejected(parseReturn(vendorReturn({ notes: "" })), "notes");
  });
});

describe("createDebitNoteSchema", () => {
  it("needs billId, reason and at least one line", () => {
    rejected(parseNote(debitNote({ billId: undefined })), "billId");
    rejected(parseNote(debitNote({ reason: "  " })), "reason");
    rejected(parseNote(debitNote({ lines: [] })), "at least one line");
  });

  it("amounts are positive decimal strings", () => {
    rejected(parseNote(debitNote({ lines: [{ billLineId: BILL_LINE, amount: "0.000" }] })), "greater than zero");
    rejected(parseNote(debitNote({ lines: [{ billLineId: BILL_LINE, amount: 1.2 }] })), "decimal strings");
    rejected(parseNote(debitNote({ lines: [{ billLineId: BILL_LINE, amount: "-1.000" }] })), "lines.0.amount");
    rejected(parseNote(debitNote({ lines: [{ billLineId: BILL_LINE, amount: "1.0001" }] })), "lines.0.amount");
  });

  it("refuses a bill line listed twice and unknown fields", () => {
    rejected(
      parseNote(debitNote({ lines: [{ billLineId: BILL_LINE, amount: "1.000" }, { billLineId: BILL_LINE, amount: "2.000" }] })),
      "is listed more than once"
    );
    expect(parseNote(debitNote({ lines: [{ billLineId: BILL_LINE, amount: "1.000" }, { billLineId: BILL_LINE_B, amount: "2.000" }] })).success).toBe(true);
    rejected(parseNote(debitNote({ vendorId: VENDOR_ID })), "Unknown debit note field");
    rejected(parseNote(debitNote({ lines: [{ billLineId: BILL_LINE, amount: "1.000", quantity: 1 }] })), "Unknown debit note line field");
    rejected(parseNote(debitNote({ debitNoteDate: "18-11-2026" })), "debitNoteDate");
  });
});

describe("applyDebitNoteSchema and voidDebitNoteSchema", () => {
  it("apply needs version and at least one application, each bill once", () => {
    rejected(applyDebitNoteSchema.safeParse({ applications: [{ billId: BILL_ID, amount: "1.000" }] }), "version is required");
    rejected(applyDebitNoteSchema.safeParse({ version: 1, applications: [] }), "at least one bill");
    rejected(
      applyDebitNoteSchema.safeParse({ version: 1, applications: [{ billId: BILL_ID, amount: "1.000" }, { billId: BILL_ID, amount: "1.000" }] }),
      "is listed more than once"
    );
    rejected(applyDebitNoteSchema.safeParse({ version: 1, applications: [{ billId: BILL_ID, amount: "0" }] }), "greater than zero");
  });

  it("void needs version and reason", () => {
    rejected(voidDebitNoteSchema.safeParse({ reason: "x" }), "version is required");
    rejected(voidDebitNoteSchema.safeParse({ version: 1 }), "reason is required");
    rejected(voidDebitNoteSchema.safeParse({ version: 0, reason: "x" }), "at least 1");
  });
});
