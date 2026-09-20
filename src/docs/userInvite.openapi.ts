import { registry } from "../config/openapi.registry";
import {
  inviteSchema,
  acceptInviteSchema,
} from "../validators/userInvite.validator";
import {
  AuthRefreshDataSchema,
  InviteDataSchema,
  successEnvelope,
} from "../validators/responses";
import {
  API,
  errorResponse,
  json,
  server500,
  TENANT_AUTH_401,
} from "./common";

const tags = ["User Invites"];

registry.registerPath({
  method: "post",
  path: `${API}/users/invite`,
  tags,
  summary: "Invite a staff member",
  description: [
    "Requires a **tenant** bearer token and the **`user:invite`** permission (403 otherwise). Middleware order: authenticate, store-scope check, permission check, body validation.",
    "",
    "**Store-scoped:** if `storeId` is sent it must be a store assigned to the caller (unless the caller holds an organization-scoped role such as org_admin), else 403. For a store-scoped `roleId`, `storeId` is mandatory (400 otherwise). Permissions are evaluated for that store when `storeId` is given.",
    "",
    "**Privilege ceiling:** you cannot invite someone into a role whose scope or permissions exceed your own (403).",
    "",
    "Creates a pending, inactive user. The backend does NOT send an email: hand `data.inviteLink` to the invitee. The plaintext `inviteToken` is only returned here. Invitations expire (default 3 days, server configured).",
  ].join("\n"),
  security: [{ tenantBearerAuth: [] }],
  request: { body: { required: true, content: json(inviteSchema) } },
  responses: {
    201: {
      description: "Invitation created.",
      content: json(
        successEnvelope(
          "InviteResponse",
          InviteDataSchema,
          "User invitation created successfully.",
          201
        )
      ),
    },
    400: errorResponse(
      "Validation failed, OR 'A user with this email address is already registered in your organization.' (duplicate email is reported as 400, not 409), OR 'Store context is required for assigning a store-scoped role.'",
      "A user with this email address is already registered in your organization.",
      400
    ),
    401: TENANT_AUTH_401,
    403: errorResponse(
      "Missing `user:invite` permission, storeId not among your assigned stores, or privilege ceiling violation.",
      "Access Denied: You do not possess the required permission (user:invite) to execute this action.",
      403
    ),
    404: errorResponse(
      "Role does not exist or does not belong to your organization.",
      "Role not found or does not belong to your organization.",
      404
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${API}/users/accept-invite`,
  tags,
  summary: "Accept an invitation and set a password (public)",
  description:
    "Public (the invitee has no account yet). Validates the invite token, sets the password, activates the user and returns a TENANT access/refresh token pair, so the invitee is logged in immediately (no separate login call needed). The token is single-use.",
  request: { body: { required: true, content: json(acceptInviteSchema) } },
  responses: {
    200: {
      description: "Invitation accepted; user activated and logged in.",
      content: json(
        successEnvelope(
          "AcceptInviteResponse",
          AuthRefreshDataSchema,
          "Invitation accepted and account activated successfully."
        )
      ),
    },
    400: errorResponse(
      "Validation failed, OR 'Invalid or expired invitation token.' (unknown/already used), OR 'Invitation link has expired.'",
      "Invalid or expired invitation token.",
      400
    ),
    500: server500,
  },
});
