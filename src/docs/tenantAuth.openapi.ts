import { registry, z } from "../config/openapi.registry";
import {
  signupSchema,
  tenantLoginSchema,
} from "../validators/organizationAuth.validator";
import {
  refreshSchema,
  logoutSchema,
} from "../validators/platformAuth.validator";
import {
  AuthRefreshDataSchema,
  SignupDataSchema,
  TenantLoginDataSchema,
  TenantMeSchema,
  successEnvelope,
  NullDataSuccessSchema,
} from "../validators/responses";
import {
  API,
  errorResponse,
  json,
  server500,
  validation400,
  TENANT_AUTH_401,
} from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Organization Auth"];

registry.registerPath({
  method: "post",
  path: `${API}/auth/signup`,
  tags,
  summary: "Submit an organization application (public)",
  description:
    "Public. Creates a new organization in `pending` state together with its first admin user (role `org_admin`). **No tokens are returned**: the organization cannot log in until a Super Admin approves it (see `/platform/organizations/{id}/approve`). Keep `data.organization.slug`: it is the `orgSlug` needed at login. Runs atomically in a DB transaction.",
  request: { body: { required: true, content: json(signupSchema) } },
  responses: {
    201: {
      description: "Application received (pending approval).",
      content: json(
        successEnvelope(
          "SignupResponse",
          SignupDataSchema,
          "Application received. You will be notified once your organization is approved.",
          201
        )
      ),
    },
    400: validation400,
    409: errorResponse(
      "An organization application with this admin email already exists (pending or approved).",
      "An organization application with this admin email already exists.",
      409
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${API}/auth/login`,
  tags,
  summary: "Tenant login (public)",
  description:
    "Public. Authenticates a tenant user within an organization identified by `orgSlug`. Returns a TENANT access token (use with `tenantBearerAuth`) and a refresh token. Wrong slug, email or password all give the same generic 401 (no user enumeration). 403 is returned only after credentials were verified, when the organization is pending/rejected/suspended or the user is deactivated (the `message` says which).",
  request: { body: { required: true, content: json(tenantLoginSchema) } },
  responses: {
    200: {
      description: "Logged in.",
      content: json(
        successEnvelope(
          "TenantLoginResponse",
          TenantLoginDataSchema,
          "Logged in successfully"
        )
      ),
    },
    400: validation400,
    401: errorResponse("Invalid credentials.", "Invalid credentials", 401),
    403: errorResponse(
      "Credentials valid but access is blocked. Possible messages: 'Your organization application is still pending review.', 'Your organization application was not approved.', 'Access Denied: Your organization account has been suspended.', 'Access Denied: Your user account has been deactivated.'",
      "Your organization application is still pending review.",
      403
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${API}/auth/refresh`,
  tags,
  summary: "Rotate tokens (public)",
  description:
    "Public. Exchanges a valid tenant refresh token for a NEW access token and a NEW refresh token. The old refresh token is invalidated immediately (single-use rotation), so always persist the new one. If an old (already used) refresh token is sent again, it is treated as possible theft: ALL sessions of that user are logged out and a fresh login is required (401). The response contains only `accessToken`, `refreshToken` and `user` (no organization object).",
  request: { body: { required: true, content: json(refreshSchema) } },
  responses: {
    200: {
      description: "Tokens rotated.",
      content: json(
        successEnvelope(
          "TenantRefreshResponse",
          AuthRefreshDataSchema,
          "Token refreshed successfully"
        )
      ),
    },
    400: validation400,
    401: errorResponse(
      "Refresh token unknown/already used, expired, or the account is deactivated.",
      "Authentication failed: Invalid or expired refresh token.",
      401
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${API}/auth/logout`,
  tags,
  summary: "Log out this device (public)",
  description:
    "Public. Revokes the given refresh token. Always returns 200 even if the token is unknown (idempotent). The access token stays valid until it expires.",
  request: { body: { required: true, content: json(logoutSchema) } },
  responses: {
    200: {
      description: "Logged out.",
      content: json(
        NullDataSuccessSchema("TenantLogoutResponse", "Logged out successfully")
      ),
    },
    400: validation400,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${API}/auth/logout-all`,
  tags,
  summary: "Log out from all devices",
  description:
    "Requires a **tenant** bearer token. Revokes every refresh token of the authenticated user. No request body. No specific permission required.",
  security,
  responses: {
    200: {
      description: "All sessions revoked.",
      content: json(
        NullDataSuccessSchema(
          "TenantLogoutAllResponse",
          "Logged out from all devices successfully"
        )
      ),
    },
    401: TENANT_AUTH_401,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${API}/auth/me`,
  tags,
  summary: "Current user profile and effective permissions",
  description:
    "Requires a **tenant** bearer token. Returns the user with `organizationId` and `orgRoleId` expanded into full objects, plus `permissions`: the resolved permission keys. Pass `storeId` to include the permissions of the user's role at that store (only applied if the user is assigned to that store; an unassigned storeId is silently ignored, not a 403). Use this to drive UI feature gating.",
  security,
  request: {
    query: z.object({
      storeId: z.string().optional().openapi({
        description: "Optional store ID to resolve store-level permissions for.",
        example: "665f1c2e8a4b3c0012ab34ef",
      }),
    }),
  },
  responses: {
    200: {
      description: "Profile resolved.",
      content: json(
        successEnvelope(
          "TenantMeResponse",
          TenantMeSchema,
          "Profile and permissions resolved successfully"
        )
      ),
    },
    401: TENANT_AUTH_401,
    500: server500,
  },
});
