import { registry, z } from "../config/openapi.registry";
import { createStoreSchema, updateStoreSchema } from "../validators/store.validator";
import {
  StoreDataSchema,
  StoreListDataSchema,
  successEnvelope,
} from "../validators/responses";
import {
  API,
  errorResponse,
  json,
  server500,
  TENANT_AUTH_401,
} from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Stores"];
const base = `${API}/stores`;

const storeIdParam = z.object({
  storeId: z.string().openapi({
    description: "Store ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab34ef",
  }),
});

const badStoreId400 = errorResponse(
  "Validation failed, OR malformed storeId (`Invalid storeId format. Must be a 24-character hex string.`).",
  "Invalid storeId format. Must be a 24-character hex string.",
  400
);
const notFound404 = errorResponse(
  "Store does not exist in your organization (stores of other organizations are reported the same way).",
  "Store not found.",
  404
);
const storeAccess403 = (permission: string) =>
  errorResponse(
    `Missing \`${permission}\` permission, or the store is not one of your assigned stores.`,
    `Access Denied: You do not possess the required permission (${permission}) to execute this action.`,
    403
  );

const orgRole403 = (permission: string) =>
  errorResponse(
    `Not an organization-scoped role ('Access Denied: This action requires an organization-level role.'), missing \`${permission}\` permission, or the store is not one of your assigned stores.`,
    "Access Denied: This action requires an organization-level role.",
    403
  );

const managePathNote =
  "Requires a **tenant** bearer token. Middleware order: authenticate, store-access check (400 malformed storeId, 403 no access, 404 not found in your organization), then any permission/role checks listed below. Store-scoped staff can only reach stores assigned to them; organization-scoped roles (e.g. org_admin) can reach any store in the organization. Deactivated stores remain reachable here so they can be reactivated.";

registry.registerPath({
  method: "post",
  path: base,
  tags,
  summary: "Create a store",
  description:
    "Requires a **tenant** bearer token and the **`store:create`** permission (organization-scoped roles such as org_admin). The store is always created in the caller's organization. `code` is unique per organization, stored uppercase and cannot be changed later. `countryCode` is REQUIRED and must be a country that uses the organization's currency (e.g. `BH` for a BHD organization, `AE` for AED), otherwise the request fails with 400 `STORE_COUNTRY_CURRENCY_MISMATCH`.",
  security,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createStoreSchema,
          example: {
            name: "Al Noor - Manama Central",
            code: "MNM-001",
            address: {
              line1: "Building 12, Road 3801",
              line2: "Block 338, Al Mutanabi Avenue",
              city: "Manama",
              state: "Capital Governorate",
              country: "Bahrain",
              postalCode: "338",
            },
            countryCode: "BH",
            timezone: "Asia/Bahrain",
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: "Store created.",
      content: json(
        successEnvelope("CreateStoreResponse", StoreDataSchema, "Store created successfully.", 201)
      ),
    },
    400: errorResponse(
      "Validation failed (e.g. missing/unknown `countryCode`, invalid timezone or code format; code `VALIDATION_FAILED`), OR the country does not use the organization's currency (code `STORE_COUNTRY_CURRENCY_MISMATCH`, `errors[0] = { field: \"countryCode\", code, meta: { countryCode, organizationCurrency } }`).",
      "Stores of this organization must be in a country that uses BHD.",
      400,
      "STORE_COUNTRY_CURRENCY_MISMATCH",
      [
        {
          field: "countryCode",
          code: "STORE_COUNTRY_CURRENCY_MISMATCH",
          meta: { countryCode: "IN", organizationCurrency: "BHD" },
        },
      ]
    ),
    401: TENANT_AUTH_401,
    403: storeAccess403("store:create"),
    409: errorResponse(
      "A store with this code already exists in your organization.",
      "A store with code 'MNM-001' already exists in your organization.",
      409
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List stores",
  description:
    "Requires a **tenant** bearer token; no specific permission. Organization-scoped roles see every store in the organization; store-scoped staff see only their assigned stores. Newest first. Query parameters are not strictly validated: invalid/non-positive `page`/`limit` fall back to defaults (page 1, limit 20), `limit` is capped at 100.",
  security,
  request: {
    query: z.object({
      isActive: z.enum(["true", "false"]).optional().openapi({
        description: "Filter by active state.",
        example: "true",
      }),
      page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
      limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
    }),
  },
  responses: {
    200: {
      description: "Stores fetched.",
      content: json(
        successEnvelope("StoreListResponse", StoreListDataSchema, "Stores fetched successfully.")
      ),
    },
    401: TENANT_AUTH_401,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/{storeId}`,
  tags,
  summary: "Get a store",
  description: `${managePathNote}\n\nNo specific permission is needed beyond access to the store.`,
  security,
  request: { params: storeIdParam },
  responses: {
    200: {
      description: "Store fetched.",
      content: json(successEnvelope("GetStoreResponse", StoreDataSchema, "Store fetched successfully.")),
    },
    400: badStoreId400,
    401: TENANT_AUTH_401,
    403: errorResponse(
      "The store is not one of your assigned stores.",
      "Access Denied: You do not have access authorization for the requested store.",
      403
    ),
    404: notFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{storeId}`,
  tags,
  summary: "Update a store",
  description: `${managePathNote}\n\nRequires **\`store:configure\`**. Updatable fields: \`name\`, \`address\` (any subset of fields), \`countryCode\` and \`timezone\`; send at least one. \`countryCode\` (optional here) must be a country that uses the organization's currency, otherwise 400 \`STORE_COUNTRY_CURRENCY_MISMATCH\`. \`code\` is immutable: sending it (or any unknown field) returns 400.`,
  security,
  request: {
    params: storeIdParam,
    body: { required: true, content: json(updateStoreSchema) },
  },
  responses: {
    200: {
      description: "Store updated.",
      content: json(successEnvelope("UpdateStoreResponse", StoreDataSchema, "Store updated successfully.")),
    },
    400: errorResponse(
      "Validation failed, malformed storeId, OR `countryCode` does not use the organization's currency (code `STORE_COUNTRY_CURRENCY_MISMATCH`, `errors[0] = { field: \"countryCode\", code, meta: { countryCode, organizationCurrency } }`).",
      "Stores of this organization must be in a country that uses BHD.",
      400,
      "STORE_COUNTRY_CURRENCY_MISMATCH",
      [
        {
          field: "countryCode",
          code: "STORE_COUNTRY_CURRENCY_MISMATCH",
          meta: { countryCode: "IN", organizationCurrency: "BHD" },
        },
      ]
    ),
    401: TENANT_AUTH_401,
    403: storeAccess403("store:configure"),
    404: notFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{storeId}/deactivate`,
  tags,
  summary: "Deactivate a store",
  description: `${managePathNote}\n\nRequires an **organization-scoped role** (e.g. org_admin; store-scoped staff get 403 even if their role has \`store:configure\`) plus **\`store:configure\`**. Idempotent. While inactive, store-scoped requests for this store (e.g. inviting staff to it) are rejected with 403 and new staff cannot be assigned to it. Users' store assignments are kept, so reactivating restores access. Stores cannot be deleted; their codes stay reserved.`,
  security,
  request: { params: storeIdParam },
  responses: {
    200: {
      description: "Store deactivated.",
      content: json(
        successEnvelope("DeactivateStoreResponse", StoreDataSchema, "Store deactivated successfully.")
      ),
    },
    400: badStoreId400,
    401: TENANT_AUTH_401,
    403: orgRole403("store:configure"),
    404: notFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{storeId}/activate`,
  tags,
  summary: "Reactivate a store",
  description: `${managePathNote}\n\nRequires an **organization-scoped role** (e.g. org_admin; store-scoped staff get 403) plus **\`store:configure\`**. Idempotent.`,
  security,
  request: { params: storeIdParam },
  responses: {
    200: {
      description: "Store activated.",
      content: json(
        successEnvelope("ActivateStoreResponse", StoreDataSchema, "Store activated successfully.")
      ),
    },
    400: badStoreId400,
    401: TENANT_AUTH_401,
    403: orgRole403("store:configure"),
    404: notFound404,
    500: server500,
  },
});
