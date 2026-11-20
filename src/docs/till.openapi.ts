/**
 * Purpose: Swagger for Phase 4a-2 till catalog reads (contract preview: documented for frontend
 * sign-off; the routes answer 404 until the implementation ships).
 */
import { registry, z } from "../config/openapi.registry";
import { tillItemsQuerySchema, tillLookupQuerySchema } from "../validators/till.validator";
import { successEnvelope, TillItemListDataSchema, TillLookupDataSchema } from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401, validation400 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Till"];
const base = `${API}/stores/{storeId}/till`;

const PREVIEW =
  "**Contract preview (Phase 4a-2):** documented for frontend sign-off; the route answers 404 until the implementation ships.";

const storeIdParam = z.object({
  storeId: z.string().openapi({ description: "Store ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3400" }),
});

const NOTE = [
  "Requires a **tenant** bearer token, access to the store and **`sale:create`** there (cashiers, store managers, org admins). The store must be active.",
  "",
  "Returns **only sellable items**: active variants of active products. Each `TillItem` carries what the till needs to ring it up (selling price, `pricesIncludeTax`, tax rate, stock at this store) and never a cost, so it is safe for cashiers. The selling price is the organization's (no per-store prices, decision 8).",
].join("\n");

const store403 = errorResponse(
  "No access to this store, no `sale:create` there, or the store is deactivated.",
  "Access Denied: You do not possess the required permission (sale:create) to execute this action.",
  403
);
const store404 = errorResponse("The store does not exist in your organization (or is deleted). No `code`.", "Store not found.", 404);

registry.registerPath({
  method: "get",
  path: `${base}/lookup`,
  tags,
  summary: "Scan: find the item for a barcode or SKU",
  description: [
    PREVIEW,
    "",
    NOTE,
    "",
    "Exact match on a UPC/EAN/ISBN (hyphens ignored) or a SKU (case-insensitive), the same matching as `GET /products/lookup`. Barcodes and SKUs are unique in the organization, so a code finds at most one variant.",
    "",
    "- No variant has the code: `404 PRODUCT_NOT_FOUND`.",
    "- The variant or its product is deactivated: `409 PRODUCT_INACTIVE`, so the till can say \"this item is not for sale\" instead of \"unknown barcode\".",
  ].join("\n"),
  security,
  request: { params: storeIdParam, query: tillLookupQuerySchema },
  responses: {
    200: {
      description: "The item and which code matched.",
      content: json(successEnvelope("TillLookupResponse", TillLookupDataSchema, "Item found.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: store403,
    404: errorResponse(
      "No item has this code (`PRODUCT_NOT_FOUND`), or the store does not exist (`Store not found.`, no code).",
      "No product matches '6291041500213'.",
      404,
      "PRODUCT_NOT_FOUND"
    ),
    409: errorResponse(
      "The code belongs to a deactivated variant or product. Code `PRODUCT_INACTIVE`.",
      "'Crew-neck T-shirt - M / Red' is deactivated and cannot be sold.",
      409,
      "PRODUCT_INACTIVE"
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/items`,
  tags,
  summary: "Browse and search sellable items",
  description: [
    PREVIEW,
    "",
    NOTE,
    "",
    "One row per variant (a T-shirt in 6 sizes is 6 rows), sorted by name, paginated (default 50). For the item grid, category tabs and the search box. For a scanner, use `/till/lookup`.",
  ].join("\n"),
  security,
  request: { params: storeIdParam, query: tillItemsQuerySchema },
  responses: {
    200: {
      description: "A page of sellable items.",
      content: json(successEnvelope("TillItemListResponse", TillItemListDataSchema, "Items fetched successfully.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: store403,
    404: store404,
    500: server500,
  },
});
