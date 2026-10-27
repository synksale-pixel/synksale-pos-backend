import { registry, z } from "../config/openapi.registry";
import {
  cancelPurchaseOrderSchema,
  closePurchaseOrderSchema,
  createPurchaseOrderSchema,
  deletePurchaseOrderQuerySchema,
  issuePurchaseOrderSchema,
  listPurchaseOrdersQuerySchema,
  updatePurchaseOrderSchema,
} from "../validators/purchaseOrder.validator";
import { idempotencyHeadersSchema } from "../validators/stock.validator";
import {
  NullDataSuccessSchema,
  PurchaseOrderDataSchema,
  PurchaseOrderListDataSchema,
  successEnvelope,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";
import { IDEMPOTENCY, idempotency409, QUANTITY_RULE, REPLAY_HEADERS } from "./stock.openapi";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Purchase Orders"];
// A PO belongs to one store, so everything but the cross-store list lives under the store path:
// scopeToStore then verifies the store before the store-level permission is checked.
const orgBase = `${API}/purchase-orders`;
const storeBase = `${API}/stores/{storeId}/purchase-orders`;
const poPath = `${storeBase}/{purchaseOrderId}`;

const PREVIEW =
  "**Contract preview (Phase 3b):** documented for frontend review; returns 404 until implemented.";

const storeIdParam = z.object({
  storeId: z.string().openapi({ description: "Store ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3400" }),
});

const poParams = storeIdParam.extend({
  purchaseOrderId: z.string().openapi({
    description: "Purchase order ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab3c00",
  }),
});

/** Two goods lines from a VAT-registered vendor, delivery expected next week. */
export const purchaseOrderExample = {
  vendorId: "665f1c2e8a4b3c0012ab3900",
  orderDate: "2026-10-27",
  expectedDate: "2026-11-03",
  vendorReference: "Q-2026-118",
  notes: "Deliver to the back entrance before 10am.",
  lines: [
    { variantId: "665f1c2e8a4b3c0012ab3801", quantity: 24, unitCost: "1.600", note: "Vendor code GR-250" },
    { variantId: "665f1c2e8a4b3c0012ab3802", quantity: 12.5, unitCost: "4.200" },
  ],
};

/** The least a PO needs: vendor and lines; unit costs come from the variants' cost prices. */
export const minimalPurchaseOrderExample = {
  vendorId: "665f1c2e8a4b3c0012ab3900",
  lines: [{ variantId: "665f1c2e8a4b3c0012ab3801", quantity: 24 }],
};

// ==========================================
// Shared descriptions
// ==========================================

const readNote =
  "Requires a **tenant** bearer token and **`purchase:read`** for this store: a store role at this store, or an organization-scoped role. Works for a deactivated store too.";

const listNote =
  "Requires a **tenant** bearer token and **`purchase:read`** held anywhere (org role or any store role). Store staff see only POs of stores where they hold `purchase:read`; an organization-scoped role sees every store's.";

const writeNote = (action: string) =>
  `Requires a **tenant** bearer token and **\`purchase:order\`** for this store (a store role at this store, or an organization-scoped role) to ${action}. Seeded on org_admin and store_manager.`;

const LIFECYCLE = [
  "**Lifecycle**",
  "- `draft`: being prepared. Editable; can be deleted.",
  "- `issued`: sent to the vendor. Editable until the first goods receipt; can be cancelled while nothing is received.",
  "- `partially_received` / `received`: set by goods receipts (Phase 3c), never by hand. Locked.",
  "- `cancelled`: stopped before anything arrived. `closed`: partly received and the rest will not come. Both are final.",
  "",
  "A PO never changes stock: goods receipts (Phase 3c) do. Use `editable` on the response to show or hide Edit.",
].join("\n");

const VERSION_RULE = [
  "**Concurrency:** send the `version` you loaded. If the PO changed since (another user, or another tab), the request is refused with 409 `PURCHASE_ORDER_VERSION_CONFLICT` and nothing is applied: reload the PO and redo the change. A successful change returns the PO with `version` + 1.",
  "- The version is checked **before** the status, so a stale screen always gets `PURCHASE_ORDER_VERSION_CONFLICT`, never a decision based on old data.",
  "- A retried request that already succeeded (e.g. a second click on Issue) therefore gets the version conflict too: on any 409, reload the PO and show its current state rather than an error.",
].join("\n");

const LINE_RULES = [
  "**Lines**",
  "- 1 to 200 lines, each variant at most once. Goods only: a service product is refused (`VARIANT_NOT_PURCHASABLE`). Inactive products and variants are allowed, and so are goods that do not track inventory.",
  `- ${QUANTITY_RULE}`,
  "- `unitCost` is VAT-exclusive, at the currency's decimals. It defaults to the variant's cost price; with no cost price it must be sent (`UNIT_COST_REQUIRED`). No discounts in v1: agree the net cost with the vendor.",
  "- **Estimated VAT** per line: when the vendor is `vat_registered` and the product is `standard`, subtotal × the product's tax rate (or the organization's default rate); otherwise 0 (including `overseas` vendors: reverse charge). It is worked out again each time the lines or the vendor are saved, **and once more at issue** together with the vendor copy, so an issued PO's VAT always matches the vendor details it shows. Edits after issue use the copied VAT treatment, not the vendor's current one. The final VAT comes from the vendor's bill (Phase 3d).",
  "- Amounts round per line (subtotal, then VAT) to the currency's decimals; the PO totals are the sums of the lines.",
].join("\n");

const LINE_CODES = [
  "- Line problems are collected in one response: `errors` has one item per bad line (`errors[].field` is `lines[i].variantId` or `lines[i].unitCost`) and the top-level `code` is the first item's.",
  "- `VARIANT_NOT_FOUND`: the variant does not exist in your organization or is deleted.",
  "- `VARIANT_NOT_PURCHASABLE`: the variant's product is a service.",
  "- `UNIT_COST_REQUIRED`: no `unitCost` was sent and the variant has no cost price.",
  "- `TOO_MANY_DECIMALS` / `INVALID_AMOUNT` / `AMOUNT_OUT_OF_RANGE`: a `unitCost` does not fit the organization's currency.",
  `- \`VALIDATION_FAILED\`: a schema rule (see \`errors\`), or a fractional quantity for a whole-number unit.`,
];

const VENDOR_CODES = [
  "- `VENDOR_NOT_FOUND`: `vendorId` does not exist in your organization or is deleted (`errors[0].field` is `vendorId`).",
  "- `VENDOR_INACTIVE`: the vendor is deactivated (`errors[0].field` is `vendorId`). An issued PO for a vendor deactivated later can still be edited, received, cancelled and closed.",
];

const list403 = errorResponse(
  "No role (organization or store) grants `purchase:read`.",
  "Access Denied: You do not possess the required permission (purchase:read) to execute this action.",
  403
);

const store403 = (permission: string, inactive: string) =>
  errorResponse(
    `The caller has no access to this store, or has access but no role grants \`${permission}\` for it${inactive}.`,
    `Access Denied: You do not possess the required permission (${permission}) to execute this action.`,
    403
  );

const read403 = store403("purchase:read", "");
const write403 = store403("purchase:order", ", or the store is deactivated");
// Cancel and close settle open POs, so they still work for a deactivated store.
const settle403 = store403("purchase:order", "");

const STORE_404_LINE = "- The store does not exist in your organization (or is deleted): message `Store not found.`, no `code`.";

const notFound404 = errorResponse(
  [
    `${PREVIEW}`,
    "",
    "Not found:",
    STORE_404_LINE,
    "- `PURCHASE_ORDER_NOT_FOUND`: no PO with this id in this store (another store's or organization's PO, or a deleted draft, look the same).",
  ].join("\n"),
  "Purchase order not found.",
  404,
  "PURCHASE_ORDER_NOT_FOUND"
);

const store404 = errorResponse(`${PREVIEW}\n\n${STORE_404_LINE}`, "Store not found.", 404);

const LIST_RULES = [
  "Paginated, newest PO number first. For “awaiting goods” send `status=issued,partially_received`.",
  "Query parsing is lenient and never returns 400: an unrecognised status or an invalid `page`/`limit`/`from`/`to` is ignored (defaults: page 1, limit 20); `limit` is capped at 100. A malformed `storeId` or `vendorId` filter matches nothing.",
  "`from` / `to` compare against `orderDate`, a plain calendar date.",
].join("\n");

const STATUS_CONFLICT_LINE =
  "- `PURCHASE_ORDER_STATUS_CONFLICT`: the PO's status does not allow this action. `errors[0].meta` has `{ status, allowed }` (the statuses that would).";

const conflict409 = (extra: string[]) =>
  errorResponse(
    [
      "Conflict. Codes:",
      "- `PURCHASE_ORDER_VERSION_CONFLICT`: the PO changed since it was loaded; `errors[0].meta.currentVersion` is its version now. Reload and retry.",
      ...extra,
    ].join("\n"),
    "This purchase order was changed by someone else. Reload it and try again.",
    409,
    "PURCHASE_ORDER_VERSION_CONFLICT",
    [{ field: "version", code: "PURCHASE_ORDER_VERSION_CONFLICT", meta: { currentVersion: 4 } }]
  );

const malformedId400 = errorResponse(
  "Malformed purchaseOrderId.",
  "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'",
  400
);

const PO_RESPONSE = (name: string, message: string, status = 200) =>
  json(successEnvelope(name, PurchaseOrderDataSchema, message, status));

// ==========================================
// List and read
// ==========================================

registry.registerPath({
  method: "get",
  path: orgBase,
  tags,
  summary: "List purchase orders across stores",
  description: [
    PREVIEW,
    "",
    listNote,
    "",
    LIST_RULES,
  ].join("\n"),
  security,
  request: { query: listPurchaseOrdersQuerySchema },
  responses: {
    200: {
      description: "Purchase orders fetched. Each item is a summary (no lines; `lineCount` instead).",
      content: json(successEnvelope("PurchaseOrderListResponse", PurchaseOrderListDataSchema, "Purchase orders fetched successfully.")),
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
  summary: "List a store's purchase orders",
  description: [
    PREVIEW,
    "",
    readNote,
    "",
    "The same list for this store only (a `storeId` query filter is ignored here).",
    "",
    LIST_RULES,
  ].join("\n"),
  security,
  request: { params: storeIdParam, query: listPurchaseOrdersQuerySchema.omit({ storeId: true }) },
  responses: {
    200: {
      description: "Purchase orders fetched.",
      content: json(successEnvelope("StorePurchaseOrderListResponse", PurchaseOrderListDataSchema, "Purchase orders fetched successfully.")),
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
  path: poPath,
  tags,
  summary: "Get a purchase order",
  description: [PREVIEW, "", readNote, "", LIFECYCLE].join("\n"),
  security,
  request: { params: poParams },
  responses: {
    200: { description: "Purchase order fetched.", content: PO_RESPONSE("GetPurchaseOrderResponse", "Purchase order fetched successfully.") },
    400: malformedId400,
    401: TENANT_AUTH_401,
    403: read403,
    404: notFound404,
    500: server500,
  },
});

// ==========================================
// Create, edit, delete
// ==========================================

registry.registerPath({
  method: "post",
  path: storeBase,
  tags,
  summary: "Create a purchase order (draft)",
  description: [
    PREVIEW,
    "",
    writeNote("create a PO for it"),
    "",
    "Creates a **draft** for this store and gives it its number (PO-00001, PO-00002…, per organization). Issue it when it is ready to send.",
    "- The store comes from the URL, must be active, and never changes. One store per PO.",
    "- `vendorId`: an active vendor.",
    "- `orderDate` defaults to today in **the store's timezone**; `expectedDate` is optional and cannot be before it.",
    "- Amounts are in the organization's currency (no foreign-currency POs in v1).",
    "",
    LINE_RULES,
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
          schema: createPurchaseOrderSchema,
          examples: {
            full: { summary: "Two lines with agreed costs and a delivery date", value: purchaseOrderExample },
            minimal: { summary: "Costs from the variants' cost prices, dated today", value: minimalPurchaseOrderExample },
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: "Draft created.",
      headers: REPLAY_HEADERS,
      content: PO_RESPONSE("CreatePurchaseOrderResponse", "Purchase order created successfully.", 201),
    },
    400: errorResponse(
      [
        "Bad request. Codes:",
        "- `VALIDATION_FAILED` also covers a missing or malformed `Idempotency-Key` header and an `expectedDate` before `orderDate`.",
        ...VENDOR_CODES,
        ...LINE_CODES,
        "- A malformed `storeId` in the path also returns 400 (no `code`).",
      ].join("\n"),
      "Request Validation Failed: lines: Variant '665f1c2e8a4b3c0012ab3801' is listed more than once.",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: write403,
    404: store404,
    409: idempotency409([], {
      message: "This Idempotency-Key was already used for a different request.",
      code: "IDEMPOTENCY_KEY_REUSED",
    }),
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: poPath,
  tags,
  summary: "Edit a purchase order",
  description: [
    PREVIEW,
    "",
    writeNote("edit it"),
    "",
    "Allowed while `editable` is true: a **draft**, or an **issued** PO with nothing received yet. Send only the fields to change (plus `version`); null clears `expectedDate`, `vendorReference` or `notes`.",
    "- `lines`, when sent, replaces every line. **Resend `unitCost` on every line** (the response always carries it): a line without one picks up the variant's current cost price, which would overwrite a price agreed with the vendor.",
    "- `vendorId` can change on a draft only (an issued PO was sent to that vendor: cancel it and create a new one).",
    "- Editing an issued PO keeps it issued; tell the vendor about the change.",
    "",
    VERSION_RULE,
    "",
    LINE_RULES,
  ].join("\n"),
  security,
  request: {
    params: poParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updatePurchaseOrderSchema,
          examples: {
            price: {
              summary: "Vendor changed a price after issue",
              value: {
                version: 3,
                lines: [
                  { variantId: "665f1c2e8a4b3c0012ab3801", quantity: 24, unitCost: "1.650" },
                  { variantId: "665f1c2e8a4b3c0012ab3802", quantity: 12.5, unitCost: "4.200" },
                ],
              },
            },
            date: { summary: "Delivery moved", value: { version: 3, expectedDate: "2026-11-05" } },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "Purchase order updated.", content: PO_RESPONSE("UpdatePurchaseOrderResponse", "Purchase order updated successfully.") },
    400: errorResponse(
      [
        "Bad request. Codes:",
        "- `VALIDATION_FAILED`: a schema rule, a missing `version`, nothing to change, `expectedDate` before `orderDate` (stored values count), or `vendorId` sent for an issued PO.",
        "- `VENDOR_NOT_FOUND` / `VENDOR_INACTIVE`: checked only when `vendorId` is sent (`errors[0].field` is `vendorId`). The stored vendor being deactivated later never blocks an edit.",
        ...LINE_CODES,
        "- A malformed `purchaseOrderId` in the path also returns 400 (no `code`).",
      ].join("\n"),
      "Request Validation Failed: version: version is required.",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    409: conflict409([`${STATUS_CONFLICT_LINE} Here: the PO is no longer editable (goods received, cancelled or closed).`]),
    500: server500,
  },
});

registry.registerPath({
  method: "delete",
  path: poPath,
  tags,
  summary: "Delete a draft purchase order",
  description: [
    PREVIEW,
    "",
    writeNote("delete it"),
    "",
    "Drafts only. Its number is not reused, so numbering has a gap. An issued PO cannot be deleted: cancel it instead.",
    "",
    "**Concurrency:** send the draft's `version` as the `version` query parameter (409 `PURCHASE_ORDER_VERSION_CONFLICT` if it changed).",
  ].join("\n"),
  security,
  request: { params: poParams, query: deletePurchaseOrderQuerySchema },
  responses: {
    200: { description: "Draft deleted.", content: json(NullDataSuccessSchema("DeletePurchaseOrderResponse", "Purchase order deleted successfully.")) },
    400: errorResponse("Missing or invalid `version` query parameter (`VALIDATION_FAILED`), or a malformed `purchaseOrderId`.", "Request Validation Failed: version: version is required.", 400, "VALIDATION_FAILED"),
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    409: conflict409([`${STATUS_CONFLICT_LINE} Here: the PO is not a draft.`]),
    500: server500,
  },
});

// ==========================================
// Status changes
// ==========================================

registry.registerPath({
  method: "post",
  path: `${poPath}/issue`,
  tags,
  summary: "Issue a purchase order",
  description: [
    PREVIEW,
    "",
    writeNote("issue it"),
    "",
    "Moves a **draft** to **issued**: the PO is final enough to send to the vendor, and goods can be received against it (Phase 3c).",
    "- The vendor must still be active (`VENDOR_INACTIVE`, 400) and the store active (403).",
    "- From now on the PO shows a copy of the vendor's name, legal name, TRN and VAT treatment as they are at this moment, and the estimated VAT is worked out again against that copy (so it can differ from the draft's if the vendor changed meanwhile).",
    "- Issuing does not change the PO number or the order date.",
    "",
    VERSION_RULE,
  ].join("\n"),
  security,
  request: { params: poParams, body: { required: true, content: { "application/json": { schema: issuePurchaseOrderSchema } } } },
  responses: {
    200: { description: "Purchase order issued.", content: PO_RESPONSE("IssuePurchaseOrderResponse", "Purchase order issued successfully.") },
    400: errorResponse(
      ["Bad request. Codes:", "- `VALIDATION_FAILED`: missing or invalid `version`.", "- `VENDOR_INACTIVE`: the vendor was deactivated after the draft was made; choose another vendor or reactivate it."].join("\n"),
      "This vendor is deactivated.",
      400,
      "VENDOR_INACTIVE",
      [{ field: "vendorId", code: "VENDOR_INACTIVE" }]
    ),
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    409: conflict409([`${STATUS_CONFLICT_LINE} Here: the PO is not a draft.`]),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${poPath}/cancel`,
  tags,
  summary: "Cancel a purchase order",
  description: [
    PREVIEW,
    "",
    writeNote("cancel it"),
    "",
    "For an **issued** PO with **nothing received**: it becomes **cancelled** (final). A draft is deleted instead; a PO with goods received is closed instead. An optional `reason` is kept on the PO. Works for a deactivated store's POs too.",
    "",
    VERSION_RULE,
  ].join("\n"),
  security,
  request: {
    params: poParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: cancelPurchaseOrderSchema,
          example: { version: 3, reason: "Vendor cannot supply before the promotion ends." },
        },
      },
    },
  },
  responses: {
    200: { description: "Purchase order cancelled.", content: PO_RESPONSE("CancelPurchaseOrderResponse", "Purchase order cancelled successfully.") },
    400: errorResponse("Missing or invalid `version`, or `reason` over 500 characters (`VALIDATION_FAILED`).", "Request Validation Failed: version: version is required.", 400, "VALIDATION_FAILED"),
    401: TENANT_AUTH_401,
    403: settle403,
    404: notFound404,
    409: conflict409([`${STATUS_CONFLICT_LINE} Here: the PO is not issued, or goods have been received (close it instead).`]),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${poPath}/close`,
  tags,
  summary: "Close a partly received purchase order",
  description: [
    PREVIEW,
    "",
    writeNote("close it"),
    "",
    "For a **partially_received** PO whose remaining goods will not come: it becomes **closed** (final) and stops counting as awaiting goods. Lines keep what was received. Only reachable once goods receipts ship (Phase 3c). An optional `reason` is kept on the PO. Works for a deactivated store's POs too.",
    "",
    VERSION_RULE,
  ].join("\n"),
  security,
  request: {
    params: poParams,
    body: {
      required: true,
      content: { "application/json": { schema: closePurchaseOrderSchema, example: { version: 6, reason: "Vendor out of stock on the rest." } } },
    },
  },
  responses: {
    200: { description: "Purchase order closed.", content: PO_RESPONSE("ClosePurchaseOrderResponse", "Purchase order closed successfully.") },
    400: errorResponse("Missing or invalid `version`, or `reason` over 500 characters (`VALIDATION_FAILED`).", "Request Validation Failed: version: version is required.", 400, "VALIDATION_FAILED"),
    401: TENANT_AUTH_401,
    403: settle403,
    404: notFound404,
    409: conflict409([`${STATUS_CONFLICT_LINE} Here: the PO is not partially_received (an issued PO with nothing received is cancelled instead).`]),
    500: server500,
  },
});
