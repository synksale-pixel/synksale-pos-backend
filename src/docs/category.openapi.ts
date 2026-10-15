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

const categoryIdParam = z.object({
  categoryId: z.string().openapi({
    description: "Category ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab3700",
  }),
});

const TREE = [
  "**Subcategories.** Categories nest at most 2 levels: top-level categories (`parentId: null`, `depth: 0`) and subcategories under them (`depth: 1`). A product can sit on either level.",
  "- Names are unique among siblings (case-insensitive), so 'Accessories' may exist under both 'Mobiles' and 'Laptops'.",
  "- `productCount` counts products directly in the category; `totalProductCount` adds those in its subcategories.",
].join("\n");

const readNote = `Requires a **tenant** bearer token and **\`product:read\`** held anywhere (org role or any store role), so cashiers can browse categories. Categories are organization-wide.\n\n${TREE}`;
const writeNote = (permission: string) =>
  `Requires a **tenant** bearer token, an **organization-scoped role** and **\`${permission}\`** (categories share the product permissions).`;

const notFound404 = errorResponse(
  "Category does not exist in your organization (other organizations' and deleted categories look the same). Code `CATEGORY_NOT_FOUND`. (A `categoryId` that does not exist inside a product request body, or a `parentId` in a category request body, is a 400, not a 404.)",
  "Category not found.",
  404,
  "CATEGORY_NOT_FOUND",
  [{ field: "categoryId", code: "CATEGORY_NOT_FOUND" }]
);
const write403 = errorResponse(
  "Not an organization-scoped role, or missing the product permission.",
  "Access Denied: This action requires an organization-level role.",
  403
);
const nameTaken409 = errorResponse(
  "A sibling (same parent, or another top-level category) already has this name (case-insensitive). Code `CATEGORY_NAME_TAKEN`. The same name under a different parent is allowed. The message ends `already exists under 'Parent'.` or `already exists at the top level.`; on update it can also come from moving into a parent that already has that name.",
  "A category named 'Accessories' already exists under 'Mobiles'.",
  409,
  "CATEGORY_NAME_TAKEN",
  [{ field: "name", code: "CATEGORY_NAME_TAKEN" }]
);
const validation400 = errorResponse(
  [
    "Validation failed. Codes:",
    "- `VALIDATION_FAILED`: name 1-60 chars, sortOrder whole number 0-100000, parentId a 24-char hex id or null, unknown fields rejected, an update must carry at least one field. A malformed `categoryId` in the path also returns 400.",
    "- `CATEGORY_NOT_FOUND`: `parentId` does not exist in your organization (`errors[0].field` is `parentId`).",
    "- `CATEGORY_DEPTH_EXCEEDED`: the parent is itself a subcategory, or (on a move) the category has subcategories of its own and the parent is not `null` (`errors[0].meta.maxDepth` is 2).",
    "- `CATEGORY_CYCLE` (update only): `parentId` is the category itself or one of its subcategories.",
  ].join("\n"),
  "'Smartphones' is already a subcategory; categories nest at most 2 levels.",
  400,
  "CATEGORY_DEPTH_EXCEEDED",
  [{ field: "parentId", code: "CATEGORY_DEPTH_EXCEEDED", meta: { maxDepth: 2 } }]
);

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List categories",
  description: `${readNote}\n\nReturns every category as one flat list (no pagination, no nesting) ordered by \`sortOrder\`, then name, each with \`parentId\`, \`depth\`, \`productCount\` and \`totalProductCount\`. Build the tree on the client by grouping on \`parentId\`.`,
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
  description: `${writeNote("product:create")}\n\nSend \`parentId\` to create a subcategory; omit it (or send null) for a top-level category.`,
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
  description: `${writeNote("product:update")}\n\nSend \`name\`, \`sortOrder\` and/or \`parentId\`.\n\n- \`parentId\` moves the category under another top-level category, or to the top level with \`null\`. A category that has subcategories can only be top-level. Its products keep their \`categoryId\`.\n- The name must be free among the new siblings.`,
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
  description: `${writeNote("product:delete")}\n\nSoft delete; the name becomes reusable. Refused while any product is directly in the category (\`CATEGORY_IN_USE\`) or it still has subcategories (\`CATEGORY_HAS_CHILDREN\`): move or delete those first.`,
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
      [
        "Conflict. Codes:",
        "- `CATEGORY_IN_USE`: products are directly in this category; `errors[0].meta.productCount` says how many.",
        "- `CATEGORY_HAS_CHILDREN`: the category still has subcategories; `errors[0].meta.childCount` says how many. Checked after `CATEGORY_IN_USE`.",
      ].join("\n"),
      "This category still has 24 products. Move them to another category first.",
      409,
      "CATEGORY_IN_USE",
      [{ code: "CATEGORY_IN_USE", meta: { productCount: 24 } }]
    ),
    500: server500,
  },
});
