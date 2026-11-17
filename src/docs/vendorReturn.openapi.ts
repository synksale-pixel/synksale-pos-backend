/**
 * Purpose: Swagger for Phase 3e vendor returns and debit notes (contract preview: documented
 * before the routes exist, so they answer 404 until the implementation ships).
 */
import { registry, z } from "../config/openapi.registry";
import {
  applyDebitNoteSchema,
  createDebitNoteSchema,
  createVendorReturnSchema,
  listDebitNotesQuerySchema,
  listVendorReturnsQuerySchema,
  voidDebitNoteSchema,
} from "../validators/vendorReturn.validator";
import { idempotencyHeadersSchema } from "../validators/stock.validator";
import {
  DebitNoteDataSchema,
  DebitNoteListDataSchema,
  successEnvelope,
  VendorReturnDataSchema,
  VendorReturnListDataSchema,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";
import { IDEMPOTENCY, idempotency409, QUANTITY_RULE, REPLAY_HEADERS } from "./stock.openapi";

const security = [{ tenantBearerAuth: [] }];
const returnTags = ["Vendor Returns"];
const debitNoteTags = ["Debit Notes"];
// Goods leave one store, so returns live under the store path (plus a cross-store list), like
// goods receipts. Debit notes are money owed to the organization: organization-level, like bills.
const returnOrgBase = `${API}/vendor-returns`;
const returnStoreBase = `${API}/stores/{storeId}/vendor-returns`;
const returnPath = `${returnStoreBase}/{vendorReturnId}`;
const debitNoteBase = `${API}/debit-notes`;
const debitNotePath = `${debitNoteBase}/{debitNoteId}`;

const PREVIEW =
  "**Contract preview (Phase 3e):** documented for frontend sign-off; the route answers 404 until the implementation ships.";

const storeIdParam = z.object({
  storeId: z.string().openapi({ description: "Store ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3400" }),
});

const returnParams = storeIdParam.extend({
  vendorReturnId: z.string().openapi({
    description: "Vendor return ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab4000",
  }),
});

const debitNoteIdParam = z.object({
  debitNoteId: z.string().openapi({
    description: "Debit note ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab4100",
  }),
});

// ==========================================
// Examples
// ==========================================

/** Two damaged bags of a receipt line: one never billed, one billed on BILL-00004. */
export const vendorReturnExample = {
  vendorId: "665f1c2e8a4b3c0012ab3900",
  returnDate: "2026-11-18",
  reason: "damaged",
  vendorReference: "RMA-2026-118",
  notes: "Collected by the vendor's driver.",
  lines: [
    {
      goodsReceiptId: "665f1c2e8a4b3c0012ab3d00",
      goodsReceiptLineId: "665f1c2e8a4b3c0012ab3d01",
      quantity: 2,
      billId: "665f1c2e8a4b3c0012ab3e00",
      billLineId: "665f1c2e8a4b3c0012ab3e01",
      note: "Seal broken on 2 bags",
    },
  ],
};

/** Excess goods sent back before any bill: no bill line, no debit note. */
export const vendorReturnUnbilledExample = {
  vendorId: "665f1c2e8a4b3c0012ab3900",
  reason: "excess",
  lines: [{ goodsReceiptId: "665f1c2e8a4b3c0012ab3d10", goodsReceiptLineId: "665f1c2e8a4b3c0012ab3d11", quantity: 6 }],
};

/** The vendor billed 0.050 above the agreed price on 24 units. */
export const debitNoteExample = {
  billId: "665f1c2e8a4b3c0012ab3e00",
  debitNoteDate: "2026-11-18",
  vendorReference: "CN-2026-031",
  reason: "Billed above the agreed price.",
  lines: [{ billLineId: "665f1c2e8a4b3c0012ab3e01", amount: "1.200", note: "Billed 1.650, agreed 1.600" }],
};

/** Spare credit (the original bill was already paid) used on two newer bills. */
export const applyDebitNoteExample = {
  version: 1,
  applications: [
    { billId: "665f1c2e8a4b3c0012ab3e10", amount: "1.000" },
    { billId: "665f1c2e8a4b3c0012ab3e20", amount: "0.320" },
  ],
};

export const voidDebitNoteExample = { version: 1, reason: "Vendor did not agree to the price correction." };

// ==========================================
// Shared descriptions
// ==========================================

const returnReadNote =
  "Requires a **tenant** bearer token and **`purchase:read`** for this store: a store role at this store, or an organization-scoped role. Works for a deactivated store too. Costs (`unitCost`, `stockValue`) are null without `inventory:read` for this store.";

const returnListNote =
  "Requires a **tenant** bearer token and **`purchase:read`** held anywhere (org role or any store role). Store staff see only returns of stores where they hold `purchase:read`; an organization-scoped role sees every store's. Costs are null where the caller lacks `inventory:read`.";

const returnCreateNote =
  "Requires a **tenant** bearer token and **`purchase:return`** for this store (a store role at this store, or an organization-scoped role). Seeded on org_admin and store_manager; an organization can add it to a custom role (e.g. for inventory clerks). Kept apart from `purchase:receive`: taking stock out is a different risk from bringing it in. The debit notes a return creates need no bill permission: their amounts come from the bill, never from the request.";

const debitNoteReadNote =
  "Requires a **tenant** bearer token and **`purchase:read`** from an **organization-scoped** role (org_admin, accountant). Debit notes are money, like bills: store roles get 403 (a return shows its debit notes' numbers and totals).";

const debitNoteWriteNote =
  "Requires a **tenant** bearer token and **`purchase:bill`** (organization scope). Seeded on org_admin and accountant.";

const RETURN_WHAT_IT_DOES = [
  "**What a return does** (all in one step, all or nothing):",
  "- Posts the return with its number (RTN-00001, RTN-00002…, per organization). It is **final**: no drafts, edits or void. Goods sent back by mistake come back on a new goods receipt.",
  "- Takes the goods out of this store's stock for each line whose product tracks inventory: a `vendor_return` movement at the store's **current average cost** (the average does not change). Lines for goods that do not track inventory are recorded (`stocked: false`) and change no stock.",
  "- Adds each line's quantity to the receipt line's `returnedQuantity`.",
  "- **Unbilled first:** each line uses up the receipt line's unbilled quantity (`billableQuantity`) first. That part needs no bill and creates no debit note: it is simply never billed.",
  "- **The rest was billed** and is credited on the bill line named (`billId` + `billLineId`) at the bill line's `unitCost`, VAT reversed at its rate. One **debit note** (`type: return`) is created per bill credited, dated `returnDate`, and its credit is applied to that bill straight away (see Debit Notes).",
  "- Counts toward the vendor's purchase documents (`VENDOR_IN_USE` on delete).",
  "- The receipt, the variant's `lastPurchase` and the product's `costPrice` do not change.",
].join("\n");

const RETURN_LINE_RULES = [
  "**Lines** (1 to 200)",
  "- Each line names a goods receipt line: `goodsReceiptId` + `goodsReceiptLineId` (the receipt's `lines[].id`), each receipt line at most once. The receipt must be **this store's** and from the return's `vendorId`. Goods not on a receipt cannot be returned.",
  "- `quantity` can never take the receipt line's `returnedQuantity` above its received `quantity`.",
  "- `billId` + `billLineId` are needed only when `quantity` is more than the receipt line's `billableQuantity` (otherwise ignored). The bill line must bill this receipt line, on a bill that is not void, with enough quantity not yet credited. Goods billed across several bills: return them on separate returns, one bill line each.",
  "- The store must have the stock: returning more than is on hand is refused (`INSUFFICIENT_STOCK`). Goods written off with a stock adjustment are no longer on hand, so return damaged goods **before** adjusting them out.",
  `- ${QUANTITY_RULE}`,
].join("\n");

const RETURN_DATE_RULE =
  "`returnDate` defaults to today in **the store's timezone**. It cannot be in the future, before the latest `receivedDate` of the receipts returned, or before the `billDate` of a bill credited (`VALIDATION_FAILED` on `returnDate`).";

const RETURN_CONCURRENCY =
  "**Two returns, or a return and a bill, at once** for the same receipt line or bill line are each checked against the line as it is at that moment: one that would go over gets the 409 for that ceiling, and nothing is applied.";

const DEBIT_NOTE_MONEY = [
  "**Credit** (organization currency)",
  "- Each line credits a bill line: VAT-exclusive `subtotal`, plus VAT at **the bill line's rate** (none when the bill line carried none, e.g. an `overseas` or unregistered vendor). Together, a bill line's credits (returns and price adjustments) can never exceed its `subtotal`.",
  "- The note's `total` is applied to **its own bill first**, up to the bill's `balanceDue`: the bill's `credited` goes up, `balanceDue` down, and it moves to `partially_paid` or `paid` as with a payment.",
  "- Anything left over (the bill was already paid) stays on the note as **`unapplied`** vendor credit (`status: open`). Use it on the vendor's other open bills with `POST /debit-notes/{debitNoteId}/apply`. Cash refunds from the vendor are not recorded in v1.",
  "- Stock is never revalued: a price adjustment does not change stock cost or `costVariance`.",
].join("\n");

const read403Org = errorResponse(
  "No organization-scoped role grants `purchase:read` (store roles never can).",
  "Access Denied: You do not possess the required permission (purchase:read) to execute this action.",
  403
);

const list403 = errorResponse(
  "No role (organization or store) grants `purchase:read`.",
  "Access Denied: You do not possess the required permission (purchase:read) to execute this action.",
  403
);

const storeRead403 = errorResponse(
  "The caller has no access to this store, or has access but no role grants `purchase:read` for it.",
  "Access Denied: You do not possess the required permission (purchase:read) to execute this action.",
  403
);

const bill403 = errorResponse(
  "No organization-scoped role grants `purchase:bill`.",
  "Access Denied: You do not possess the required permission (purchase:bill) to execute this action.",
  403
);

const STORE_404_LINE = "- The store does not exist in your organization (or is deleted): message `Store not found.`, no `code`.";

const debitNoteNotFound = errorResponse(
  "`DEBIT_NOTE_NOT_FOUND`: no debit note with this id in your organization.",
  "Debit note not found.",
  404,
  "DEBIT_NOTE_NOT_FOUND"
);

const LIST_RULES = [
  "Query parsing is lenient and never returns 400: an invalid `page`/`limit`/date filter is ignored (defaults: page 1, limit 20); `limit` is capped at 100. A malformed id filter matches nothing.",
  "Date filters compare against plain calendar dates.",
].join("\n");

const RETURN_RESPONSE = (name: string, message: string, status = 200) =>
  json(successEnvelope(name, VendorReturnDataSchema, message, status));
const DEBIT_NOTE_RESPONSE = (name: string, message: string, status = 200) =>
  json(successEnvelope(name, DebitNoteDataSchema, message, status));

// ==========================================
// Vendor returns
// ==========================================

registry.registerPath({
  method: "get",
  path: returnOrgBase,
  tags: returnTags,
  summary: "List vendor returns (all stores)",
  description: [PREVIEW, "", returnListNote, "", "Paginated, newest return number first. A receipt's return history: `goodsReceiptId=…`.", "", LIST_RULES].join("\n"),
  security,
  request: { query: listVendorReturnsQuerySchema },
  responses: {
    200: {
      description: "Returns fetched. Each item is a summary (no lines; `lineCount` instead).",
      content: json(successEnvelope("VendorReturnListResponse", VendorReturnListDataSchema, "Vendor returns fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: list403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: returnStoreBase,
  tags: returnTags,
  summary: "List a store's vendor returns",
  description: [PREVIEW, "", returnReadNote, "", "The same list for this store only (a `storeId` query filter is ignored here).", "", LIST_RULES].join("\n"),
  security,
  request: { params: storeIdParam, query: listVendorReturnsQuerySchema },
  responses: {
    200: {
      description: "Returns fetched.",
      content: json(successEnvelope("StoreVendorReturnListResponse", VendorReturnListDataSchema, "Vendor returns fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: storeRead403,
    404: errorResponse(STORE_404_LINE, "Store not found.", 404),
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: returnPath,
  tags: returnTags,
  summary: "Get a vendor return",
  description: [PREVIEW, "", returnReadNote, "", "With its lines and the debit notes it created."].join("\n"),
  security,
  request: { params: returnParams },
  responses: {
    200: { description: "Return fetched.", content: RETURN_RESPONSE("GetVendorReturnResponse", "Vendor return fetched successfully.") },
    400: errorResponse("Malformed `vendorReturnId`.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: storeRead403,
    404: errorResponse(
      [
        "Not found:",
        STORE_404_LINE,
        "- `VENDOR_RETURN_NOT_FOUND`: no return with this id in this store (another store's or organization's return looks the same).",
      ].join("\n"),
      "Vendor return not found.",
      404,
      "VENDOR_RETURN_NOT_FOUND"
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: returnStoreBase,
  tags: returnTags,
  summary: "Return goods to a vendor",
  description: [
    PREVIEW,
    "",
    returnCreateNote,
    "",
    "Sends received goods back to the vendor from this store. `vendorId` and `reason` (`damaged`, `expired`, `wrong_item`, `excess` or `other`) are required. A deactivated vendor is fine; a deactivated store is not.",
    "",
    RETURN_WHAT_IT_DOES,
    "",
    RETURN_LINE_RULES,
    "",
    RETURN_DATE_RULE,
    "",
    RETURN_CONCURRENCY,
    "",
    IDEMPOTENCY,
  ].join("\n"),
  security,
  request: {
    params: storeIdParam,
    headers: idempotencyHeadersSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createVendorReturnSchema,
          examples: {
            billed: { summary: "Damaged goods, part already billed (creates a debit note)", value: vendorReturnExample },
            unbilled: { summary: "Excess goods before any bill (no debit note)", value: vendorReturnUnbilledExample },
          },
        },
      },
    },
  },
  responses: {
    201: { description: "Return posted.", headers: REPLAY_HEADERS, content: RETURN_RESPONSE("CreateVendorReturnResponse", "Vendor return posted successfully.", 201) },
    400: errorResponse(
      [
        "Bad request. Codes:",
        "- `VALIDATION_FAILED`: a schema rule (see `errors`), a missing or malformed `Idempotency-Key`, a `returnDate` out of range, or a fractional quantity for a whole-number unit.",
        "- `VENDOR_NOT_FOUND`: `vendorId` does not exist in your organization (`errors[0].field` is `vendorId`).",
        "- Line problems are collected in one response, one `errors` item per bad line; the top-level `code` is the first item's:",
        "  - `VENDOR_MISMATCH`: the receipt is from a different vendor (`meta: { goodsReceiptNumber }`).",
        "  - `BILL_LINE_MISMATCH`: the bill line does not bill this receipt line (`errors[].field` is `lines[i].billLineId`).",
      ].join("\n"),
      "Request Validation Failed: lines[0].billLineId: billId and billLineId are sent together.",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: errorResponse(
      "No access to this store, no role granting `purchase:return` for it, or the store is deactivated.",
      "Access Denied: You do not possess the required permission (purchase:return) to execute this action.",
      403
    ),
    404: errorResponse(
      [
        "Not found:",
        STORE_404_LINE,
        "- `GOODS_RECEIPT_NOT_FOUND`: a `goodsReceiptId` is not one of this store's receipts, or the `goodsReceiptLineId` is not on it (`errors[].field` is `lines[i].goodsReceiptId` or `lines[i].goodsReceiptLineId`).",
        "- `BILL_NOT_FOUND`: a `billId` is not one of your organization's bills, or the `billLineId` is not on it.",
      ].join("\n"),
      "Goods receipt not found.",
      404,
      "GOODS_RECEIPT_NOT_FOUND"
    ),
    409: idempotency409(
      [
        "Line problems are collected, one `errors` item per line (`errors[].field` is `lines[i].quantity` unless noted); nothing is applied:",
        "- `RETURNED_QUANTITY_EXCEEDS_RECEIVED`: more than was received would have been returned. `meta: { received, returned, remaining }`.",
        "- `BILL_LINE_REQUIRED`: part of `quantity` was already billed and no `billId` + `billLineId` was sent. `meta: { billable }` (what can go back without one).",
        "- `CREDITED_QUANTITY_EXCEEDS_BILLED`: the bill line has fewer units left to credit than the billed part of `quantity`. `meta: { billed, credited, remaining }`. Return the rest against its other bill line.",
        "- `BILL_STATUS_CONFLICT`: the bill named is void (`errors[].field` is `lines[i].billId`).",
        "- `INSUFFICIENT_STOCK`: the store has less on hand than `quantity`. `{ field: \"lines[0]\", code, meta: { variantId, available, requested } }`.",
      ],
      {
        message: "Part of this quantity was billed: name the bill line to credit.",
        code: "BILL_LINE_REQUIRED",
        errors: [{ field: "lines[0].quantity", code: "BILL_LINE_REQUIRED", meta: { billable: 1 } }],
      }
    ),
    500: server500,
  },
});

// ==========================================
// Debit notes
// ==========================================

registry.registerPath({
  method: "get",
  path: debitNoteBase,
  tags: debitNoteTags,
  summary: "List debit notes",
  description: [
    PREVIEW,
    "",
    debitNoteReadNote,
    "",
    "Paginated, newest number first. A vendor's credit still to use: `vendorId=…&status=open` (sum their `unapplied`).",
    "",
    LIST_RULES,
  ].join("\n"),
  security,
  request: { query: listDebitNotesQuerySchema },
  responses: {
    200: {
      description: "Debit notes fetched. Each item is a summary (no lines or applications; `lineCount` instead).",
      content: json(successEnvelope("DebitNoteListResponse", DebitNoteListDataSchema, "Debit notes fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: read403Org,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: debitNotePath,
  tags: debitNoteTags,
  summary: "Get a debit note",
  description: [PREVIEW, "", debitNoteReadNote, "", "With its lines and applications. `bills` in `data` is always empty here."].join("\n"),
  security,
  request: { params: debitNoteIdParam },
  responses: {
    200: { description: "Debit note fetched.", content: DEBIT_NOTE_RESPONSE("GetDebitNoteResponse", "Debit note fetched successfully.") },
    400: errorResponse("Malformed `debitNoteId`.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: read403Org,
    404: debitNoteNotFound,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: debitNoteBase,
  tags: debitNoteTags,
  summary: "Record a price adjustment debit note",
  description: [
    PREVIEW,
    "",
    debitNoteWriteNote,
    "",
    "Records that the vendor over-charged on a bill (`type: price_adjustment`). Returned goods do not go here: a vendor return creates its own debit note.",
    "- Against one bill (`billId`), which must not be void; the vendor comes from it. Each line names a bill line (goods or service) and the VAT-exclusive `amount` credited.",
    "- `reason` is required; `vendorReference` holds the vendor's credit note number if they issued one.",
    "- `debitNoteDate` defaults to today (organization timezone); cannot be in the future or before the bill's `billDate`.",
    "",
    "**What it does** (all in one step): posts the note (DN-00001, DN-00002…, per organization, shared with return notes), adds each line's amount to the bill line's `credited`, and applies the credit to the bill. `data.bills` returns the bill after the change. Counts toward the vendor's purchase documents.",
    "",
    DEBIT_NOTE_MONEY,
    "",
    IDEMPOTENCY,
  ].join("\n"),
  security,
  request: {
    headers: idempotencyHeadersSchema,
    body: { required: true, content: { "application/json": { schema: createDebitNoteSchema, example: debitNoteExample } } },
  },
  responses: {
    201: {
      description: "Debit note recorded.",
      headers: REPLAY_HEADERS,
      content: DEBIT_NOTE_RESPONSE("CreateDebitNoteResponse", "Debit note recorded successfully.", 201),
    },
    400: errorResponse(
      [
        "Bad request. Codes:",
        "- `VALIDATION_FAILED`: a schema rule (see `errors`), a missing or malformed `Idempotency-Key`, or a `debitNoteDate` in the future or before the bill's `billDate`.",
        "- `TOO_MANY_DECIMALS` / `INVALID_AMOUNT` / `AMOUNT_OUT_OF_RANGE`: an `amount` does not fit the organization's currency.",
      ].join("\n"),
      "Request Validation Failed: lines[0].amount: amount must be greater than zero.",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: bill403,
    404: errorResponse(
      "`BILL_NOT_FOUND`: `billId` is not one of your organization's bills (`errors[0].field` is `billId`), or a `billLineId` is not on it (`errors[].field` is `lines[i].billLineId`).",
      "Bill not found.",
      404,
      "BILL_NOT_FOUND"
    ),
    409: idempotency409(
      [
        "- `BILL_STATUS_CONFLICT`: the bill is void.",
        "- `CREDIT_EXCEEDS_BILLED`: a line would credit more than the bill line's `subtotal` with earlier credits. One item per line, `errors[].field` is `lines[i].amount`, `meta` is `{ subtotal, credited, remaining }`.",
      ],
      {
        message: "This would credit more than was billed on the line.",
        code: "CREDIT_EXCEEDS_BILLED",
        errors: [{ field: "lines[0].amount", code: "CREDIT_EXCEEDS_BILLED", meta: { subtotal: "39.600", credited: "39.000", remaining: "0.600" } }],
      }
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${debitNotePath}/apply`,
  tags: debitNoteTags,
  summary: "Apply a debit note's credit to other bills",
  description: [
    PREVIEW,
    "",
    debitNoteWriteNote,
    "",
    "Uses a note's `unapplied` credit (left over because its own bill was already paid) on other bills of **the same vendor**, like a payment that moves no money.",
    "- Each application names an `unpaid` or `partially_paid` bill and an `amount` up to its `balanceDue`. Together they cannot exceed the note's `unapplied`.",
    "- Each bill's `credited` goes up and its status moves to `partially_paid` or `paid`; the bills' and the note's `version` go up. The note becomes `applied` once nothing is left.",
    "- Applications cannot be undone one by one: void the note (price adjustments only) and record it again.",
    "",
    IDEMPOTENCY,
  ].join("\n"),
  security,
  request: {
    params: debitNoteIdParam,
    headers: idempotencyHeadersSchema,
    body: { required: true, content: { "application/json": { schema: applyDebitNoteSchema, example: applyDebitNoteExample } } },
  },
  responses: {
    200: {
      description: "Credit applied. `data.bills` are the bills it went to, after the change.",
      headers: REPLAY_HEADERS,
      content: DEBIT_NOTE_RESPONSE("ApplyDebitNoteResponse", "Debit note credit applied successfully."),
    },
    400: errorResponse(
      [
        "Bad request. Codes:",
        "- `VALIDATION_FAILED`: a schema rule (e.g. a bill listed twice), or a missing or malformed `Idempotency-Key`.",
        "- `VENDOR_MISMATCH`: a bill belongs to a different vendor (`errors[].field` is `applications[i].billId`).",
        "- `TOO_MANY_DECIMALS` / `INVALID_AMOUNT` / `AMOUNT_OUT_OF_RANGE`: an `amount` does not fit the organization's currency.",
      ].join("\n"),
      "Request Validation Failed: applications: Bill '665f1c2e8a4b3c0012ab3e10' is listed more than once.",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: bill403,
    404: errorResponse(
      "`DEBIT_NOTE_NOT_FOUND`, or `BILL_NOT_FOUND`: a bill does not exist in your organization (`errors[].field` is `applications[i].billId`).",
      "Debit note not found.",
      404,
      "DEBIT_NOTE_NOT_FOUND"
    ),
    409: idempotency409(
      [
        "- `DEBIT_NOTE_VERSION_CONFLICT`: the note changed since you loaded it (`errors[0].meta.currentVersion`).",
        "- `DEBIT_NOTE_STATUS_CONFLICT`: the note is void, or fully applied.",
        "- `CREDIT_EXCEEDS_AVAILABLE`: the applications add up to more than `unapplied`. `errors[0].field` is `applications`, `meta` is `{ unapplied }`.",
        "- `BILL_STATUS_CONFLICT`: a bill is `paid` or `void`. `errors[].field` is `applications[i].billId`, `meta` is `{ status }`.",
        "- `CREDIT_EXCEEDS_DUE`: an application is more than the bill's `balanceDue` (perhaps a payment got there first). One item per application, `errors[].field` is `applications[i].amount`, `meta` is `{ balanceDue }`.",
      ],
      {
        message: "This credit is more than the debit note has left.",
        code: "CREDIT_EXCEEDS_AVAILABLE",
        errors: [{ field: "applications", code: "CREDIT_EXCEEDS_AVAILABLE", meta: { unapplied: "1.000" } }],
      }
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${debitNotePath}/void`,
  tags: debitNoteTags,
  summary: "Void a price adjustment debit note",
  description: [
    PREVIEW,
    "",
    debitNoteWriteNote,
    "",
    "Cancels a price adjustment recorded by mistake. Every application is reversed in the same step: each bill's `credited` goes down and its status moves back to `partially_paid` or `unpaid`; the bill lines' `credited` goes down. The note keeps its number (status `void`, `voided`, `voidReason`).",
    "",
    "A note created by a return cannot be voided (`DEBIT_NOTE_FROM_RETURN`): the goods really went back. Goods sent back by mistake come in again on a new goods receipt (and a new bill if the vendor invoices them).",
    "",
    IDEMPOTENCY,
  ].join("\n"),
  security,
  request: {
    params: debitNoteIdParam,
    headers: idempotencyHeadersSchema,
    body: { required: true, content: { "application/json": { schema: voidDebitNoteSchema, example: voidDebitNoteExample } } },
  },
  responses: {
    200: {
      description: "Debit note voided. `data.bills` are the bills it had credited, after the reversal.",
      headers: REPLAY_HEADERS,
      content: DEBIT_NOTE_RESPONSE("VoidDebitNoteResponse", "Debit note voided successfully."),
    },
    400: errorResponse(
      "`VALIDATION_FAILED`: `version` or `reason` missing, or a missing or malformed `Idempotency-Key`.",
      "Request Validation Failed: reason: reason is required.",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: bill403,
    404: debitNoteNotFound,
    409: idempotency409(
      [
        "- `DEBIT_NOTE_VERSION_CONFLICT`: the note changed since you loaded it (`errors[0].meta.currentVersion`).",
        "- `DEBIT_NOTE_STATUS_CONFLICT`: the note is already void.",
        "- `DEBIT_NOTE_FROM_RETURN`: the note was created by a return (`errors[0].meta.vendorReturnNumber`).",
      ],
      { message: "A debit note created by a return cannot be voided.", code: "DEBIT_NOTE_FROM_RETURN", errors: [{ code: "DEBIT_NOTE_FROM_RETURN", meta: { vendorReturnNumber: "RTN-00003" } }] }
    ),
    500: server500,
  },
});
