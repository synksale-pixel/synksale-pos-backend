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
import { CATALOG_PREVIEW_NOTE } from "./category.openapi";

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
  "**Contract rules**",
  "- Every product has at least one variant. Stock, purchase and sale lines always reference a `variantId`. A `single` item has one hidden default variant (`isDefault: true`); send its SKU, barcodes, prices and reorder point at the top level exactly as the form groups them. A `variant` item sends `attributes` + `variants` instead.",
  "- Money is a **decimal string** (`\"4.500\"`), never a number, with no more decimals than the organization's currency (`GET /organization` → `currency.decimals`; BHD 3). Responses use the same format.",
  "- `sales.sellingPrice` / variant `sellingPrice` are **VAT-inclusive** when the organization's `settings.sales.pricesIncludeTax` is true (default). Cost prices are always VAT-exclusive.",
  "- `taxPreference` is `standard` (uses `taxRateId`, or the organization's default rate when omitted), `zero_rated`, `exempt` or `out_of_scope` (no tax rate).",
  "- `type` (goods/service) and `itemType` (single/variant) cannot change after creation. Services are single, have no brand/manufacturer and never track inventory.",
  "- SKU is optional and unique per organization (case-insensitive). UPC/EAN/ISBN are unique per organization and scannable; MPN is reference only.",
  "- Quantities (`reorderPoint`) are whole numbers unless the unit is kg, g, L, mL, m or cm (up to 3 decimals).",
  "- **Not accepted yet:** `openingStock` / `openingStockValue` (arrive with stock tracking), `valuationMethod` (always weighted average), image uploads (`imageUrl` is a link). `price` and `stock` are computed by the server, not sent.",
].join("\n");

const readNote = `${CATALOG_PREVIEW_NOTE}\n\nRequires a **tenant** bearer token and **\`product:read\`** held anywhere (org role or any store role), so cashiers can search and scan. The catalog is organization-wide.`;
const writeNote = (permission: string) =>
  `${CATALOG_PREVIEW_NOTE}\n\nRequires a **tenant** bearer token, an **organization-scoped role** and **\`${permission}\`**.`;

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
const productWrite400 = errorResponse(
  [
    "Validation failed. Codes:",
    "- `VALIDATION_FAILED`: schema or cross-field rule (see Contract rules); `errors` lists each issue with its `path`.",
    "- `TOO_MANY_DECIMALS` / `INVALID_AMOUNT`: a price has more decimals than the currency allows (`meta.decimals`).",
    "- `CATEGORY_NOT_FOUND`, `TAX_RATE_NOT_FOUND`, `TAX_RATE_INACTIVE`: the referenced category/rate is missing or inactive.",
    "- `TAX_RATE_REQUIRED`: `standard` product, no `taxRateId`, and the organization has no default rate.",
    "- `PRODUCT_IS_VARIANT_ITEM` (PATCH /products/{productId}): a variant item was sent `sku`, `barcodes`, `sales.sellingPrice`, `purchase.costPrice` or `inventory.reorderPoint`; use the variant endpoints.",
    "- `PRODUCT_NOT_VARIANT_ITEM` (variant endpoints): the product is a single item.",
    "- A malformed `productId` / `variantId` in the path also returns 400.",
  ].join("\n"),
  "Request Validation Failed: sales.sellingPrice: Selling price is required for a single item.",
  400,
  "VALIDATION_FAILED"
);
const malformedId400 = errorResponse(
  "Malformed `productId` / `variantId` in the path.",
  "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'",
  400
);
const variantItemOnly400 = errorResponse(
  "Malformed id in the path, or the product is a single item. Code `PRODUCT_NOT_VARIANT_ITEM` for the latter.",
  "This product is a single item and has no separately managed variants.",
  400,
  "PRODUCT_NOT_VARIANT_ITEM"
);
const update409 = errorResponse(
  [
    "Conflict. Codes:",
    "- `SKU_TAKEN` / `BARCODE_TAKEN`: the SKU or a scannable barcode is used by another variant (`errors[].meta` names the value and the product that has it).",
    "- `ATTRIBUTE_OPTION_IN_USE`: `attributes` removes or renames an option that a variant uses.",
    "- `ATTRIBUTES_LOCKED`: `attributes` adds or removes a whole attribute.",
  ].join("\n"),
  "Option 'M' of Size is used by a variant and cannot be removed.",
  409,
  "ATTRIBUTE_OPTION_IN_USE"
);
const addVariant409 = errorResponse(
  [
    "Conflict. Codes:",
    "- `VARIANT_COMBINATION_TAKEN`: a variant with these `attributeValues` already exists.",
    "- `SKU_TAKEN` / `BARCODE_TAKEN`: the SKU or a scannable barcode is used by another variant (`errors[].meta` names the value and the product that has it).",
  ].join("\n"),
  "A variant with Size: M, Colour: Red already exists.",
  409,
  "VARIANT_COMBINATION_TAKEN"
);
const uniqueness409 = errorResponse(
  "A SKU or scannable barcode is already used by another variant in your organization. Code `SKU_TAKEN` or `BARCODE_TAKEN`; `errors[].meta` names the value and the product that has it.",
  "SKU 'TSHIRT-RED-M' is already used by 'Crew-neck T-shirt'.",
  409,
  "SKU_TAKEN",
  [{ field: "variants[0].sku", code: "SKU_TAKEN", meta: { value: "TSHIRT-RED-M", productId: "665f1c2e8a4b3c0012ab3800", productName: "Crew-neck T-shirt" } }]
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
  description: `${readNote}\n\nPaginated product summaries, newest first (by name when \`search\` is given). \`search\` is a case-insensitive prefix match on name, SKU or barcode, suitable for typeahead. Fetch a product for its variants.`,
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
  description: `${readNote}\n\nFor scan-to-cart: exact match on a variant's UPC, EAN, ISBN or SKU (SKU case-insensitive). Returns the full product plus the matched \`variantId\` and what matched (\`matchedOn\`: sku, upc, ean or isbn). Inactive products and variants are still returned (check \`isActive\`) so the POS can explain why it cannot sell them.`,
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
    400: productWrite400,
    401: TENANT_AUTH_401,
    403: write403,
    409: uniqueness409,
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
    "- **Variant items** may send the full `attributes` list to add options. Removing an option a variant uses (`ATTRIBUTE_OPTION_IN_USE`) or adding/removing a whole attribute (`ATTRIBUTES_LOCKED`) is refused (409).",
    "- Changing `taxPreference` away from `standard` clears `taxRateId`; sending a `taxRateId` together with a non-standard preference is refused (400).",
    "- Changing `unit` to a whole-number unit (e.g. kg → pcs) is refused while any variant has a fractional `reorderPoint`.",
    "- An update made only of empty groups (e.g. `{ \"sales\": {} }`) is refused: send at least one actual value.",
    "- Price changes are recorded in the audit log.",
  ].join("\n"),
  security,
  request: { params: productIdParam, body: { required: true, content: json(updateProductSchema) } },
  responses: {
    200: {
      description: "Product updated.",
      content: json(successEnvelope("UpdateProductResponse", ProductDataSchema, "Product updated successfully.")),
    },
    400: productWrite400,
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
  description: `${writeNote("product:delete")}\n\nSoft delete of the product and its variants; their SKUs and barcodes become reusable. Once stock or documents exist (later phases), a product that has been used can only be deactivated (\`PRODUCT_IN_USE\`, 409).`,
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
    409: errorResponse("The product has stock or appears on documents. Code `PRODUCT_IN_USE`.", "This product has been used and can only be deactivated.", 409, "PRODUCT_IN_USE"),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${base}/{productId}/variants`,
  tags,
  summary: "Add a variant",
  description: `${writeNote("product:update")}\n\nVariant items only (\`PRODUCT_NOT_VARIANT_ITEM\`, 400 otherwise). \`attributeValues\` must use existing options - add new options first with PATCH /products/{productId} \`attributes\`. A combination that already exists returns \`VARIANT_COMBINATION_TAKEN\` (409).`,
  security,
  request: { params: productIdParam, body: { required: true, content: json(createVariantSchema) } },
  responses: {
    201: {
      description: "Variant added; returns the whole product.",
      content: json(successEnvelope("AddVariantResponse", ProductDataSchema, "Variant added successfully.", 201)),
    },
    400: productWrite400,
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
  description: `${writeNote("product:update")}\n\nUpdate \`sku\`, \`barcodes\`, \`sellingPrice\`, \`costPrice\` or \`reorderPoint\`. \`attributeValues\` cannot change: deactivate the variant and add a new one. Works for the default variant of a single item too, though PATCH /products/{productId} is simpler there.`,
  security,
  request: { params: variantParams, body: { required: true, content: json(updateVariantSchema) } },
  responses: {
    200: {
      description: "Variant updated; returns the whole product.",
      content: json(successEnvelope("UpdateVariantResponse", ProductDataSchema, "Variant updated successfully.")),
    },
    400: productWrite400,
    401: TENANT_AUTH_401,
    403: write403,
    404: variantNotFound,
    409: uniqueness409,
    500: server500,
  },
});

const lastVariant409 = errorResponse(
  "A product must keep at least one active variant. Code `LAST_ACTIVE_VARIANT`; deactivate the product instead.",
  "A product must keep at least one active variant.",
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
  description: `${writeNote("product:update")}\n\nVariant items only. Soft delete; its SKU and barcodes become reusable. A variant that has stock or appears on documents (later phases) can only be deactivated (\`VARIANT_IN_USE\`, 409).`,
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
        "- `LAST_ACTIVE_VARIANT`: a product must keep at least one active variant; deactivate the product instead.",
        "- `VARIANT_IN_USE`: the variant has stock or appears on documents (later phases); deactivate it instead.",
      ].join("\n"),
      "A product must keep at least one active variant.",
      409,
      "LAST_ACTIVE_VARIANT"
    ),
    500: server500,
  },
});
