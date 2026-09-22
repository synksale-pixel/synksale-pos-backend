import { registry, z } from "../config/openapi.registry";
import {
  RoleListDataSchema,
  PermissionCatalogDataSchema,
  successEnvelope,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Roles"];
const base = `${API}/roles`;

const read403 = errorResponse(
  "Missing `user:read` permission.",
  "Access Denied: You do not possess the required permission (user:read) to execute this action.",
  403
);

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List the organization's roles",
  description: [
    "Requires a **tenant** bearer token and the **`user:read`** permission.",
    "",
    "**Call this first when inviting or reassigning a user:** every staffing endpoint takes a `roleId`, and this is what resolves one. Each organization gets its own copy of the default roles at signup (`org_admin`, `store_manager`, `cashier`, `accountant`, `inventory_clerk`), so role IDs differ per organization and must not be hard-coded.",
    "",
    "Use `scope` to filter: **organization**-scoped roles go to `PATCH /users/{userId}/org-role`, **store**-scoped roles to the store-access endpoints. Sending one where the other is expected returns 400.",
    "",
    "Organization-scoped roles are listed first, then alphabetically by name.",
  ].join("\n"),
  security,
  request: {
    query: z.object({
      scope: z.enum(["organization", "store"]).optional().openapi({
        description: "Only roles of this scope. An unrecognised value is ignored.",
        example: "store",
      }),
    }),
  },
  responses: {
    200: {
      description: "Roles fetched.",
      content: json(
        successEnvelope("RoleListResponse", RoleListDataSchema, "Roles fetched successfully.")
      ),
    },
    401: TENANT_AUTH_401,
    403: read403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/permissions`,
  tags,
  summary: "List the permission catalog",
  description:
    "Requires a **tenant** bearer token and the **`user:read`** permission. Returns the fixed vocabulary of permission keys the system understands, with human-readable labels and categories — for rendering a role's `permissions` array in a UI. This is static platform data, identical for every organization.",
  security,
  responses: {
    200: {
      description: "Permission catalog fetched.",
      content: json(
        successEnvelope(
          "PermissionCatalogResponse",
          PermissionCatalogDataSchema,
          "Permission catalog fetched successfully."
        )
      ),
    },
    401: TENANT_AUTH_401,
    403: read403,
    500: server500,
  },
});
