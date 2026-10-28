import { registry, z } from "../config/openapi.registry";
import { createGoodsReceiptSchema, listGoodsReceiptsQuerySchema } from "../validators/goodsReceipt.validator";
import { idempotencyHeadersSchema } from "../validators/stock.validator";
import { GoodsReceiptDataSchema, GoodsReceiptListDataSchema, successEnvelope } from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";
import { IDEMPOTENCY, idempotency409, QUANTITY_RULE, REPLAY_HEADERS } from "./stock.openapi";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Goods Receipts"];
// Goods arrive at one store, so everything but the cross-store list lives under the store path:
// scopeToStore then verifies the store before the store-level permission is checked.
const orgBase = `${API}/goods-receipts`;
const storeBase = `${API}/stores/{storeId}/goods-receipts`;
const grnPath = `${storeBase}/{goodsReceiptId}`;

const storeIdParam = z.object({
  storeId: z.string().openapi({ description: "Store ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3400" }),
});

const grnParams = storeIdParam.extend({
  goodsReceiptId: z.string().openapi({
    description: "Goods receipt ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab3d00",
  }),
});

/** Part of a PO arrived: one line in full, half of the other, at the PO's costs. */
export const goodsReceiptExample = {
  purchaseOrderId: "665f1c2e8a4b3c0012ab3c00",
  receivedDate: "2026-10-28",
  vendorReference: "DN-55120",
  notes: "Two cartons slightly crushed, contents fine.",
  lines: [
    { purchaseOrderLineId: "665f1c2e8a4b3c0012ab3c01", quantity: 24 },
    { purchaseOrderLineId: "665f1c2e8a4b3c0012ab3c02", quantity: 6.25, note: "Rest to follow next week" },
  ],
};

/** The vendor invoiced a different price for one PO line (needs purchase:order). */
export const goodsReceiptCostChangeExample = {
  purchaseOrderId: "665f1c2e8a4b3c0012ab3c00",
  lines: [{ purchaseOrderLineId: "665f1c2e8a4b3c0012ab3c01", quantity: 24, unitCost: "1.650" }],
};

/** Goods bought without a PO (needs purchase:order). */
export const goodsReceiptWithoutPoExample = {
  vendorId: "665f1c2e8a4b3c0012ab3900",
  vendorReference: "INV-88231",
  lines: [{ variantId: "665f1c2e8a4b3c0012ab3801", quantity: 12, unitCost: "1.600" }],
};

// ==========================================
// Shared descriptions
// ==========================================

const PREVIEW =
  "**Contract preview (Phase 3c):** documented for frontend review; returns 404 until implemented.";

const readNote =
  "Requires a **tenant** bearer token and **`purchase:read`** for this store: a store role at this store, or an organization-scoped role. Works for a deactivated store too.";

const listNote =
  "Requires a **tenant** bearer token and **`purchase:read`** held anywhere (org role or any store role). Store staff see only receipts of stores where they hold `purchase:read`; an organization-scoped role sees every store's.";

const createNote = [
  "Requires a **tenant** bearer token and **`purchase:receive`** for this store (a store role at this store, or an organization-scoped role). Seeded on org_admin, store_manager and inventory_clerk.",
  "",
  "Also needs **`purchase:order`** for this store when the receipt sets what stock is worth:",
  "- a receipt **without a PO**, or",
  "- a line whose `unitCost` differs from the PO line's.",
  "",
  "So an inventory clerk can receive against a PO at the PO's costs; a cost change or a delivery with no PO goes to a store manager. Costs are shown to everyone with `purchase:read`, as on POs.",
].join("\n");

const WHAT_IT_DOES = [
  "**What a receipt does** (all in one step, all or nothing):",
  "- Posts the receipt with its number (GRN-00001, GRN-00002…, per organization). It is **final**: no drafts, edits or void. Fix a mistake with a stock adjustment (or a return to vendor, Phase 3e).",
  "- Adds stock in this store for each line whose product tracks inventory: a `purchase` movement at `stockUnitCost`, recalculating the weighted average cost. The movement is dated when the receipt is posted; `receivedDate` is shown on the receipt but never rewrites stock history.",
  "- Lines for goods that do not track inventory are recorded (`stocked: false`) but change no stock.",
  "- Against a PO: adds to each PO line's `receivedQuantity` and sets the PO to `partially_received`, or `received` once every line is complete. The PO's `version` goes up by one, so an edit someone had open on it gets `PURCHASE_ORDER_VERSION_CONFLICT`; from the first receipt the PO is locked.",
  "- Updates each variant's `lastPurchase` (cost, date, vendor, receipt). The product's `costPrice` is never changed.",
].join("\n");

const COST_RULES = [
  "**Costs**",
  "- `unitCost` is VAT-exclusive, at the currency's decimals. Against a PO it defaults to the PO line's `unitCost`.",
  "- `stockUnitCost` (the cost that goes into stock) equals `unitCost`, except when **the organization has no TRN**: it cannot reclaim input VAT, so the VAT is added to the cost. The rate is the PO line's (or, without a PO, the product's or the organization's default), and only when the vendor is `vat_registered` and the product `standard`.",
  "- No freight or duty sharing (landed cost) in v1. A vendor bill that differs later (Phase 3d) does not change stock values.",
].join("\n");

const LINE_RULES = [
  "**Lines**",
  "- 1 to 200 lines.",
  "- **Against a PO** (`purchaseOrderId`): each line sends `purchaseOrderLineId` (the PO's `lines[].id`), each PO line at most once. Lines you leave out are simply not received this time. A line cannot go above what was ordered: `receivedQuantity` + this `quantity` ≤ `quantity` on the PO line. Extra goods go on a receipt without a PO.",
  "- **Without a PO** (`vendorId`): each line sends `variantId` and `unitCost`, each variant at most once. Goods only (`VARIANT_NOT_PURCHASABLE` for a service). Inactive products and variants are allowed.",
  `- ${QUANTITY_RULE} The unit is checked again here, so a product whose unit changed to a whole-number one since the PO was issued needs whole quantities.`,
].join("\n");

const CONCURRENCY = [
  "**Two receipts at once:** no PO `version` is sent, so two people receiving the same PO do not block each other; each receipt is checked against the PO as it is at that moment.",
  "- If the PO was edited after you loaded it, its line ids changed: a `purchaseOrderLineId` that is no longer on the PO gets 409 `PURCHASE_ORDER_CHANGED`. Reload the PO and enter the receipt again.",
  "- If another receipt took a line's remaining quantity first, the line is refused with 409 `RECEIVED_QUANTITY_EXCEEDS_ORDERED`.",
].join("\n");

const DATE_RULE =
  "`receivedDate` defaults to today in **the store's timezone**. It cannot be in the future, or (against a PO) before the PO's `orderDate` (`VALIDATION_FAILED` on `receivedDate`).";

const list403 = errorResponse(
  "No role (organization or store) grants `purchase:read`.",
  "Access Denied: You do not possess the required permission (purchase:read) to execute this action.",
  403
);

const read403 = errorResponse(
  "The caller has no access to this store, or has access but no role grants `purchase:read` for it.",
  "Access Denied: You do not possess the required permission (purchase:read) to execute this action.",
  403
);

const create403 = errorResponse(
  [
    "Forbidden:",
    "- No access to this store, no role granting `purchase:receive` for it, or the store is deactivated.",
    "- `purchase:order` is also needed (receipt without a PO, or a changed `unitCost`) and no role grants it for this store. `errors[0].field` is `vendorId` or `lines[i].unitCost`.",
  ].join("\n"),
  "Access Denied: You do not possess the required permission (purchase:receive) to execute this action.",
  403
);

const STORE_404_LINE = "- The store does not exist in your organization (or is deleted): message `Store not found.`, no `code`.";

const store404 = errorResponse(STORE_404_LINE, "Store not found.", 404);

const notFound404 = errorResponse(
  [
    "Not found:",
    STORE_404_LINE,
    "- `GOODS_RECEIPT_NOT_FOUND`: no receipt with this id in this store (another store's or organization's receipt looks the same).",
  ].join("\n"),
  "Goods receipt not found.",
  404,
  "GOODS_RECEIPT_NOT_FOUND"
);

const LIST_RULES = [
  "Paginated, newest receipt number first. A PO's delivery history: `purchaseOrderId=…`.",
  "Query parsing is lenient and never returns 400: an invalid `page`/`limit`/`from`/`to` is ignored (defaults: page 1, limit 20); `limit` is capped at 100. A malformed `storeId`, `vendorId` or `purchaseOrderId` filter matches nothing.",
  "`from` / `to` compare against `receivedDate`, a plain calendar date.",
].join("\n");

const GRN_RESPONSE = (name: string, message: string, status = 200) =>
  json(successEnvelope(name, GoodsReceiptDataSchema, message, status));

// ==========================================
// List and read
// ==========================================

registry.registerPath({
  method: "get",
  path: orgBase,
  tags,
  summary: "List goods receipts across stores",
  description: [PREVIEW, "", listNote, "", LIST_RULES].join("\n"),
  security,
  request: { query: listGoodsReceiptsQuerySchema },
  responses: {
    200: {
      description: "Goods receipts fetched. Each item is a summary (no lines; `lineCount` instead).",
      content: json(successEnvelope("GoodsReceiptListResponse", GoodsReceiptListDataSchema, "Goods receipts fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: list403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: storeBase,
  tags,
  summary: "List a store's goods receipts",
  description: [PREVIEW, "", readNote, "", "The same list for this store only (a `storeId` query filter is ignored here).", "", LIST_RULES].join("\n"),
  security,
  request: { params: storeIdParam, query: listGoodsReceiptsQuerySchema.omit({ storeId: true }) },
  responses: {
    200: {
      description: "Goods receipts fetched.",
      content: json(successEnvelope("StoreGoodsReceiptListResponse", GoodsReceiptListDataSchema, "Goods receipts fetched successfully.")),
    },
    400: errorResponse("Malformed `storeId` in the path.", "Invalid storeId format. Must be a 24-character hex string.", 400),
    401: TENANT_AUTH_401,
    403: read403,
    404: store404,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: grnPath,
  tags,
  summary: "Get a goods receipt",
  description: [PREVIEW, "", readNote, "", "`purchaseOrder` in `data` is always null here: fetch the PO for its current state."].join("\n"),
  security,
  request: { params: grnParams },
  responses: {
    200: { description: "Goods receipt fetched.", content: GRN_RESPONSE("GetGoodsReceiptResponse", "Goods receipt fetched successfully.") },
    400: errorResponse("Malformed `goodsReceiptId`.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: read403,
    404: notFound404,
    500: server500,
  },
});

// ==========================================
// Create
// ==========================================

registry.registerPath({
  method: "post",
  path: storeBase,
  tags,
  summary: "Receive goods",
  description: [
    PREVIEW,
    "",
    createNote,
    "",
    "Records goods that arrived at this store, against a purchase order or without one. The store comes from the URL and must be active.",
    "- Against a PO: send `purchaseOrderId`. The PO must be in this store and `issued` or `partially_received`; the vendor comes from it (do not send `vendorId`). An issued PO whose vendor was deactivated later can still be received.",
    "- Without a PO: send `vendorId` (an active vendor).",
    "- Amounts are in the organization's currency (no foreign-currency receipts in v1).",
    "",
    WHAT_IT_DOES,
    "",
    LINE_RULES,
    "",
    COST_RULES,
    "",
    DATE_RULE,
    "",
    CONCURRENCY,
    "",
    "Stock is added whatever `allowNegativeStock` says; a store with negative stock is brought back up and its average becomes the receipt's cost (the usual weighted-average rule).",
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
          schema: createGoodsReceiptSchema,
          examples: {
            partial: { summary: "Part of a PO arrived, at the PO's costs", value: goodsReceiptExample },
            costChange: { summary: "The vendor charged a different price (needs purchase:order)", value: goodsReceiptCostChangeExample },
            withoutPo: { summary: "Goods bought without a PO (needs purchase:order)", value: goodsReceiptWithoutPoExample },
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: "Goods received. `data.purchaseOrder` is the PO after this receipt (null without a PO).",
      headers: REPLAY_HEADERS,
      content: GRN_RESPONSE("CreateGoodsReceiptResponse", "Goods received successfully.", 201),
    },
    400: errorResponse(
      [
        "Bad request. Codes:",
        "- `VALIDATION_FAILED`: a schema rule (see `errors`), a missing or malformed `Idempotency-Key`, a `receivedDate` in the future or before the PO's `orderDate`, or a fractional quantity for a whole-number unit (`errors[].field` is `lines[i].quantity`).",
        "- `VENDOR_NOT_FOUND` / `VENDOR_INACTIVE`: without a PO, `vendorId` does not exist or is deactivated (`errors[0].field` is `vendorId`).",
        "- Line problems are collected in one response, one `errors` item per bad line; the top-level `code` is the first item's:",
        "  - `VARIANT_NOT_FOUND`: without a PO, the variant does not exist in your organization or is deleted.",
        "  - `VARIANT_NOT_PURCHASABLE`: without a PO, the variant's product is a service.",
        "  - `TOO_MANY_DECIMALS` / `INVALID_AMOUNT` / `AMOUNT_OUT_OF_RANGE`: a `unitCost` does not fit the organization's currency.",
        "- A malformed `storeId` in the path also returns 400 (no `code`).",
      ].join("\n"),
      "Request Validation Failed: vendorId: Send purchaseOrderId, or vendorId for a receipt without a purchase order.",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: create403,
    404: errorResponse(
      ["Not found:", STORE_404_LINE, "- `PURCHASE_ORDER_NOT_FOUND`: no PO with this id in this store (`errors[0].field` is `purchaseOrderId`)."].join("\n"),
      "Purchase order not found.",
      404,
      "PURCHASE_ORDER_NOT_FOUND"
    ),
    409: idempotency409(
      [
        "- `PURCHASE_ORDER_STATUS_CONFLICT`: the PO is not `issued` or `partially_received` (a draft, or received, cancelled or closed). `errors[0].meta` has `{ status, allowed }`.",
        "- `PURCHASE_ORDER_CHANGED`: a `purchaseOrderLineId` is not on the PO (it was edited since you loaded it). `errors[].field` is `lines[i].purchaseOrderLineId`. Reload the PO.",
        "- `RECEIVED_QUANTITY_EXCEEDS_ORDERED`: a line would go above its ordered quantity. One item per line, `errors[].field` is `lines[i].quantity`, `meta` is `{ ordered, received, remaining }`.",
      ],
      {
        message: "More than was ordered would be received on this line.",
        code: "RECEIVED_QUANTITY_EXCEEDS_ORDERED",
        errors: [
          {
            field: "lines[1].quantity",
            code: "RECEIVED_QUANTITY_EXCEEDS_ORDERED",
            meta: { ordered: 12.5, received: 6.25, remaining: 6.25 },
          },
        ],
      }
    ),
    500: server500,
  },
});
