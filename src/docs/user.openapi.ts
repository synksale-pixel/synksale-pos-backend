import { registry, z } from "../config/openapi.registry";
import {
  setOrgRoleSchema,
  grantStoreAccessSchema,
  updateStoreAccessSchema,
} from "../validators/user.validator";
import {
  UserDataSchema,
  UserListDataSchema,
  InviteDataSchema,
  NullDataSuccessSchema,
  successEnvelope,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Staff Management"];
const base = `${API}/users`;

const userIdParam = z.object({
  userId: z.string().openapi({
    description: "User ID (24-char hex ObjectId).",
    example: "665f1c2e8a4b3c0012ab3401",
  }),
});

const userStoreParams = z.object({
  userId: z.string().openapi({
    description: "User ID (24-char hex ObjectId).",
    example: "665f1c2e8a4b3c0012ab3401",
  }),
  storeId: z.string().openapi({
    description: "Store the assignment belongs to (24-char hex ObjectId).",
    example: "665f1c2e8a4b3c0012ab34ef",
  }),
});

const userNotFound404 = errorResponse(
  "The user does not exist in your organization. Store-scoped staff also get 404 (not 403) for a user who shares none of their stores, so this endpoint cannot be used to probe who exists.",
  "User not found.",
  404
);

const ceiling403 = (permission: string) =>
  errorResponse(
    `Missing \`${permission}\` permission, OR privilege ceiling violation: you may only act on a user whose current access you already hold yourself (\`canManageUser\`), and you may only assign a role whose scope and permissions you already hold (\`canGrantRole\`).`,
    "Access Denied: Privilege ceiling violation. You cannot manage a user whose access exceeds your own.",
    403
  );

const orgRole403 = (permission: string) =>
  errorResponse(
    `Not an organization-scoped role ('Access Denied: This action requires an organization-level role.'), missing \`${permission}\` permission, or a privilege ceiling violation.`,
    "Access Denied: This action requires an organization-level role.",
    403
  );

const visibilityNote =
  "**Visibility:** organization-scoped roles (e.g. org_admin) see every user in the organization. Store-scoped staff see only users assigned to one of THEIR stores — a cashier cannot read the organization's full staff directory.";

// ---------------------------------------------------------------
// Roster
// ---------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List staff",
  description: [
    "Requires a **tenant** bearer token and the **`user:read`** permission.",
    "",
    visibilityNote,
    "",
    "Newest first. Query parameters are parsed leniently: invalid or non-positive `page`/`limit` fall back to the defaults (page 1, limit 20) and `limit` is capped at 100; an unrecognised `status` is ignored rather than rejected.",
  ].join("\n"),
  security,
  request: {
    query: z.object({
      q: z.string().optional().openapi({
        description:
          "Case-insensitive partial match on first name, last name or email. Regex metacharacters are escaped, so the term is treated literally.",
        example: "priya",
      }),
      storeId: z.string().optional().openapi({
        description:
          "Only users assigned to this store. Combined with (not replacing) your own visibility limits.",
        example: "665f1c2e8a4b3c0012ab34ef",
      }),
      roleId: z.string().optional().openapi({
        description: "Only users holding this role, either organization-wide or at any store.",
        example: "665f1c2e8a4b3c0012ab34cd",
      }),
      status: z.enum(["active", "inactive", "pending"]).optional().openapi({
        description:
          "`active` = accepted and enabled. `inactive` = accepted but deactivated. `pending` = invited, invitation not yet accepted.",
        example: "active",
      }),
      page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
      limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
    }),
  },
  responses: {
    200: {
      description: "Users fetched.",
      content: json(
        successEnvelope("UserListResponse", UserListDataSchema, "Users fetched successfully.")
      ),
    },
    401: TENANT_AUTH_401,
    403: errorResponse(
      "Missing `user:read` permission.",
      "Access Denied: You do not possess the required permission (user:read) to execute this action.",
      403
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/{userId}`,
  tags,
  summary: "Get a staff member",
  description: `Requires a **tenant** bearer token and the **\`user:read\`** permission.\n\n${visibilityNote} A user you cannot see is reported as 404.`,
  security,
  request: { params: userIdParam },
  responses: {
    200: {
      description: "User fetched.",
      content: json(successEnvelope("GetUserResponse", UserDataSchema, "User fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: errorResponse(
      "Missing `user:read` permission.",
      "Access Denied: You do not possess the required permission (user:read) to execute this action.",
      403
    ),
    404: userNotFound404,
    500: server500,
  },
});

// ---------------------------------------------------------------
// Organization role
// ---------------------------------------------------------------

registry.registerPath({
  method: "patch",
  path: `${base}/{userId}/org-role`,
  tags,
  summary: "Set or clear a user's organization role",
  description: [
    "Requires a **tenant** bearer token, an **organization-scoped role** and the **`user:manage_roles`** permission.",
    "",
    "Send an organization-scoped `roleId`, or `null` to remove the user's organization-wide role and leave them with only their store assignments. A store-scoped role is rejected with 400 — use the store-access endpoints for those.",
    "",
    "**Guards:** you cannot change your own organization role (400 — ask another administrator, so nobody can lock themselves out). The change is refused with 409 if it would leave the organization with no active administrator; that check runs inside the same transaction as the update, so two concurrent demotions cannot both succeed.",
  ].join("\n"),
  security,
  request: {
    params: userIdParam,
    body: { required: true, content: json(setOrgRoleSchema) },
  },
  responses: {
    200: {
      description: "Organization role updated.",
      content: json(
        successEnvelope("SetOrgRoleResponse", UserDataSchema, "Organization role updated successfully.")
      ),
    },
    400: errorResponse(
      "Validation failed, OR the role is store-scoped (`Role 'Cashier' is store-scoped and cannot be assigned as a organization-scoped role.`), OR you targeted your own account.",
      "You cannot change the organization role of your own account. Ask another administrator to do it.",
      400
    ),
    401: TENANT_AUTH_401,
    403: orgRole403("user:manage_roles"),
    404: errorResponse(
      "The user does not exist in your organization, OR the role does not exist / belongs to another organization.",
      "Role not found or does not belong to your organization.",
      404
    ),
    409: errorResponse(
      "The change would leave the organization without an active administrator.",
      "This is the last active administrator of the organization. Assign the role to another user first.",
      409
    ),
    500: server500,
  },
});

// ---------------------------------------------------------------
// Store access
// ---------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: `${base}/{userId}/store-access`,
  tags,
  summary: "Assign a user to a store",
  description: [
    "Requires a **tenant** bearer token and the **`user:manage_roles`** permission, plus access to the target store (organization-scoped roles reach any store in the organization).",
    "",
    "This is how an existing employee is added to another store. `roleId` must be a **store-scoped** role. A user holds at most one role per store: if they are already assigned to this store the request is 409 — use `PATCH /users/{userId}/store-access/{storeId}` to change their role there.",
    "",
    "The store must be **active**: nobody can be assigned to a deactivated store (400).",
  ].join("\n"),
  security,
  request: {
    params: userIdParam,
    body: { required: true, content: json(grantStoreAccessSchema) },
  },
  responses: {
    201: {
      description: "Store access granted.",
      content: json(
        successEnvelope("GrantStoreAccessResponse", UserDataSchema, "Store access granted successfully.", 201)
      ),
    },
    400: errorResponse(
      "Validation failed, OR malformed storeId, OR the role is organization-scoped, OR `Cannot assign a user to a deactivated store.`",
      "Cannot assign a user to a deactivated store.",
      400
    ),
    401: TENANT_AUTH_401,
    403: ceiling403("user:manage_roles"),
    404: errorResponse(
      "The user, the store or the role does not exist in your organization.",
      "Store not found or does not belong to your organization.",
      404
    ),
    409: errorResponse(
      "The user already holds a role at this store.",
      "This user is already assigned to that store. Update their existing assignment instead.",
      409
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{userId}/store-access/{storeId}`,
  tags,
  summary: "Change a user's role at a store",
  description:
    "Requires a **tenant** bearer token and the **`user:manage_roles`** permission, plus access to the store. `roleId` must be a **store-scoped** role. Deactivated stores remain reachable here so assignments can still be corrected.",
  security,
  request: {
    params: userStoreParams,
    body: { required: true, content: json(updateStoreAccessSchema) },
  },
  responses: {
    200: {
      description: "Store access updated.",
      content: json(
        successEnvelope("UpdateStoreAccessResponse", UserDataSchema, "Store access updated successfully.")
      ),
    },
    400: errorResponse(
      "Validation failed, OR malformed storeId, OR the role is organization-scoped.",
      "Invalid storeId format. Must be a 24-character hex string.",
      400
    ),
    401: TENANT_AUTH_401,
    403: ceiling403("user:manage_roles"),
    404: errorResponse(
      "The user, store or role does not exist in your organization, OR the user is not assigned to that store.",
      "This user is not assigned to that store.",
      404
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "delete",
  path: `${base}/{userId}/store-access/{storeId}`,
  tags,
  summary: "Remove a user from a store",
  description:
    "Requires a **tenant** bearer token and the **`user:manage_roles`** permission, plus access to the store. Removing staff from a **deactivated** store is always allowed — a closed store must never trap its employees. The user keeps every other assignment.",
  security,
  request: { params: userStoreParams },
  responses: {
    200: {
      description: "Store access revoked.",
      content: json(
        successEnvelope("RevokeStoreAccessResponse", UserDataSchema, "Store access revoked successfully.")
      ),
    },
    400: errorResponse(
      "Malformed storeId.",
      "Invalid storeId format. Must be a 24-character hex string.",
      400
    ),
    401: TENANT_AUTH_401,
    403: ceiling403("user:manage_roles"),
    404: errorResponse(
      "The user or store does not exist in your organization, OR the user is not assigned to that store.",
      "This user is not assigned to that store.",
      404
    ),
    500: server500,
  },
});

// ---------------------------------------------------------------
// Activation
// ---------------------------------------------------------------

registry.registerPath({
  method: "patch",
  path: `${base}/{userId}/deactivate`,
  tags,
  summary: "Deactivate a staff member",
  description: [
    "Requires a **tenant** bearer token, an **organization-scoped role** and the **`user:manage`** permission. Idempotent.",
    "",
    "**This is the only way to remove an employee who has accepted their invitation.** Their records are never deleted, because sales and inventory history will reference them. All refresh tokens are cleared, so no session can be renewed; `authenticate` rejects the account on the next request, which closes the remaining window on an already-issued access token.",
    "",
    "**Guards:** you cannot deactivate yourself (400), and the request is refused with 409 if it would leave the organization without an active administrator.",
  ].join("\n"),
  security,
  request: { params: userIdParam },
  responses: {
    200: {
      description: "User deactivated.",
      content: json(
        successEnvelope("DeactivateUserResponse", UserDataSchema, "User deactivated successfully.")
      ),
    },
    400: errorResponse(
      "You targeted your own account.",
      "You cannot deactivate your own account. Ask another administrator to do it.",
      400
    ),
    401: TENANT_AUTH_401,
    403: orgRole403("user:manage"),
    404: userNotFound404,
    409: errorResponse(
      "Deactivating this user would leave the organization without an active administrator.",
      "This is the last active administrator of the organization. Assign the role to another user first.",
      409
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{userId}/activate`,
  tags,
  summary: "Reactivate a staff member",
  description:
    "Requires a **tenant** bearer token, an **organization-scoped role** and the **`user:manage`** permission. Idempotent. Their previous store assignments are still intact, so access is restored as it was.\n\nA user whose invitation is still `pending` cannot be activated this way (400): they have no password yet, so the account would be unusable. They become active by accepting their invitation.",
  security,
  request: { params: userIdParam },
  responses: {
    200: {
      description: "User activated.",
      content: json(
        successEnvelope("ActivateUserResponse", UserDataSchema, "User activated successfully.")
      ),
    },
    400: errorResponse(
      "The user has not accepted their invitation yet.",
      "This user has not accepted their invitation yet and cannot be activated manually.",
      400
    ),
    401: TENANT_AUTH_401,
    403: orgRole403("user:manage"),
    404: userNotFound404,
    500: server500,
  },
});

// ---------------------------------------------------------------
// Pending invite lifecycle
// ---------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: `${base}/{userId}/invite/resend`,
  tags,
  summary: "Resend a pending invitation",
  description:
    "Requires a **tenant** bearer token and the **`user:invite`** permission. Issues a fresh token and expiry; the previous link stops working immediately. Only valid while `inviteStatus` is `pending` (400 otherwise).\n\nAs with the original invite, `inviteToken`/`inviteLink` are returned OUTSIDE production only — see `delivery`.",
  security,
  request: { params: userIdParam },
  responses: {
    200: {
      description: "Invitation resent.",
      content: json(
        successEnvelope("ResendInviteResponse", InviteDataSchema, "Invitation resent successfully.")
      ),
    },
    400: errorResponse(
      "The user has already accepted their invitation.",
      "This user has already accepted their invitation.",
      400
    ),
    401: TENANT_AUTH_401,
    403: ceiling403("user:invite"),
    404: userNotFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "delete",
  path: `${base}/{userId}/invite`,
  tags,
  summary: "Revoke a pending invitation",
  description: [
    "Requires a **tenant** bearer token and the **`user:invite`** permission.",
    "",
    "**Deletes the pending user outright.** That is deliberate: they have never logged in and nothing references them, and removing the row frees the email address to be invited again. Only valid while `inviteStatus` is `pending` — a user who has accepted can only be deactivated (400).",
  ].join("\n"),
  security,
  request: { params: userIdParam },
  responses: {
    200: {
      description: "Invitation revoked.",
      content: json(
        NullDataSuccessSchema("RevokeInviteResponse", "Invitation revoked successfully.")
      ),
    },
    400: errorResponse(
      "The user has already accepted their invitation.",
      "This user has already accepted their invitation and can only be deactivated.",
      400
    ),
    401: TENANT_AUTH_401,
    403: ceiling403("user:invite"),
    404: userNotFound404,
    500: server500,
  },
});
