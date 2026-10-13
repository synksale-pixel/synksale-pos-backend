import { registry, z } from "../config/openapi.registry";
import { createCategorySchema, updateCategorySchema } from "../validators/category.validator";
import {
  CategoryDataSchema,
  CategoryListDataSchema,
  NullDataSuccessSchema,
  successEnvelope,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Categories"];
const base = `${API}/categories`;

export const CATALOG_PREVIEW_NOTE =
  "> **Contract preview (Phase 1).** This endpoint is documented for review and is not implemented yet: calling it returns 404 until it ships.";

const categoryIdParam = z.object({
  categoryId: z.string().openapi({
    description: "Category ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab3700",
  }),
});

const readNote = `${CATALOG_PREVIEW_NOTE}\n\nRequires a **tenant** bearer token and **\`product:read\`** held anywhere (org role or any store role), so cashiers can browse categories. Categories are organization-wide.`;
const writeNote = (permission: string) =>
  `${CATALOG_PREVIEW_NOTE}\n\nRequires a **tenant** bearer token, an **organization-scoped role** and **\`${permission}\`** (categories share the product permissions).`;

const notFound404 = errorResponse(
  "Category does not exist in your organization (other organizations' and deleted categories look the same). Code `CATEGORY_NOT_FOUND`.",
  "Category not found.",
  404,
  "CATEGORY_NOT_FOUND"
);
const write403 = errorResponse(
  "Not an organization-scoped role, or missing the product permission.",
  "Access Denied: This action requires an organization-level role.",
  403
);
const nameTaken409 = errorResponse(
  "A category with this name already exists (case-insensitive). Code `CATEGORY_NAME_TAKEN`.",
  "A category named 'Beverages' already exists.",
  409,
  "CATEGORY_NAME_TAKEN",
  [{ field: "name", code: "CATEGORY_NAME_TAKEN" }]
);
const validation400 = errorResponse(
  "Validation failed (code `VALIDATION_FAILED`): name 1-60 chars, sortOrder whole number 0-100000, unknown fields rejected, an update must carry at least one field. A malformed `categoryId` in the path also returns 400.",
  "Request Validation Failed: name: Category name is required.",
  400,
  "VALIDATION_FAILED"
);

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List categories",
  description: `${readNote}\n\nReturns every category (a flat list, no pagination) ordered by \`sortOrder\`, then name, each with its \`productCount\`.`,
  security,
  responses: {
    200: {
      description: "Categories fetched.",
      content: json(successEnvelope("CategoryListResponse", CategoryListDataSchema, "Categories fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: errorResponse("No role grants `product:read`.", "Access Denied: You do not possess the required permission (product:read) to execute this action.", 403),
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/{categoryId}`,
  tags,
  summary: "Get a category",
  description: readNote,
  security,
  request: { params: categoryIdParam },
  responses: {
    200: {
      description: "Category fetched.",
      content: json(successEnvelope("GetCategoryResponse", CategoryDataSchema, "Category fetched successfully.")),
    },
    400: errorResponse("Malformed categoryId.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: errorResponse("No role grants `product:read`.", "Access Denied: You do not possess the required permission (product:read) to execute this action.", 403),
    404: notFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: base,
  tags,
  summary: "Create a category",
  description: writeNote("product:create"),
  security,
  request: { body: { required: true, content: json(createCategorySchema) } },
  responses: {
    201: {
      description: "Category created.",
      content: json(successEnvelope("CreateCategoryResponse", CategoryDataSchema, "Category created successfully.", 201)),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: write403,
    409: nameTaken409,
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{categoryId}`,
  tags,
  summary: "Update a category",
  description: `${writeNote("product:update")}\n\nSend \`name\` and/or \`sortOrder\`.`,
  security,
  request: { params: categoryIdParam, body: { required: true, content: json(updateCategorySchema) } },
  responses: {
    200: {
      description: "Category updated.",
      content: json(successEnvelope("UpdateCategoryResponse", CategoryDataSchema, "Category updated successfully.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    409: nameTaken409,
    500: server500,
  },
});

registry.registerPath({
  method: "delete",
  path: `${base}/{categoryId}`,
  tags,
  summary: "Delete a category",
  description: `${writeNote("product:delete")}\n\nSoft delete; the name becomes reusable. Refused while any product is in the category: move those products first.`,
  security,
  request: { params: categoryIdParam },
  responses: {
    200: {
      description: "Category deleted.",
      content: json(NullDataSuccessSchema("DeleteCategoryResponse", "Category deleted successfully.")),
    },
    400: errorResponse("Malformed categoryId.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    409: errorResponse(
      "Products still use this category. Code `CATEGORY_IN_USE`; `errors[0].meta.productCount` says how many.",
      "This category still has 24 products. Move them to another category first.",
      409,
      "CATEGORY_IN_USE",
      [{ code: "CATEGORY_IN_USE", meta: { productCount: 24 } }]
    ),
    500: server500,
  },
});
