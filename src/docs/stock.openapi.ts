import { registry, z } from "../config/openapi.registry";
import {
  createStockAdjustmentSchema,
  createStockTransferSchema,
  idempotencyHeadersSchema,
  listStockAdjustmentsQuerySchema,
  listStockMovementsQuerySchema,
  listStockQuerySchema,
  listStockTransfersQuerySchema,
} from "../validators/stock.validator";
import {
  ProductStockDataSchema,
  StockAdjustmentDataSchema,
  StockAdjustmentListDataSchema,
  StockLevelListDataSchema,
  StockMovementListDataSchema,
  StockTransferDataSchema,
  StockTransferListDataSchema,
  successEnvelope,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Inventory"];

const storeIdParam = z.object({
  storeId: z.string().openapi({ description: "Store ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3400" }),
});

const storeNote = (permission: string) =>
  `Requires a **tenant** bearer token and **\`${permission}\`** for this store: a store role at this store, or an organization-scoped role.`;

const orgNote = (permission: string) =>
  `Requires a **tenant** bearer token, an **organization-scoped role** and **\`${permission}\`**.`;

const store403 = (permission: string) =>
  errorResponse(
    `No role grants \`${permission}\` for this store, the caller has no access to this store, or the store is deactivated.`,
    `Access Denied: You do not possess the required permission (${permission}) to execute this action.`,
    403
  );

const store404 = errorResponse("The store does not exist in your organization (or is deleted).", "Store not found.", 404);

const malformedStore400 = errorResponse(
  "Malformed `storeId` in the path.",
  "Invalid storeId format. Must be a 24-character hex string.",
  400
);

const LIST_PARSING =
  "Query parsing is lenient and never returns 400: an unrecognised filter value or an invalid `page`/`limit`/`from`/`to` is ignored (defaults: page 1, limit 20); `limit` is capped at 100 and `page` at 1,000,000. A malformed id used as a filter (`productId`, `variantId`, `categoryId`, `storeId`) matches nothing and returns an empty list.";

const DATE_RULE =
  "`from` / `to` bare dates are read in the **organization's timezone** (`GET /organization` → `settings.timezone`), not UTC, and both days are included.";

const COST_VISIBILITY =
  "Cost figures (`averageCost`, `stockValue`) need **`inventory:read`** for this store as well; without it they are `null` and quantities are still shown.";

export const IDEMPOTENCY = [
  "**Idempotency** (`Idempotency-Key` header, required)",
  "- Generate one key (a UUID) when the user presses Save, and reuse it for every retry of that same action.",
  "- Same key and same body within 24 hours: the original response is returned again (same status and body) with the header `Idempotent-Replayed: true`. Nothing is applied twice.",
  "- Same key with a different body, endpoint or user: 409 `IDEMPOTENCY_KEY_REUSED`.",
  "- Same key while the first request is still being processed: 409 `IDEMPOTENCY_IN_PROGRESS`; retry shortly.",
  "- Only successful responses are remembered: after a 4xx/5xx, fix the request and retry with the same key.",
].join("\n");

export const REPLAY_HEADERS = {
  "Idempotent-Replayed": {
    description:
      "Present with value `true` only when this is the stored response to an earlier request with the same `Idempotency-Key` (nothing was applied again).",
    schema: { type: "string" as const, enum: ["true"] },
  },
};

export const QUANTITY_RULE =
  "Quantities are numbers: whole unless the product's unit is kg, g, L, mL, m or cm (up to 3 decimals).";

const COST_RULE =
  "Costs are VAT-exclusive decimal strings at the organization's currency decimals, valued at **weighted average cost per store**: removing stock uses the current average (the average does not change); adding stock at a `unitCost` recalculates it. When the store's stock is 0 or negative before stock is added, the average becomes that `unitCost`.";

export const idempotency409 = (extra: string[], example: { message: string; code: string; errors?: unknown[] }) =>
  errorResponse(
    [
      "Conflict. Codes:",
      ...extra,
      "- `IDEMPOTENCY_KEY_REUSED`: this `Idempotency-Key` was already used for a different request.",
      "- `IDEMPOTENCY_IN_PROGRESS`: a request with this key is still being processed.",
    ].join("\n"),
    example.message,
    409,
    example.code,
    example.errors ?? []
  );

const INSUFFICIENT_STOCK_LINE =
  "- `INSUFFICIENT_STOCK`: a line would take stock below zero. One `errors` item per line: `{ field: \"lines[0]\", code, meta: { variantId, available, requested } }`. Nothing is applied. For a transfer `available` is never negative.";

const insufficientExample = {
  message: "Not enough stock for 'Crew-neck T-shirt - M / Red': 4 available, 6 requested.",
  code: "INSUFFICIENT_STOCK",
  errors: [
    {
      field: "lines[0]",
      code: "INSUFFICIENT_STOCK",
      meta: { variantId: "665f1c2e8a4b3c0012ab3801", available: 4, requested: 6 },
    },
  ],
};

const LINE_CODES = [
  "- Line problems are collected in one response: `errors` has one item per bad line and the top-level `code` is the first item's (the items can mix `VARIANT_NOT_FOUND` and `VARIANT_NOT_STOCKED`).",
  "- `VARIANT_NOT_FOUND`: a line's `variantId` does not exist in your organization or is deleted (`errors[].field` is `lines[i].variantId`). Inactive products and variants are allowed.",
  "- `VARIANT_NOT_STOCKED`: the variant's product is a service or does not track inventory (`errors[].field` is `lines[i].variantId`).",
  `- \`VALIDATION_FAILED\`: a schema rule (see \`errors\`), or a fractional quantity for a whole-number unit (\`errors[0].field\` names the line's quantity field). ${QUANTITY_RULE}`,
  "- `TOO_MANY_DECIMALS` / `INVALID_AMOUNT` / `AMOUNT_OUT_OF_RANGE`: a `unitCost` does not fit the organization's currency.",
];

// ==========================================
// Stock levels
// ==========================================

registry.registerPath({
  method: "get",
  path: `${API}/stores/{storeId}/stock`,
  tags,
  summary: "List stock in a store",
  description: [
    storeNote("product:read"),
    "",
    "One row per variant of every goods product that tracks inventory, including variants never stocked in this store (`quantity` 0, `lastMovementAt` null). Active products and variants only unless `includeInactive=true`. Sorted by product name, then variant name.",
    "- `search`, `categoryId` and `includeSubcategories` behave as in the product list.",
    "- `status`: `in_stock`, `out_of_stock`, `low` (at or below the reorder point; a never-stocked variant with a reorder point counts as low) or `negative`.",
    `- ${COST_VISIBILITY}`,
    `- ${LIST_PARSING}`,
  ].join("\n"),
  security,
  request: { params: storeIdParam, query: listStockQuerySchema },
  responses: {
    200: {
      description: "Stock fetched.",
      content: json(successEnvelope("StockLevelListResponse", StockLevelListDataSchema, "Stock fetched successfully.")),
    },
    400: malformedStore400,
    401: TENANT_AUTH_401,
    403: store403("product:read"),
    404: store404,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${API}/products/{productId}/stock`,
  tags,
  summary: "Stock of a product by store",
  description: [
    `Requires a **tenant** bearer token and **\`product:read\`** held anywhere (org role or any store role).`,
    "",
    "For the product page's stock tab: each variant (active and inactive) with its quantity in every **active store the caller can access** (all stores for an organization-scoped role, the assigned stores otherwise), including stores with quantity 0. `totalQuantity` sums the stores listed, so it can differ from the product's organization-wide `stockOnHand` for store staff.",
    "A product that does not track inventory returns `trackInventory: false` and quantities of 0.",
    "Cost figures need `inventory:read` for that store; otherwise they are `null`.",
  ].join("\n"),
  security,
  request: {
    params: z.object({
      productId: z.string().openapi({ description: "Product ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3800" }),
    }),
  },
  responses: {
    200: {
      description: "Stock fetched.",
      content: json(successEnvelope("ProductStockResponse", ProductStockDataSchema, "Stock fetched successfully.")),
    },
    400: errorResponse("Malformed productId.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: errorResponse(
      "No role (organization or store) grants `product:read`.",
      "Access Denied: You do not possess the required permission (product:read) to execute this action.",
      403
    ),
    404: errorResponse("Product does not exist in your organization. Code `PRODUCT_NOT_FOUND`.", "Product not found.", 404, "PRODUCT_NOT_FOUND"),
    500: server500,
  },
});

// ==========================================
// Movements (the ledger)
// ==========================================

registry.registerPath({
  method: "get",
  path: `${API}/stores/{storeId}/stock-movements`,
  tags,
  summary: "Stock history of a store",
  description: [
    storeNote("inventory:read"),
    "",
    "The store's stock ledger, newest first. Every change to stock is a movement and movements are never edited or deleted: a mistake is corrected with a new adjustment.",
    "- Filter by `productId`, `variantId`, `type`, `from` and `to`.",
    "- `type` may include values added by later phases (purchases, sales); show unknown types as they are. `opening` comes from product opening stock and from `opening_balance` adjustments.",
    `- ${DATE_RULE}`,
    `- ${LIST_PARSING}`,
  ].join("\n"),
  security,
  request: { params: storeIdParam, query: listStockMovementsQuerySchema },
  responses: {
    200: {
      description: "Movements fetched.",
      content: json(successEnvelope("StockMovementListResponse", StockMovementListDataSchema, "Stock movements fetched successfully.")),
    },
    400: malformedStore400,
    401: TENANT_AUTH_401,
    403: store403("inventory:read"),
    404: store404,
    500: server500,
  },
});

// ==========================================
// Adjustments
// ==========================================

const adjustmentExample = {
  reason: "damaged",
  note: "Carton dropped in the stockroom.",
  lines: [
    { variantId: "665f1c2e8a4b3c0012ab3801", quantityChange: -2 },
    { variantId: "665f1c2e8a4b3c0012ab3802", quantityChange: -1 },
  ],
};

const countExample = {
  reason: "count_correction",
  lines: [
    { variantId: "665f1c2e8a4b3c0012ab3801", countedQuantity: 18 },
    { variantId: "665f1c2e8a4b3c0012ab3810", countedQuantity: 2.75 },
  ],
};

const foundExample = {
  reason: "found",
  note: "Box found behind the counter.",
  lines: [{ variantId: "665f1c2e8a4b3c0012ab3801", quantityChange: 5, unitCost: "1.600" }],
};

registry.registerPath({
  method: "post",
  path: `${API}/stores/{storeId}/stock-adjustments`,
  tags,
  summary: "Adjust stock in a store",
  description: [
    storeNote("inventory:adjust"),
    "",
    "**Rules**",
    "- Each line sends **either** `quantityChange` (signed: +5 adds, -2 removes) **or** `countedQuantity` (what was physically counted; the server records the difference from the stock at the moment of saving, and writes no movement when it matches). Each variant at most once per adjustment.",
    "- `reason` decides the direction (400 `VALIDATION_FAILED` otherwise):",
    "  - `damaged`, `expired`, `theft_loss`: remove only (negative `quantityChange`).",
    "  - `found`: add only (positive `quantityChange`).",
    "  - `count_correction`: either direction, and the only reason besides `opening_balance` that accepts `countedQuantity`.",
    "  - `opening_balance`: first stock for a product created before stock tracking (or without opening stock); add only, or a count (a count below the current stock is refused with 400 `VALIDATION_FAILED` on `lines[i].countedQuantity`). Writes `opening` movements instead of `adjustment`.",
    "  - `other`: either direction; needs a `note`.",
    `- ${QUANTITY_RULE}`,
    `- ${COST_RULE} \`unitCost\` is the cost **per unit** for lines that add stock and defaults to the current average cost, then the variant's cost price, then 0. It is refused with a negative \`quantityChange\`; on a count line it is used only if the count raises stock.`,
    "- At most 200 lines: split a full stocktake into several adjustments, each with its own `Idempotency-Key`.",
    "- When the organization's `settings.inventory.allowNegativeStock` is false (default), a line may not take stock below zero (`INSUFFICIENT_STOCK`). A count never goes below zero.",
    "- All lines are applied together or not at all.",
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
          schema: createStockAdjustmentSchema,
          examples: {
            remove: { summary: "Write off damaged stock", value: adjustmentExample },
            count: { summary: "Set to counted quantity", value: countExample },
            add: { summary: "Add found stock at a cost", value: foundExample },
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: "Adjustment recorded. The response shows each line's quantity before and after; `unitCost` and `valueChange` are null when the caller lacks `inventory:read` for this store.",
      headers: REPLAY_HEADERS,
      content: json(successEnvelope("CreateStockAdjustmentResponse", StockAdjustmentDataSchema, "Stock adjusted successfully.", 201)),
    },
    400: errorResponse(
      [
        "Bad request. Codes:",
        "- `VALIDATION_FAILED` also covers a missing or malformed `Idempotency-Key` header.",
        ...LINE_CODES,
        "- A malformed `storeId` in the path also returns 400 (no `code`).",
      ].join("\n"),
      "Request Validation Failed: lines.0: Send exactly one of quantityChange or countedQuantity.",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: store403("inventory:adjust"),
    404: store404,
    409: idempotency409([INSUFFICIENT_STOCK_LINE], insufficientExample),
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${API}/stores/{storeId}/stock-adjustments`,
  tags,
  summary: "List a store's stock adjustments",
  description: [
    storeNote("inventory:read"),
    "",
    "Newest first, without lines (fetch one adjustment for its lines). Filter by `reason`, `from` and `to`.",
    `- ${DATE_RULE}`,
    `- ${LIST_PARSING}`,
  ].join("\n"),
  security,
  request: { params: storeIdParam, query: listStockAdjustmentsQuerySchema },
  responses: {
    200: {
      description: "Adjustments fetched.",
      content: json(successEnvelope("StockAdjustmentListResponse", StockAdjustmentListDataSchema, "Stock adjustments fetched successfully.")),
    },
    400: malformedStore400,
    401: TENANT_AUTH_401,
    403: store403("inventory:read"),
    404: store404,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${API}/stores/{storeId}/stock-adjustments/{adjustmentId}`,
  tags,
  summary: "Get a stock adjustment",
  description: storeNote("inventory:read"),
  security,
  request: {
    params: storeIdParam.extend({
      adjustmentId: z.string().openapi({ description: "Adjustment ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3a00" }),
    }),
  },
  responses: {
    200: {
      description: "Adjustment fetched.",
      content: json(successEnvelope("GetStockAdjustmentResponse", StockAdjustmentDataSchema, "Stock adjustment fetched successfully.")),
    },
    400: errorResponse(
      "Malformed `storeId` (message `Invalid storeId format. Must be a 24-character hex string.`) or `adjustmentId` (message `Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'`). No `code`.",
      "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'",
      400
    ),
    401: TENANT_AUTH_401,
    403: store403("inventory:read"),
    404: errorResponse(
      "The store does not exist, or the adjustment does not exist in this store (code `ADJUSTMENT_NOT_FOUND`).",
      "Stock adjustment not found.",
      404,
      "ADJUSTMENT_NOT_FOUND"
    ),
    500: server500,
  },
});

// ==========================================
// Transfers
// ==========================================

const transferExample = {
  fromStoreId: "665f1c2e8a4b3c0012ab3400",
  toStoreId: "665f1c2e8a4b3c0012ab3401",
  note: "Weekend restock for the mall branch.",
  lines: [
    { variantId: "665f1c2e8a4b3c0012ab3801", quantity: 6 },
    { variantId: "665f1c2e8a4b3c0012ab3810", quantity: 1.5 },
  ],
};

const transferIdParam = z.object({
  transferId: z.string().openapi({ description: "Transfer ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3b00" }),
});

const transferReadNote = `Requires a **tenant** bearer token and **\`inventory:read\`** held anywhere (org role or any store role). Store staff see only transfers into or out of stores where they hold \`inventory:read\`; an organization-scoped role sees all.`;

const transferRead403 = errorResponse(
  "No role (organization or store) grants `inventory:read`.",
  "Access Denied: You do not possess the required permission (inventory:read) to execute this action.",
  403
);

const transfer403 = errorResponse(
  "Not an organization-scoped role (message `Access Denied: This action requires an organization-level role.`), or the role lacks `inventory:transfer` (message `Access Denied: You do not possess the required permission (inventory:transfer) to execute this action.`).",
  "Access Denied: This action requires an organization-level role.",
  403
);

registry.registerPath({
  method: "post",
  path: `${API}/stock-transfers`,
  tags,
  summary: "Transfer stock between stores",
  description: [
    orgNote("inventory:transfer"),
    "",
    "**Rules**",
    "- One step: stock leaves `fromStoreId` and arrives at `toStoreId` immediately (a `transfer_out` and a `transfer_in` movement per line). There is no in-transit state.",
    "- Both stores must be stores of your organization and different from each other. The destination must be active; the **source may be deactivated**, so a closed branch can be emptied. (The per-store read endpoints, such as the stock list, return 403 for a deactivated store, and the product stock tab lists active stores only.)",
    `- ${QUANTITY_RULE} Each variant at most once per transfer.`,
    "- The source store must hold enough stock for every line, **even when the organization allows negative stock** (`INSUFFICIENT_STOCK`).",
    `- ${COST_RULE} Stock moves at the source store's average cost, and the destination's average is recalculated.`,
    "- All lines are applied together or not at all.",
    "",
    IDEMPOTENCY,
  ].join("\n"),
  security,
  request: {
    headers: idempotencyHeadersSchema,
    body: { required: true, content: { "application/json": { schema: createStockTransferSchema, example: transferExample } } },
  },
  responses: {
    201: {
      description: "Transfer recorded.",
      headers: REPLAY_HEADERS,
      content: json(successEnvelope("CreateStockTransferResponse", StockTransferDataSchema, "Stock transferred successfully.", 201)),
    },
    400: errorResponse(
      [
        "Bad request. Codes:",
        "- `VALIDATION_FAILED` also covers a missing or malformed `Idempotency-Key` header and `fromStoreId` equal to `toStoreId`.",
        "- `STORE_NOT_FOUND`: `fromStoreId` or `toStoreId` is not a store of your organization (`errors[0].field` names it).",
        "- `STORE_INACTIVE`: the destination store (`toStoreId`) is deactivated (`errors[0].field` is `toStoreId`). A deactivated source is allowed.",
        ...LINE_CODES.filter((line) => !line.includes("unitCost")),
      ].join("\n"),
      "Store not found.",
      400,
      "STORE_NOT_FOUND",
      [{ field: "toStoreId", code: "STORE_NOT_FOUND" }]
    ),
    401: TENANT_AUTH_401,
    403: transfer403,
    409: idempotency409([INSUFFICIENT_STOCK_LINE], insufficientExample),
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${API}/stock-transfers`,
  tags,
  summary: "List stock transfers",
  description: [
    transferReadNote,
    "",
    "Newest first, without lines. Filter by `storeId` (into or out of that store), `from` and `to`.",
    `- ${DATE_RULE}`,
    `- ${LIST_PARSING}`,
  ].join("\n"),
  security,
  request: { query: listStockTransfersQuerySchema },
  responses: {
    200: {
      description: "Transfers fetched.",
      content: json(successEnvelope("StockTransferListResponse", StockTransferListDataSchema, "Stock transfers fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: transferRead403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${API}/stock-transfers/{transferId}`,
  tags,
  summary: "Get a stock transfer",
  description: transferReadNote,
  security,
  request: { params: transferIdParam },
  responses: {
    200: {
      description: "Transfer fetched.",
      content: json(successEnvelope("GetStockTransferResponse", StockTransferDataSchema, "Stock transfer fetched successfully.")),
    },
    400: errorResponse("Malformed transferId.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: transferRead403,
    404: errorResponse("The transfer does not exist in your organization, or touches none of the stores where you hold `inventory:read` (both look the same, so ids cannot be probed). Code `TRANSFER_NOT_FOUND`.", "Stock transfer not found.", 404, "TRANSFER_NOT_FOUND"),
    500: server500,
  },
});

export { adjustmentExample, countExample, foundExample, transferExample };
