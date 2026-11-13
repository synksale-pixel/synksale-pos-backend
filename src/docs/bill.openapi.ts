import { registry, z } from "../config/openapi.registry";
import {
  createBillSchema,
  createVendorPaymentSchema,
  listBillsQuerySchema,
  listVendorPaymentsQuerySchema,
  MAX_VAT_ADJUSTMENT_MINOR,
  voidBillSchema,
  voidVendorPaymentSchema,
} from "../validators/bill.validator";
import { idempotencyHeadersSchema } from "../validators/stock.validator";
import {
  BillDataSchema,
  BillListDataSchema,
  successEnvelope,
  VendorPaymentDataSchema,
  VendorPaymentListDataSchema,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";
import { IDEMPOTENCY, idempotency409, QUANTITY_RULE, REPLAY_HEADERS } from "./stock.openapi";

const security = [{ tenantBearerAuth: [] }];
const billTags = ["Vendor Bills"];
const paymentTags = ["Vendor Payments"];
// Bills and payments are organization-level: one vendor invoice often covers deliveries to
// several stores, so there is no store in the path.
const billBase = `${API}/bills`;
const billPath = `${billBase}/{billId}`;
const paymentBase = `${API}/vendor-payments`;
const paymentPath = `${paymentBase}/{paymentId}`;

const billIdParam = z.object({
  billId: z.string().openapi({ description: "Bill ID (24-char hex ObjectId). A malformed ID returns 400.", example: "665f1c2e8a4b3c0012ab3e00" }),
});

const paymentIdParam = z.object({
  paymentId: z.string().openapi({
    description: "Vendor payment ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab3f00",
  }),
});

const PREVIEW = "**Contract preview (Phase 3d):** documented for frontend review; returns 404 until implemented.";

// ==========================================
// Examples
// ==========================================

/** A monthly invoice: two receipts (one at a new price) plus a delivery charge. */
export const billExample = {
  vendorId: "665f1c2e8a4b3c0012ab3900",
  vendorInvoiceNumber: "INV-2026-4471",
  billDate: "2026-11-13",
  notes: "October statement, two deliveries.",
  lines: [
    { goodsReceiptId: "665f1c2e8a4b3c0012ab3d00", goodsReceiptLineId: "665f1c2e8a4b3c0012ab3d01", unitCost: "1.650", note: "Price increase from 1 Nov" },
    { goodsReceiptId: "665f1c2e8a4b3c0012ab3d10", goodsReceiptLineId: "665f1c2e8a4b3c0012ab3d11", quantity: 6.25 },
    { variantId: "665f1c2e8a4b3c0012ab3880", quantity: 1, unitCost: "5.000" },
  ],
};

/** The vendor rounded VAT on the total, 2 fils below the per-line sum. */
export const billRoundingExample = {
  vendorId: "665f1c2e8a4b3c0012ab3900",
  vendorInvoiceNumber: "INV-2026-4502",
  vatAdjustment: "-0.002",
  lines: [{ goodsReceiptId: "665f1c2e8a4b3c0012ab3d20", goodsReceiptLineId: "665f1c2e8a4b3c0012ab3d21" }],
};

/** One transfer settles one bill in full and part of another. */
export const vendorPaymentExample = {
  vendorId: "665f1c2e8a4b3c0012ab3900",
  paymentDate: "2026-11-20",
  amount: "250.000",
  method: "bank_transfer",
  reference: "FT26318XK2",
  allocations: [
    { billId: "665f1c2e8a4b3c0012ab3e00", amount: "43.558" },
    { billId: "665f1c2e8a4b3c0012ab3e10", amount: "206.442" },
  ],
};

export const voidBillExample = { version: 1, reason: "Entered against the wrong vendor." };
export const voidVendorPaymentExample = { version: 1, reason: "Cheque bounced." };

// ==========================================
// Shared descriptions
// ==========================================

const readNote =
  "Requires a **tenant** bearer token and **`purchase:read`** from an **organization-scoped** role (org_admin, accountant). Bills and payments cover every store, so store roles get 403; store staff see only `billedQuantity` on their receipt lines.";

const billWriteNote =
  "Requires a **tenant** bearer token and **`purchase:bill`** (organization scope). Seeded on org_admin and accountant.";

const payWriteNote =
  "Requires a **tenant** bearer token and **`purchase:pay`** (organization scope). Seeded on org_admin and accountant. Kept apart from `purchase:bill` so a custom role can record bills without paying them.";

const LIST_RULES = [
  "Query parsing is lenient and never returns 400: an invalid `page`/`limit`/date filter is ignored (defaults: page 1, limit 20); `limit` is capped at 100. A malformed id filter matches nothing.",
  "Date filters compare against plain calendar dates.",
].join("\n");

const read403 = errorResponse(
  "No organization-scoped role grants `purchase:read` (store roles never can).",
  "Access Denied: You do not possess the required permission (purchase:read) to execute this action.",
  403
);

const forbidden = (permission: string) =>
  errorResponse(
    `No organization-scoped role grants \`${permission}\`.`,
    `Access Denied: You do not possess the required permission (${permission}) to execute this action.`,
    403
  );

const billNotFound = errorResponse("`BILL_NOT_FOUND`: no bill with this id in your organization.", "Bill not found.", 404, "BILL_NOT_FOUND");

const paymentNotFound = errorResponse(
  "`VENDOR_PAYMENT_NOT_FOUND`: no payment with this id in your organization.",
  "Vendor payment not found.",
  404,
  "VENDOR_PAYMENT_NOT_FOUND"
);

const BILL_RESPONSE = (name: string, message: string, status = 200) => json(successEnvelope(name, BillDataSchema, message, status));
const PAYMENT_RESPONSE = (name: string, message: string, status = 200) =>
  json(successEnvelope(name, VendorPaymentDataSchema, message, status));

const BILL_WHAT_IT_DOES = [
  "**What posting a bill does** (all in one step, all or nothing):",
  "- Posts the bill with its number (BILL-00001, BILL-00002…, per organization), status `unpaid`. No drafts, edits or deletes: fix a mistake by voiding it and entering it again.",
  "- Adds each goods line's quantity to the receipt line's `billedQuantity`.",
  "- Counts toward the vendor's purchase documents, so the vendor cannot be deleted (`VENDOR_IN_USE`).",
  "- Never changes stock, the stock's cost or `lastPurchase`: a different price is kept as `costVariance`.",
].join("\n");

const BILL_LINE_RULES = [
  "**Lines** (1 to 200; a bill can mix both kinds)",
  "- **Goods:** `goodsReceiptId` + `goodsReceiptLineId` (the receipt's `lines[].id`), each receipt line at most once per bill. The variant, product and store come from the receipt. The receipt must be from the bill's vendor (receipts from different stores are fine). `quantity` defaults to what is still unbilled on the receipt line and can never take `billedQuantity` above the received quantity. `unitCost` defaults to the receipt line's.",
  "- **Services** (no receipt): `variantId` of a **service** product, with `quantity` and `unitCost`; each service variant at most once. A goods product here is refused (`GOODS_REQUIRE_RECEIPT`): goods must be received first. Free-text expense lines are not supported in v1.",
  `- ${QUANTITY_RULE}`,
].join("\n");

const BILL_MONEY_RULES = [
  "**Amounts and VAT** (organization currency only; no foreign-currency bills in v1)",
  "- `unitCost` is VAT-exclusive, at the currency's decimals. `subtotal` = quantity × unitCost, rounded.",
  "- VAT per line: only when the vendor (as copied onto the bill) is `vat_registered` and the product is `standard`. The rate defaults to the receipt line's PO rate, else the product's, else the organization's default; send `taxRateId` to match the invoice, or `null` for no VAT. An `overseas` vendor's bill carries no VAT in v1 (reverse charge comes with the VAT return).",
  `- \`vatAdjustment\`: when the vendor rounded VAT on the invoice total, enter the difference (at most ${MAX_VAT_ADJUSTMENT_MINOR} of the currency's smallest unit either way) so \`total\` matches the paper invoice.`,
  "- `costVariance` on goods lines: what the line costs minus what the receipt put into stock for the same quantity. For an organization with no TRN the comparison includes VAT (it is part of the cost), so a VAT figure different from the receipt's estimate shows up here too. Stock is never revalued.",
].join("\n");

const BILL_DATE_RULES = [
  "**Dates** (organization timezone)",
  "- `billDate` defaults to today; cannot be in the future, or before the latest `receivedDate` among the receipts billed.",
  "- `dueDate` defaults to `billDate` + the vendor's `paymentTermsDays`; cannot be before `billDate`.",
].join("\n");

const BILL_CONCURRENCY =
  "**Two bills at once** for the same receipt line are checked against the line as it is at that moment: the second one that would bill more than was received gets 409 `BILLED_QUANTITY_EXCEEDS_RECEIVED`.";

// ==========================================
// Bills
// ==========================================

registry.registerPath({
  method: "get",
  path: billBase,
  tags: billTags,
  summary: "List vendor bills",
  description: [
    PREVIEW,
    "",
    readNote,
    "",
    "Paginated, newest bill number first. Bills still owed: `status=unpaid,partially_paid`; overdue: `overdue=true`; a vendor's open bills for a payment screen: `vendorId=…&status=unpaid,partially_paid`.",
    "",
    LIST_RULES,
  ].join("\n"),
  security,
  request: { query: listBillsQuerySchema },
  responses: {
    200: {
      description: "Bills fetched. Each item is a summary (no lines or payments; `lineCount` instead).",
      content: json(successEnvelope("BillListResponse", BillListDataSchema, "Bills fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: read403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: billPath,
  tags: billTags,
  summary: "Get a vendor bill",
  description: [PREVIEW, "", readNote, "", "With its lines and every payment allocated to it (void ones included)."].join("\n"),
  security,
  request: { params: billIdParam },
  responses: {
    200: { description: "Bill fetched.", content: BILL_RESPONSE("GetBillResponse", "Bill fetched successfully.") },
    400: errorResponse("Malformed `billId`.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: read403,
    404: billNotFound,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: billBase,
  tags: billTags,
  summary: "Record a vendor bill",
  description: [
    PREVIEW,
    "",
    billWriteNote,
    "",
    "Records the vendor's invoice: what the organization owes. `vendorId` is required (a deactivated vendor can still be billed: deactivating does not cancel a debt). `vendorInvoiceNumber` is required and unique per vendor among bills that are not void.",
    "",
    BILL_WHAT_IT_DOES,
    "",
    BILL_LINE_RULES,
    "",
    BILL_MONEY_RULES,
    "",
    BILL_DATE_RULES,
    "",
    BILL_CONCURRENCY,
    "",
    IDEMPOTENCY,
  ].join("\n"),
  security,
  request: {
    headers: idempotencyHeadersSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createBillSchema,
          examples: {
            statement: { summary: "Two receipts (one at a new price) and a delivery charge", value: billExample },
            rounding: { summary: "Whole receipt line, VAT rounded on the invoice total", value: billRoundingExample },
          },
        },
      },
    },
  },
  responses: {
    201: { description: "Bill recorded.", headers: REPLAY_HEADERS, content: BILL_RESPONSE("CreateBillResponse", "Bill recorded successfully.", 201) },
    400: errorResponse(
      [
        "Bad request. Codes:",
        "- `VALIDATION_FAILED`: a schema rule (see `errors`), a missing or malformed `Idempotency-Key`, a `billDate` in the future or before a billed receipt's `receivedDate`, a `dueDate` before `billDate`, or a fractional quantity for a whole-number unit.",
        `- \`VAT_ADJUSTMENT_TOO_LARGE\`: \`vatAdjustment\` is more than ${MAX_VAT_ADJUSTMENT_MINOR} of the currency's smallest unit either way, or has more decimals than the currency.`,
        "- `VENDOR_NOT_FOUND`: `vendorId` does not exist in your organization (`errors[0].field` is `vendorId`).",
        "- Line problems are collected in one response, one `errors` item per bad line; the top-level `code` is the first item's:",
        "  - `VENDOR_MISMATCH`: the receipt is from a different vendor (`meta: { goodsReceiptNumber }`).",
        "  - `GOODS_REQUIRE_RECEIPT`: a service line names a goods product.",
        "  - `VARIANT_NOT_FOUND`: a service line's variant does not exist or is deleted.",
        "  - `TAX_RATE_NOT_FOUND`: `taxRateId` is not one of your organization's tax rates.",
        "  - `TOO_MANY_DECIMALS` / `INVALID_AMOUNT` / `AMOUNT_OUT_OF_RANGE`: a `unitCost` does not fit the organization's currency.",
      ].join("\n"),
      "Request Validation Failed: lines.0: Each line needs goodsReceiptId and goodsReceiptLineId (goods), or variantId of a service product (services).",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: forbidden("purchase:bill"),
    404: errorResponse(
      "`GOODS_RECEIPT_NOT_FOUND`: a `goodsReceiptId` is not one of your organization's receipts, or the `goodsReceiptLineId` is not on it (`errors[].field` is `lines[i].goodsReceiptId` or `lines[i].goodsReceiptLineId`).",
      "Goods receipt not found.",
      404,
      "GOODS_RECEIPT_NOT_FOUND"
    ),
    409: idempotency409(
      [
        "- `DUPLICATE_VENDOR_INVOICE`: this vendor already has a bill (not void) with this `vendorInvoiceNumber` (case-insensitive). `errors[0].meta` is `{ billId, billNumber }`.",
        "- `BILLED_QUANTITY_EXCEEDS_RECEIVED`: a line would bill more than was received. One item per line, `errors[].field` is `lines[i].quantity`, `meta` is `{ received, billed, remaining }`. Over-billed quantities are settled with the vendor (a debit note, Phase 3e).",
      ],
      {
        message: "More than was received would be billed on this line.",
        code: "BILLED_QUANTITY_EXCEEDS_RECEIVED",
        errors: [{ field: "lines[1].quantity", code: "BILLED_QUANTITY_EXCEEDS_RECEIVED", meta: { received: 12.5, billed: 6.25, remaining: 6.25 } }],
      }
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${billPath}/void`,
  tags: billTags,
  summary: "Void a vendor bill",
  description: [
    PREVIEW,
    "",
    billWriteNote,
    "",
    "Cancels a bill entered by mistake. Allowed only while no payment that is not void is allocated to it: void those payments first. The bill keeps its number (status `void`, `voided`, `voidReason`); the receipt lines' `billedQuantity` goes back down, and its `vendorInvoiceNumber` can be used again.",
    "",
    IDEMPOTENCY,
  ].join("\n"),
  security,
  request: {
    params: billIdParam,
    headers: idempotencyHeadersSchema,
    body: { required: true, content: { "application/json": { schema: voidBillSchema, example: voidBillExample } } },
  },
  responses: {
    200: { description: "Bill voided.", headers: REPLAY_HEADERS, content: BILL_RESPONSE("VoidBillResponse", "Bill voided successfully.") },
    400: errorResponse("`VALIDATION_FAILED`: `version` or `reason` missing, or a missing or malformed `Idempotency-Key`.", "Request Validation Failed: reason: reason is required.", 400, "VALIDATION_FAILED"),
    401: TENANT_AUTH_401,
    403: forbidden("purchase:bill"),
    404: billNotFound,
    409: idempotency409(
      [
        "- `BILL_VERSION_CONFLICT`: the bill changed since you loaded it (`errors[0].meta.currentVersion`).",
        "- `BILL_STATUS_CONFLICT`: the bill is already void.",
        "- `BILL_HAS_PAYMENTS`: payments are allocated to it (`errors[0].meta.payments` lists their numbers). Void them first.",
      ],
      { message: "This bill has payments. Void them first.", code: "BILL_HAS_PAYMENTS", errors: [{ code: "BILL_HAS_PAYMENTS", meta: { payments: ["PAY-00002"] } }] }
    ),
    500: server500,
  },
});

// ==========================================
// Vendor payments
// ==========================================

registry.registerPath({
  method: "get",
  path: paymentBase,
  tags: paymentTags,
  summary: "List vendor payments",
  description: [PREVIEW, "", readNote, "", "Paginated, newest payment number first.", "", LIST_RULES].join("\n"),
  security,
  request: { query: listVendorPaymentsQuerySchema },
  responses: {
    200: {
      description: "Payments fetched. Each item is a summary (no allocations; `billCount` instead).",
      content: json(successEnvelope("VendorPaymentListResponse", VendorPaymentListDataSchema, "Vendor payments fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: read403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: paymentPath,
  tags: paymentTags,
  summary: "Get a vendor payment",
  description: [PREVIEW, "", readNote, "", "`bills` in `data` is always empty here."].join("\n"),
  security,
  request: { params: paymentIdParam },
  responses: {
    200: { description: "Payment fetched.", content: PAYMENT_RESPONSE("GetVendorPaymentResponse", "Vendor payment fetched successfully.") },
    400: errorResponse("Malformed `paymentId`.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: read403,
    404: paymentNotFound,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: paymentBase,
  tags: paymentTags,
  summary: "Record a vendor payment",
  description: [
    PREVIEW,
    "",
    payWriteNote,
    "",
    "Records money paid to one vendor, split across one or more of its bills.",
    "- Each allocation names an `unpaid` or `partially_paid` bill of this vendor and pays part or all of its `balanceDue`. Partial payments are fine.",
    "- `amount` must equal the sum of the allocations: no advances, overpayments or unallocated credit in v1.",
    "- A deactivated vendor can still be paid.",
    "- `method`: `cash`, `bank_transfer`, `cheque`, `card` or `other`, with an optional `reference`. Payments are not linked to bank accounts or the cash drawer in v1.",
    "- `paymentDate` defaults to today (organization timezone); cannot be in the future, or before the `billDate` of a bill it pays.",
    "",
    "**What it does** (all in one step, all or nothing): posts the payment (PAY-00001, PAY-00002…), adds each allocation to the bill's `paid`, and moves each bill to `partially_paid` or `paid`. The bills' `version` goes up. `data.bills` returns them after the change. Two payments racing for the same bill cannot pay more than its `balanceDue` between them.",
    "",
    IDEMPOTENCY,
  ].join("\n"),
  security,
  request: {
    headers: idempotencyHeadersSchema,
    body: { required: true, content: { "application/json": { schema: createVendorPaymentSchema, example: vendorPaymentExample } } },
  },
  responses: {
    201: {
      description: "Payment recorded.",
      headers: REPLAY_HEADERS,
      content: PAYMENT_RESPONSE("CreateVendorPaymentResponse", "Vendor payment recorded successfully.", 201),
    },
    400: errorResponse(
      [
        "Bad request. Codes:",
        "- `VALIDATION_FAILED`: a schema rule (see `errors`; e.g. `amount` not equal to the allocations' sum, a bill listed twice), a missing or malformed `Idempotency-Key`, or a `paymentDate` in the future or before a bill's `billDate`.",
        "- `VENDOR_NOT_FOUND`: `vendorId` does not exist in your organization.",
        "- `VENDOR_MISMATCH`: an allocated bill belongs to a different vendor (`errors[].field` is `allocations[i].billId`).",
        "- `TOO_MANY_DECIMALS` / `INVALID_AMOUNT` / `AMOUNT_OUT_OF_RANGE`: an amount does not fit the organization's currency.",
      ].join("\n"),
      "Request Validation Failed: amount: amount must equal the sum of allocations[].amount (advances and overpayments are not supported).",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: forbidden("purchase:pay"),
    404: errorResponse(
      "`BILL_NOT_FOUND`: an allocated bill does not exist in your organization (`errors[].field` is `allocations[i].billId`).",
      "Bill not found.",
      404,
      "BILL_NOT_FOUND"
    ),
    409: idempotency409(
      [
        "- `BILL_STATUS_CONFLICT`: an allocated bill is `paid` or `void`. `errors[].field` is `allocations[i].billId`, `meta` is `{ status }`.",
        "- `PAYMENT_EXCEEDS_DUE`: an allocation is more than the bill's `balanceDue` (perhaps another payment got there first). One item per allocation, `errors[].field` is `allocations[i].amount`, `meta` is `{ balanceDue }`.",
      ],
      {
        message: "This payment is more than is still due on the bill.",
        code: "PAYMENT_EXCEEDS_DUE",
        errors: [{ field: "allocations[0].amount", code: "PAYMENT_EXCEEDS_DUE", meta: { balanceDue: "23.558" } }],
      }
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${paymentPath}/void`,
  tags: paymentTags,
  summary: "Void a vendor payment",
  description: [
    PREVIEW,
    "",
    payWriteNote,
    "",
    "Reverses a payment recorded by mistake (or a bounced cheque). Every allocation is reversed in the same step: each bill's `paid` goes down and its status moves back to `partially_paid` or `unpaid`. The payment keeps its number (status `void`, `voided`, `voidReason`). Payments cannot be edited: void and record again.",
    "",
    IDEMPOTENCY,
  ].join("\n"),
  security,
  request: {
    params: paymentIdParam,
    headers: idempotencyHeadersSchema,
    body: { required: true, content: { "application/json": { schema: voidVendorPaymentSchema, example: voidVendorPaymentExample } } },
  },
  responses: {
    200: {
      description: "Payment voided. `data.bills` are the bills it had paid, after the reversal.",
      headers: REPLAY_HEADERS,
      content: PAYMENT_RESPONSE("VoidVendorPaymentResponse", "Vendor payment voided successfully."),
    },
    400: errorResponse(
      "`VALIDATION_FAILED`: `version` or `reason` missing, or a missing or malformed `Idempotency-Key`.",
      "Request Validation Failed: reason: reason is required.",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: forbidden("purchase:pay"),
    404: paymentNotFound,
    409: idempotency409(
      [
        "- `VENDOR_PAYMENT_VERSION_CONFLICT`: the payment changed since you loaded it (`errors[0].meta.currentVersion`).",
        "- `VENDOR_PAYMENT_STATUS_CONFLICT`: the payment is already void.",
      ],
      { message: "This payment is already void.", code: "VENDOR_PAYMENT_STATUS_CONFLICT" }
    ),
    500: server500,
  },
});
