import { registry } from "../config/openapi.registry";
import {
  loginSchema,
  refreshSchema,
  logoutSchema,
} from "../validators/platformAuth.validator";
import {
  PlatformLoginDataSchema,
  UserSchema,
  successEnvelope,
  NullDataSuccessSchema,
} from "../validators/responses";
import {
  API,
  errorResponse,
  json,
  server500,
  validation400,
  PLATFORM_AUTH_401,
  PLATFORM_AUTH_403,
} from "./common";

const security = [{ platformBearerAuth: [] }];
const tags = ["Platform Auth"];
const base = `${API}/platform/auth`;

registry.registerPath({
  method: "post",
  path: `${base}/login`,
  tags,
  summary: "Super Admin login (public)",
  description:
    "Public. Returns a PLATFORM access token (use with `platformBearerAuth`; valid only on `/platform/*` routes) and a refresh token. Unknown email, wrong password and deactivated account all return the same generic 401.",
  request: { body: { required: true, content: json(loginSchema) } },
  responses: {
    200: {
      description: "Logged in.",
      content: json(
        successEnvelope(
          "PlatformLoginResponse",
          PlatformLoginDataSchema,
          "Logged in successfully"
        )
      ),
    },
    400: validation400,
    401: errorResponse("Invalid credentials.", "Invalid credentials", 401),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${base}/refresh`,
  tags,
  summary: "Rotate Super Admin tokens (public)",
  description:
    "Public. Exchanges a platform refresh token for a new platform access token and a new refresh token; the old refresh token is invalidated (rotation).",
  request: { body: { required: true, content: json(refreshSchema) } },
  responses: {
    200: {
      description: "Tokens rotated.",
      content: json(
        successEnvelope(
          "PlatformRefreshResponse",
          PlatformLoginDataSchema,
          "Token refreshed successfully"
        )
      ),
    },
    400: validation400,
    401: errorResponse(
      "Refresh token unknown/already used, expired, or account deactivated.",
      "Authentication failed: Invalid or expired refresh token.",
      401
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${base}/logout`,
  tags,
  summary: "Log out this device (public)",
  description:
    "Public. Revokes the given platform refresh token. Always 200, even if the token is unknown.",
  request: { body: { required: true, content: json(logoutSchema) } },
  responses: {
    200: {
      description: "Logged out.",
      content: json(
        NullDataSuccessSchema("PlatformLogoutResponse", "Logged out successfully")
      ),
    },
    400: validation400,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${base}/logout-all`,
  tags,
  summary: "Log out Super Admin from all devices",
  description:
    "Requires a **platform** bearer token. Revokes all refresh tokens of the Super Admin. No request body.",
  security,
  responses: {
    200: {
      description: "All sessions revoked.",
      content: json(
        NullDataSuccessSchema(
          "PlatformLogoutAllResponse",
          "Logged out from all devices successfully"
        )
      ),
    },
    401: PLATFORM_AUTH_401,
    403: PLATFORM_AUTH_403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/me`,
  tags,
  summary: "Current Super Admin profile",
  description:
    "Requires a **platform** bearer token. Returns the authenticated Super Admin (organizationId and orgRoleId are null).",
  security,
  responses: {
    200: {
      description: "Profile fetched.",
      content: json(
        successEnvelope("PlatformMeResponse", UserSchema, "Profile fetched successfully")
      ),
    },
    401: PLATFORM_AUTH_401,
    403: PLATFORM_AUTH_403,
    500: server500,
  },
});
