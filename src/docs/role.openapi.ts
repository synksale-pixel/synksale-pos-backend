import { registry, z } from "../config/openapi.registry";
import { createRoleSchema, updateRoleSchema } from "../validators/role.validator";
import {
  RoleDataSchema,
  RoleListDataSchema,
  PermissionCatalogDataSchema,
  NullDataSuccessSchema,
  successEnvelope,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Roles"];
const base = `${API}/roles`;

const roleIdParam = z.object({
  roleId: z.string().openapi({
    description: "Role ID (24-char hex ObjectId).",
    example: "665f1c2e8a4b3c0012ab34cd",
  }),
});

const read403 = errorResponse(
  "Missing `user:read` permission.",
  "Access Denied: You do not possess the required permission (user:read) to execute this action.",
  403
);

// The actual privilege-ceiling message differs per verb ("create"/"modify"/"delete" — see
// role.service.ts), so the 403 for each write endpoint is built with the matching example text.
const manage403 = (verb: "create" | "modify" | "delete") =>
  errorResponse(
    "Not an organization-scoped role ('Access Denied: This action requires an organization-level role.'), missing `role:manage`, OR a privilege ceiling violation — you may only create, edit or delete a role whose scope and permissions you already hold yourself, both as it stands today and as you are changing it to.",
    `Access Denied: Privilege ceiling violation. You cannot ${verb} a role whose scope or permissions exceed your own.`,
    403
  );

const roleNotFound404 = errorResponse(
  "The role does not exist in your organization (roles of other organizations are reported the same way).",
  "Role not found or does not belong to your organization.",
  404
);

const ceilingNote =
  "**Privilege ceiling:** you can never create or move a role to a permission set you do not hold yourself, so role management cannot be used to escalate. Editing and deleting additionally require that you already hold everything the role grants *today* — otherwise a limited administrator could strip down a role far above them.";

// ---------------------------------------------------------------
// Reads
// ---------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List the organization's roles",
  description: [
    "Requires a **tenant** bearer token and the **`user:read`** permission.",
    "",
    "**Call this first when inviting or reassigning a user:** every staffing endpoint takes a `roleId`, and this is what resolves one. Each organization gets its own copy of the default roles at signup (`org_admin`, `store_manager`, `cashier`, `accountant`, `inventory_clerk`), so role IDs differ per organization and must not be hard-coded. The list is not fixed: an organization can also have any number of custom roles created via `POST /roles` (`isSystemRole: false`).",
    "",
    "Use `scope` to filter: **organization**-scoped roles go to `PATCH /users/{userId}/org-role`, **store**-scoped roles to the store-access endpoints. Sending one where the other is expected returns 400.",
    "",
    "Each role carries `usageCount` (how many users hold it) so a client can warn before a delete that would be refused, and `isSystemRole` (built-in roles cannot be deleted and their permissions cannot be edited).",
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
    "Requires a **tenant** bearer token and the **`user:read`** permission. Returns the fixed vocabulary of permission keys the system understands, with human-readable labels, categories and `minScope` — everything a role editor needs to render the available options.\n\n**`minScope`** is the lowest scope at which a permission is meaningful. A role may hold any permission at or below its own scope: an organization role can grant `sale:create`, but a store role cannot grant `report:view_org` (400).\n\nThis is static platform data, identical for every organization.",
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

registry.registerPath({
  method: "get",
  path: `${base}/{roleId}`,
  tags,
  summary: "Get a role",
  description:
    "Requires a **tenant** bearer token and the **`user:read`** permission. Includes `usageCount`, the number of users currently holding this role.",
  security,
  request: { params: roleIdParam },
  responses: {
    200: {
      description: "Role fetched.",
      content: json(successEnvelope("GetRoleResponse", RoleDataSchema, "Role fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: read403,
    404: roleNotFound404,
    500: server500,
  },
});

// ---------------------------------------------------------------
// Writes
// ---------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: base,
  tags,
  summary: "Create a custom role",
  description: [
    "Requires a **tenant** bearer token, an **organization-scoped role** and the **`role:manage`** permission.",
    "",
    ceilingNote,
    "",
    "**The slug is derived from `name`** (`\"Shift Supervisor\"` → `shift_supervisor`, with a numeric suffix on collision) and is never accepted from the client — it is the key the system-role reconcile matches templates on. **`scope` is immutable** after creation: flipping a store role to organization scope would instantly grant organization-wide powers to everyone already holding it.",
    "",
    "Every permission must exist in the catalog and be valid at the role's scope (see `GET /roles/permissions`).",
  ].join("\n"),
  security,
  request: { body: { required: true, content: json(createRoleSchema) } },
  responses: {
    201: {
      description: "Role created.",
      content: json(
        successEnvelope("CreateRoleResponse", RoleDataSchema, "Role created successfully.", 201)
      ),
    },
    400: errorResponse(
      "Validation failed, OR an unknown permission key, OR a permission that is not valid at this role's scope.",
      "Permission(s) not valid for a store-scoped role: report:view_org. An organization-wide permission cannot be granted by a role that only applies to one store.",
      400
    ),
    401: TENANT_AUTH_401,
    403: manage403("create"),
    409: errorResponse(
      "Could not derive a unique slug from the name after repeated attempts.",
      "Could not generate a unique slug for this role name. Try a more distinctive name.",
      409
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{roleId}`,
  tags,
  summary: "Rename a role or change its permissions",
  description: [
    "Requires a **tenant** bearer token, an **organization-scoped role** and the **`role:manage`** permission.",
    "",
    ceilingNote,
    "",
    "**Built-in roles (`isSystemRole: true`) can be renamed but their permissions cannot be changed** (400). The system-role reconcile re-adds template permissions additively, so an edit here would be silently undone the next time the permission catalog grows. Organizations needing a different permission set create a custom role instead.",
    "",
    "`scope` and `slug` are fixed at creation and are rejected as unknown fields (400).",
    "",
    "**Changes take effect on the holders' next request** — access tokens carry no permissions and `authorize` resolves them from the database every time, so there is no need to sign anyone out.",
  ].join("\n"),
  security,
  request: {
    params: roleIdParam,
    body: { required: true, content: json(updateRoleSchema) },
  },
  responses: {
    200: {
      description: "Role updated.",
      content: json(successEnvelope("UpdateRoleResponse", RoleDataSchema, "Role updated successfully.")),
    },
    400: errorResponse(
      "Validation failed, OR an attempt to change a built-in role's permissions, OR an unknown/out-of-scope permission, OR an immutable field such as `scope` was sent.",
      "'Cashier' is a built-in role and its permissions cannot be changed. Create a custom role instead.",
      400
    ),
    401: TENANT_AUTH_401,
    403: manage403("modify"),
    404: roleNotFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "delete",
  path: `${base}/{roleId}`,
  tags,
  summary: "Delete a custom role",
  description: [
    "Requires a **tenant** bearer token, an **organization-scoped role** and the **`role:manage`** permission.",
    "",
    "**Refused with 409 while any user still holds the role.** A deleted role resolves to nothing, so its holders would silently end up with zero permissions at that store — it fails closed, which is correct, but it is invisible to the administrator and undebuggable for the user. Reassign them first; `usageCount` on the role tells you how many there are. The count runs inside the same transaction as the delete, so a concurrent assignment cannot slip through.",
    "",
    "**Built-in roles cannot be deleted** (400).",
    "",
    "The delete is soft, so audit entries can still resolve the role's name, but the slug is released and can be reused by a new role.",
  ].join("\n"),
  security,
  request: { params: roleIdParam },
  responses: {
    200: {
      description: "Role deleted.",
      content: json(NullDataSuccessSchema("DeleteRoleResponse", "Role deleted successfully.")),
    },
    400: errorResponse(
      "The role is built-in and cannot be deleted.",
      "'Cashier' is a built-in role and cannot be deleted.",
      400
    ),
    401: TENANT_AUTH_401,
    403: manage403("delete"),
    404: roleNotFound404,
    409: errorResponse(
      "The role is still assigned to at least one user.",
      "This role is still assigned to 3 users. Reassign them before deleting it.",
      409
    ),
    500: server500,
  },
});
