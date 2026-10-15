import { registry, z } from "../config/openapi.registry";
import {
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  updateVariantSchema,
  listProductsQuerySchema,
  lookupProductQuerySchema,
} from "../validators/product.validator";
import {
  NullDataSuccessSchema,
  ProductDataSchema,
  ProductListDataSchema,
  ProductLookupDataSchema,
  successEnvelope,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Products"];
const base = `${API}/products`;

const productIdParam = z.object({
  productId: z.string().openapi({ description: "Product ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3800" }),
});
const variantParams = productIdParam.extend({
  variantId: z.string().openapi({ description: "Variant ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3801" }),
});

const CONTRACT = [
  "**Rules**",
  "- Every product has at least one variant. Stock, purchase and sale lines always reference a `variantId`. A `single` item has one hidden default variant (`isDefault: true`); send its SKU, barcodes, prices and reorder point at the top level exactly as the form groups them. A `variant` item sends `attributes` + `variants` instead.",
  "- Money is a **decimal string** (`\"4.500\"`), never a number, with no more decimals than the organization's currency (`GET /organization` → `currency.decimals`; BHD 3). Responses use the same format.",
  "- `sales.sellingPrice` / variant `sellingPrice` are **VAT-inclusive** when the organization's `settings.sales.pricesIncludeTax` is true (default). Cost prices are always VAT-exclusive.",
  "- `taxPreference` is `standard` (uses `taxRateId`, or the organization's default rate when omitted), `zero_rated`, `exempt` or `out_of_scope` (no tax rate).",
  "- `type` (goods/service) and `itemType` (single/variant) cannot change after creation. Services are single, have no brand/manufacturer and never track inventory.",
  "- SKU is optional and unique per organization (case-insensitive). UPC/EAN/ISBN are unique per organization and scannable; MPN is reference only.",
  "- Quantities (`reorderPoint`) are whole numbers unless the unit is kg, g, L, mL, m or cm (up to 3 decimals).",
  "- **Not accepted yet:** `openingStock` / `openingStockValue` (arrive with stock tracking), `valuationMethod` (always weighted average), image uploads (`imageUrl` is a link). `price` and `stock` are computed by the server, not sent.",
].join("\n");

const readNote = `Requires a **tenant** bearer token and **\`product:read\`** held anywhere (org role or any store role), so cashiers can search and scan. The catalog is organization-wide.`;
const writeNote = (permission: string) =>
  `Requires a **tenant** bearer token, an **organization-scoped role** and **\`${permission}\`**.`;

const read403 = errorResponse(
  "No role (organization or store) grants `product:read`.",
  "Access Denied: You do not possess the required permission (product:read) to execute this action.",
  403
);

const productNotFound = errorResponse(
  "Product does not exist in your organization (other organizations' and deleted products look the same). Code `PRODUCT_NOT_FOUND`.",
  "Product not found.",
  404,
  "PRODUCT_NOT_FOUND"
);
const variantNotFound = errorResponse(
  "Product or variant not found in your organization. Code `PRODUCT_NOT_FOUND` or `VARIANT_NOT_FOUND`.",
  "Variant not found.",
  404,
  "VARIANT_NOT_FOUND"
);
const write403 = errorResponse(
  "Not an organization-scoped role, or missing the product permission.",
  "Access Denied: This action requires an organization-level role.",
  403
);
const MONEY_CODES =
  "- `TOO_MANY_DECIMALS` / `INVALID_AMOUNT` / `AMOUNT_OUT_OF_RANGE`: a price has more decimals than the organization's currency allows (`errors[0].meta.decimals`), is not a decimal number, or is too large. `errors[].field` names the price (e.g. `sales.sellingPrice`, `variants[1].costPrice`, `sellingPrice`).";
const REFERENCE_CODES = [
  "- `CATEGORY_NOT_FOUND`: `categoryId` does not exist in your organization (here it is a 400, not a 404; `errors[0].field` is `categoryId`).",
  "- `TAX_RATE_NOT_FOUND` / `TAX_RATE_INACTIVE`: `taxRateId` does not exist, or the rate is deactivated (`errors[0].field` is `taxRateId`).",
  "- `TAX_RATE_REQUIRED`: a `standard` product with no `taxRateId`, and the organization has no active default rate.",
];
const BODY_CODES =
  '- `VALIDATION_FAILED`: a schema or cross-field rule (see the Rules in the create description). For schema errors `errors` lists each issue with its `path`. The service raises the same code for rules that depend on stored state, as `errors[0]` = `{ field, code: "VALIDATION_FAILED", message }`.';

const malformedId400 = errorResponse(
  "Malformed `productId` / `variantId` in the path.",
  "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'",
  400
);

const createProduct400 = errorResponse(
  ["Bad request. Codes:", BODY_CODES, MONEY_CODES, ...REFERENCE_CODES].join("\n"),
  "Request Validation Failed: sales.sellingPrice: Selling price is required for a single item.",
  400,
  "VALIDATION_FAILED"
);

const updateProduct400 = errorResponse(
  [
    "Bad request. Codes:",
    BODY_CODES +
      " Service-only rules on PATCH: `attributes` sent for a single item; `brand`, `manufacturer`, `inventory.trackInventory: true` or `inventory.reorderPoint` sent for a service; a `taxRateId` sent while the resulting tax preference is not `standard` (this includes a stored non-standard preference when `taxPreference` is omitted); a `unit` change to a whole-number unit while a variant has a fractional reorder point; a fractional `inventory.reorderPoint` for a whole-number unit.",
    MONEY_CODES,
    ...REFERENCE_CODES,
    "- `PRODUCT_IS_VARIANT_ITEM`: a variant item was sent `sku`, `barcodes`, `sales.sellingPrice`, `purchase.costPrice` or `inventory.reorderPoint`; use the variant endpoints.",
    "- A malformed `productId` in the path also returns 400 (no `code`).",
  ].join("\n"),
  "This is a variant item: set SKU, barcodes, prices and reorder point on each variant instead.",
  400,
  "PRODUCT_IS_VARIANT_ITEM"
);

const addVariant400 = errorResponse(
  [
    "Bad request. Codes:",
    BODY_CODES +
      " Service rules: `attributeValues` that do not give exactly one value per attribute or use an unknown option (`errors[0].field` is `attributeValues` or `attributeValues.<Attribute>`); a fractional `reorderPoint` for a whole-number unit.",
    MONEY_CODES,
    "- `PRODUCT_NOT_VARIANT_ITEM`: the product is a single item (its one hidden default variant is edited with PATCH /products/{productId}).",
    "- A malformed `productId` in the path also returns 400 (no `code`).",
  ].join("\n"),
  "This product is a single item and has no separately managed variants.",
  400,
  "PRODUCT_NOT_VARIANT_ITEM"
);

const updateVariant400 = errorResponse(
  [
    "Bad request. Codes:",
    BODY_CODES +
      " Service rules: a `reorderPoint` for a service product; a fractional `reorderPoint` for a whole-number unit (`errors[0].field` is `reorderPoint`).",
    MONEY_CODES,
    "- A malformed `productId` / `variantId` in the path also returns 400 (no `code`).",
    "This endpoint never returns `PRODUCT_NOT_VARIANT_ITEM`: it also works on the default variant of a single item.",
  ].join("\n"),
  "Request Validation Failed: reorderPoint: Unit 'pcs' only allows whole quantities.",
  400,
  "VALIDATION_FAILED",
  [{ field: "reorderPoint", code: "VALIDATION_FAILED", message: "Unit 'pcs' only allows whole quantities." }]
);

const variantItemOnly400 = errorResponse(
  "Malformed id in the path (no `code`), or the product is a single item (code `PRODUCT_NOT_VARIANT_ITEM`; checked before the variant is looked up).",
  "This product is a single item and has no separately managed variants.",
  400,
  "PRODUCT_NOT_VARIANT_ITEM"
);

const UNIQUENESS_LINE =
  "- `SKU_TAKEN` / `BARCODE_TAKEN`: the SKU or a scannable barcode (UPC/EAN/ISBN) is used by another variant in your organization. `errors[].field` is `sku` or `barcodes.upc|ean|isbn`; one item per conflict: `{ field, code, meta: { value, productId, productName } }`. The top-level `code` is the first item's. MPN is never checked.";

const update409 = errorResponse(
  [
    "Conflict. Codes:",
    UNIQUENESS_LINE,
    '- `ATTRIBUTE_OPTION_IN_USE`: `attributes` removes or renames an option that a variant uses (one `errors` item per option: `{ field: "attributes", code, message, meta: { attribute, option } }`).',
    "- `ATTRIBUTES_LOCKED`: `attributes` adds or removes a whole attribute (`errors[0].field` is `attributes`).",
  ].join("\n"),
  "Option 'M' of Size is used by a variant and cannot be removed.",
  409,
  "ATTRIBUTE_OPTION_IN_USE",
  [
    {
      field: "attributes",
      code: "ATTRIBUTE_OPTION_IN_USE",
      message: "Option 'M' of Size is used by a variant and cannot be removed.",
      meta: { attribute: "Size", option: "M" },
    },
  ]
);
const addVariant409 = errorResponse(
  [
    "Conflict. Codes:",
    "- `VARIANT_COMBINATION_TAKEN`: a variant with these `attributeValues` already exists (`errors[0].field` is `attributeValues`). Deleted variants do not count.",
    UNIQUENESS_LINE,
  ].join("\n"),
  "A variant with Size: M, Colour: Red already exists.",
  409,
  "VARIANT_COMBINATION_TAKEN",
  [{ field: "attributeValues", code: "VARIANT_COMBINATION_TAKEN" }]
);
const createUniqueness409 = errorResponse(
  [
    "A SKU or scannable barcode is already used by another variant in your organization. Code `SKU_TAKEN` or `BARCODE_TAKEN` (the first conflict's).",
    "`errors` has one item per conflict: `{ field, code, meta: { value, productId, productName } }`. `field` is the request path: `sku`, `barcodes.ean` (single items) or `variants[0].sku`, `variants[1].barcodes.isbn` (variant items). Duplicates inside the same request are caught earlier as `VALIDATION_FAILED` (400).",
  ].join("\n"),
  "SKU 'TSHIRT-RED-M' is already used by 'Crew-neck T-shirt'.",
  409,
  "SKU_TAKEN",
  [
    { field: "variants[0].sku", code: "SKU_TAKEN", meta: { value: "TSHIRT-RED-M", productId: "665f1c2e8a4b3c0012ab3800", productName: "Crew-neck T-shirt" } },
    { field: "variants[1].barcodes.isbn", code: "BARCODE_TAKEN", meta: { value: "9780306406157", productId: "665f1c2e8a4b3c0012ab3810", productName: "Cotton Handbook" } },
  ]
);
const updateVariant409 = errorResponse(
  [
    "A SKU or scannable barcode is already used by another variant in your organization. Code `SKU_TAKEN` or `BARCODE_TAKEN` (the first conflict's).",
    "`errors[].field` is `sku` or `barcodes.upc|ean|isbn`; `meta` = `{ value, productId, productName }`.",
  ].join("\n"),
  "SKU 'TSHIRT-RED-L' is already used by 'Crew-neck T-shirt'.",
  409,
  "SKU_TAKEN",
  [{ field: "sku", code: "SKU_TAKEN", meta: { value: "TSHIRT-RED-L", productId: "665f1c2e8a4b3c0012ab3800", productName: "Crew-neck T-shirt" } }]
);

export const singleExample = {
  name: "Arabic Coffee 250g",
  type: "goods",
  itemType: "single",
  categoryId: "665f1c2e8a4b3c0012ab3700",
  unit: "pcs",
  sku: "COF-AR-250",
  barcodes: { ean: "6291041500213" },
  brand: "Al Noor",
  taxPreference: "standard",
  taxRateId: "665f1c2e8a4b3c0012ab3600",
  imageUrl: "https://cdn.example.com/coffee.jpg",
  weight: { value: 0.25, unit: "kg" },
  sales: { sellingPrice: "2.750", description: "Cardamom blend." },
  purchase: { costPrice: "1.600", preferredVendorName: "Gulf Roasters W.L.L." },
  inventory: { trackInventory: true, reorderPoint: 12, returnable: false },
};

export const variantExample = {
  name: "Crew-neck T-shirt",
  type: "goods",
  itemType: "variant",
  categoryId: "665f1c2e8a4b3c0012ab3701",
  unit: "pcs",
  taxPreference: "standard",
  attributes: [
    { name: "Size", options: ["S", "M", "L"] },
    { name: "Colour", options: ["Red", "Blue"] },
  ],
  variants: [
    { attributeValues: { Size: "M", Colour: "Red" }, sku: "TSHIRT-RED-M", sellingPrice: "4.500", costPrice: "2.000" },
    { attributeValues: { Size: "L", Colour: "Red" }, sku: "TSHIRT-RED-L", sellingPrice: "5.000", costPrice: "2.200", barcodes: { ean: "6291041500220" } },
  ],
  inventory: { trackInventory: true, returnable: true },
};

export const serviceExample = {
  name: "Gift wrapping",
  type: "service",
  unit: "pcs",
  taxPreference: "standard",
  sales: { sellingPrice: "0.500" },
};

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List / search products",
  description: [
    readNote,
    "",
    "Paginated product summaries (active and inactive, no variants; fetch a product for those). Newest first, or alphabetical by name when `search` is given.",
    "- `search`: case-insensitive **prefix** match on the product name, any variant's SKU, or any variant's UPC / EAN / ISBN (not MPN), suitable for typeahead. Hyphens are not stripped: search an ISBN without hyphens (the lookup endpoint accepts either form).",
    "- `categoryId`: a category id, or `none` for uncategorised products. Matches products in that category **and its subcategories**; add `includeSubcategories=false` for direct members only. A malformed or unknown id returns an empty list, not an error.",
    "- Each product's `category` carries `path` (e.g. `Apparel › T-shirts`), since category names may repeat under different parents.",
    "- Query parsing is lenient and never returns 400: an unrecognised `type`, an `isActive` other than `true`/`false`, or an invalid `page`/`limit` is ignored (defaults: page 1, limit 20); `limit` is capped at 100.",
  ].join("\n"),
  security,
  request: { query: listProductsQuerySchema },
  responses: {
    200: {
      description: "Products fetched.",
      content: json(successEnvelope("ProductListResponse", ProductListDataSchema, "Products fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: read403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/lookup`,
  tags,
  summary: "Look up a product by barcode or SKU",
  description: `${readNote}\n\nFor scan-to-cart: exact match on a variant's UPC, EAN, ISBN or SKU (SKU case-insensitive). A barcode match wins over a SKU that has the same characters. An ISBN may be typed with or without hyphens. Returns the full product plus the matched \`variantId\` and what matched (\`matchedOn\`: sku, upc, ean or isbn; when the same digits are stored under several barcode types, the first of upc, ean, isbn). Inactive products and variants are still returned (check \`isActive\` on the product and on the variant) so the POS can explain why it cannot sell them. Deleted ones are not found.`,
  security,
  request: { query: lookupProductQuerySchema },
  responses: {
    200: {
      description: "Match found.",
      content: json(successEnvelope("ProductLookupResponse", ProductLookupDataSchema, "Product found.")),
    },
    400: errorResponse("`code` missing or empty.", "Request Validation Failed: code: Required", 400, "VALIDATION_FAILED"),
    401: TENANT_AUTH_401,
    403: read403,
    404: errorResponse("Nothing in your catalog has this barcode or SKU. Code `PRODUCT_NOT_FOUND`.", "No product matches '6291041500213'.", 404, "PRODUCT_NOT_FOUND"),
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/{productId}`,
  tags,
  summary: "Get a product",
  description: `${readNote}\n\nThe full product with all variants (active and inactive).`,
  security,
  request: { params: productIdParam },
  responses: {
    200: {
      description: "Product fetched.",
      content: json(successEnvelope("GetProductResponse", ProductDataSchema, "Product fetched successfully.")),
    },
    400: errorResponse("Malformed productId.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: read403,
    404: productNotFound,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: base,
  tags,
  summary: "Create a product",
  description: `${writeNote("product:create")}\n\n${CONTRACT}`,
  security,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createProductSchema,
          examples: {
            single: { summary: "Single item", value: singleExample },
            variant: { summary: "Variant item (Size × Colour)", value: variantExample },
            service: { summary: "Service", value: serviceExample },
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: "Product created with its variants.",
      content: json(successEnvelope("CreateProductResponse", ProductDataSchema, "Product created successfully.", 201)),
    },
    400: createProduct400,
    401: TENANT_AUTH_401,
    403: write403,
    409: createUniqueness409,
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{productId}`,
  tags,
  summary: "Update a product",
  description: [
    writeNote("product:update"),
    "",
    "Send any product field; `null` clears an optional one. `type` and `itemType` cannot change.",
    "- **Single items** may also send `sku`, `barcodes`, `sales.sellingPrice`, `purchase.costPrice`, `inventory.reorderPoint` (applied to the default variant). Variant items get `PRODUCT_IS_VARIANT_ITEM` (400) for these - use the variant endpoints.",
    "- **Variant items** may send the full `attributes` list to add options. Removing an option a variant uses (`ATTRIBUTE_OPTION_IN_USE`) or adding/removing a whole attribute (`ATTRIBUTES_LOCKED`) is refused (409). Attribute names keep their stored spelling and order (a differently-cased name in the request is matched, not renamed); options are replaced by the list sent. Sending `attributes` for a single item is a 400 `VALIDATION_FAILED`.",
    "- **Services** cannot be given a `brand`, `manufacturer`, `inventory.trackInventory: true` or an `inventory.reorderPoint` (400 `VALIDATION_FAILED`).",
    "- Changing `taxPreference` away from `standard` clears `taxRateId`; sending a `taxRateId` together with a non-standard preference is refused (400 `VALIDATION_FAILED`), also when `taxPreference` is omitted and the stored one is non-standard. Switching to `standard`, or sending `taxRateId: null` on a standard product, falls back to the organization's default rate (`TAX_RATE_REQUIRED` if there is none).",
    "- Changing `unit` to a whole-number unit (e.g. kg → pcs) is refused while any variant has a fractional `reorderPoint`.",
    "- An update made only of empty groups (e.g. `{ \"sales\": {} }`) is refused: send at least one actual value.",
    "- A change to a single item's selling or cost price is recorded in the audit log (`product.price_changed`, with the before/after prices).",
    "- The response is the whole product with all variants.",
  ].join("\n"),
  security,
  request: { params: productIdParam, body: { required: true, content: json(updateProductSchema) } },
  responses: {
    200: {
      description: "Product updated.",
      content: json(successEnvelope("UpdateProductResponse", ProductDataSchema, "Product updated successfully.")),
    },
    400: updateProduct400,
    401: TENANT_AUTH_401,
    403: write403,
    404: productNotFound,
    409: update409,
    500: server500,
  },
});

for (const [action, isActive] of [
  ["deactivate", false],
  ["activate", true],
] as const) {
  registry.registerPath({
    method: "patch",
    path: `${base}/{productId}/${action}`,
    tags,
    summary: `${isActive ? "Activate" : "Deactivate"} a product`,
    description: `${writeNote("product:update")}\n\nIdempotent. An inactive product stays in the catalog and on existing documents but cannot be sold or ordered.`,
    security,
    request: { params: productIdParam },
    responses: {
      200: {
        description: `Product ${action}d.`,
        content: json(successEnvelope(`${isActive ? "Activate" : "Deactivate"}ProductResponse`, ProductDataSchema, `Product ${action}d successfully.`)),
      },
      400: malformedId400,
      401: TENANT_AUTH_401,
      403: write403,
      404: productNotFound,
      500: server500,
    },
  });
}

registry.registerPath({
  method: "delete",
  path: `${base}/{productId}`,
  tags,
  summary: "Delete a product",
  description: `${writeNote("product:delete")}\n\nSoft delete of the product and all its variants; their SKUs and barcodes become reusable, and the product no longer counts toward its category's \`productCount\`, the tax rate's in-use check or the organization's currency lock. Currently a product can always be deleted: \`PRODUCT_IN_USE\` (409) is reserved for later phases (once stock or documents reference it) and is **not returned yet**.`,
  security,
  request: { params: productIdParam },
  responses: {
    200: {
      description: "Product deleted.",
      content: json(NullDataSuccessSchema("DeleteProductResponse", "Product deleted successfully.")),
    },
    400: malformedId400,
    401: TENANT_AUTH_401,
    403: write403,
    404: productNotFound,
    409: errorResponse("**Reserved, not returned yet.** Will be returned once stock or documents reference the product. Code `PRODUCT_IN_USE`.", "This product has been used and can only be deactivated.", 409, "PRODUCT_IN_USE"),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${base}/{productId}/variants`,
  tags,
  summary: "Add a variant",
  description: `${writeNote("product:update")}\n\nVariant items only (\`PRODUCT_NOT_VARIANT_ITEM\`, 400 otherwise). \`attributeValues\` must use existing options - add new options first with PATCH /products/{productId} \`attributes\`. A combination that already exists returns \`VARIANT_COMBINATION_TAKEN\` (409). Returns the whole product.`,
  security,
  request: { params: productIdParam, body: { required: true, content: json(createVariantSchema) } },
  responses: {
    201: {
      description: "Variant added; returns the whole product.",
      content: json(successEnvelope("AddVariantResponse", ProductDataSchema, "Variant added successfully.", 201)),
    },
    400: addVariant400,
    401: TENANT_AUTH_401,
    403: write403,
    404: productNotFound,
    409: addVariant409,
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{productId}/variants/{variantId}`,
  tags,
  summary: "Update a variant",
  description: `${writeNote("product:update")}\n\nUpdate \`sku\`, \`barcodes\`, \`sellingPrice\`, \`costPrice\` or \`reorderPoint\`. \`attributeValues\` cannot change: deactivate the variant and add a new one. Works for the default variant of a single item too, though PATCH /products/{productId} is simpler there. Returns the whole product. A change to \`sellingPrice\` or \`costPrice\` is recorded in the audit log (\`product.price_changed\`, before/after prices of that variant).`,
  security,
  request: { params: variantParams, body: { required: true, content: json(updateVariantSchema) } },
  responses: {
    200: {
      description: "Variant updated; returns the whole product.",
      content: json(successEnvelope("UpdateVariantResponse", ProductDataSchema, "Variant updated successfully.")),
    },
    400: updateVariant400,
    401: TENANT_AUTH_401,
    403: write403,
    404: variantNotFound,
    409: updateVariant409,
    500: server500,
  },
});

const lastVariant409 = errorResponse(
  "Deactivating the product's last active variant. Code `LAST_ACTIVE_VARIANT`; deactivate the product instead.",
  "A product must keep at least one active variant. Deactivate the product instead.",
  409,
  "LAST_ACTIVE_VARIANT"
);

for (const [action, isActive] of [
  ["deactivate", false],
  ["activate", true],
] as const) {
  registry.registerPath({
    method: "patch",
    path: `${base}/{productId}/variants/{variantId}/${action}`,
    tags,
    summary: `${isActive ? "Activate" : "Deactivate"} a variant`,
    description: `${writeNote("product:update")}\n\nVariant items only. Idempotent.`,
    security,
    request: { params: variantParams },
    responses: {
      200: {
        description: `Variant ${action}d; returns the whole product.`,
        content: json(successEnvelope(`${isActive ? "Activate" : "Deactivate"}VariantResponse`, ProductDataSchema, `Variant ${action}d successfully.`)),
      },
      400: variantItemOnly400,
      401: TENANT_AUTH_401,
      403: write403,
      404: variantNotFound,
      ...(isActive ? {} : { 409: lastVariant409 }),
      500: server500,
    },
  });
}

registry.registerPath({
  method: "delete",
  path: `${base}/{productId}/variants/{variantId}`,
  tags,
  summary: "Delete a variant",
  description: `${writeNote("product:update")}\n\nVariant items only (\`PRODUCT_NOT_VARIANT_ITEM\`, 400 otherwise). Soft delete; its SKU and barcodes become reusable. The last active variant cannot be deleted (\`LAST_ACTIVE_VARIANT\`, 409); an inactive variant can always be deleted. \`VARIANT_IN_USE\` (409) is reserved for later phases and is **not returned yet**. Returns the whole product.`,
  security,
  request: { params: variantParams },
  responses: {
    200: {
      description: "Variant deleted; returns the whole product.",
      content: json(successEnvelope("DeleteVariantResponse", ProductDataSchema, "Variant deleted successfully.")),
    },
    400: variantItemOnly400,
    401: TENANT_AUTH_401,
    403: write403,
    404: variantNotFound,
    409: errorResponse(
      [
        "Conflict. Codes:",
        "- `LAST_ACTIVE_VARIANT`: the variant is the product's only active one; deactivate the product instead.",
        "- `VARIANT_IN_USE`: **reserved, not returned yet.** Will mean the variant has stock or appears on documents; deactivate it instead.",
      ].join("\n"),
      "A product must keep at least one active variant. Deactivate the product instead.",
      409,
      "LAST_ACTIVE_VARIANT"
    ),
    500: server500,
  },
});
