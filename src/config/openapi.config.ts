/**
 * Purpose: Builds the final OpenAPI document from the shared registry.
 * Route documentation lives in src/docs/*.openapi.ts and is loaded through src/docs/index.ts.
 * Zod schemas in src/validators/ are the source of truth; re-running generation picks up changes.
 */
import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./openapi.registry";
import { env } from "./env.config";
import "../docs"; // side effect: registers every documented route on the registry

// Keep in sync with package.json "version" (hardcoded to avoid resolveJsonModule/path issues in dist).
const API_DOC_VERSION = "1.0.0";

export { registry } from "./openapi.registry";

// Why two token types must be visible to the frontend dev: tenant and platform auth use
// different JWT secrets, so mixing them up produces confusing 401s.
const API_DESCRIPTION = [
  "# Welcome to the SynkSale POS API",
  "",
  "This API powers **SynkSale**, a point-of-sale (POS) system used by many businesses (called *organizations*). Each organization has its own staff, stores and data, kept fully separate from the others.",
  "",
  "Use this page to see every endpoint, try it out, and check what to send and what you get back.",
  "",
  "---",
  "",
  "## Quick start",
  "1. **Sign up** an organization with `POST /api/v1/auth/signup`. It starts as *pending*.",
  "2. A SynkSale **super admin approves** it. Until then, login is blocked (403).",
  "3. **Log in** with `POST /api/v1/auth/login`. You get an `accessToken` and a `refreshToken`.",
  "4. Click **Authorize** (top right) and paste the `accessToken`.",
  "5. Call any protected endpoint.",
  "",
  "## Two kinds of users",
  "",
  "| Who | Log in at | Token scheme | Used for |",
  "| --- | --- | --- | --- |",
  "| Organization users (owners, staff) | `POST /api/v1/auth/login` | `tenantBearerAuth` | `/auth/*`, `/users/*`, `/stores/*` |",
  "| SynkSale super admins | `POST /api/v1/platform/auth/login` | `platformBearerAuth` | `/platform/*` |",
  "",
  "These are separate systems. A token from one is rejected by the other with a **401**.",
  "",
  "## How to sign in",
  "Send the access token on every protected request:",
  "",
  "`Authorization: Bearer <accessToken>`",
  "",
  "| Token | Organization users | Super admins |",
  "| --- | --- | --- |",
  "| `accessToken` | 15 minutes | 10 minutes |",
  "| `refreshToken` | 7 days | 3 days |",
  "",
  "These are the defaults. Your server may be set differently.",
  "",
  "### When the access token expires",
  "- Call `POST /api/v1/auth/refresh` with your `refreshToken` (super admins: `POST /api/v1/platform/auth/refresh`).",
  "- You get a **new** `accessToken` and a **new** `refreshToken`.",
  "- Each refresh token works **only once**. Always save the new one and throw the old one away.",
  "- If an old, already-used refresh token is sent again, the API treats it as possible theft and **logs out every session** of that organization user. They must log in again. (This check is active for organization users.)",
  "- If refresh fails with 401, send the user back to the login screen.",
  "",
  "### Logging out",
  "- `POST /api/v1/auth/logout` ends this device's session.",
  "- `POST /api/v1/auth/logout-all` ends all sessions on all devices.",
  "",
  "## What responses look like",
  "",
  "Every response uses the same shape.",
  "",
  "**Success**",
  "```json",
  '{ "success": true, "statusCode": 200, "message": "Login successful", "data": { } }',
  "```",
  "",
  "**Error**",
  "```json",
  '{ "success": false, "statusCode": 400, "message": "Validation failed", "requestId": "...", "errors": [ ] }',
  "```",
  "",
  "`requestId` is also sent in the `X-Request-Id` header. Share it when you report a problem.",
  "",
  "### Common status codes",
  "",
  "| Code | Meaning |",
  "| --- | --- |",
  "| 200 / 201 | It worked |",
  "| 400 | Something you sent is missing or invalid. See `errors` |",
  "| 401 | Not signed in, token expired, or wrong token type |",
  "| 403 | Signed in, but not allowed (missing permission, wrong store, or organization not approved) |",
  "| 404 | Not found |",
  "| 409 | Conflict, for example the email is already used |",
  "| 500 | Server problem |",
  "",
  "## Permissions and stores",
  "- Some endpoints need a **permission** (for example `user:invite`). It is shown in the endpoint's description. Without it you get a **403**, even with a valid token.",
  "- On store-based endpoints, the `storeId` must be a store the user is assigned to (unless they hold an organization-wide role). Otherwise you get a **403**. A malformed `storeId` gives **400**, and a store that does not exist in your organization gives **404**.",
  "- Stores are managed under `/api/v1/stores/*`. A **deactivated** store is rejected (403) on store-scoped endpoints such as inviting staff, but stays reachable under `/stores/*` so it can be reactivated (activate/deactivate need an organization-wide role).",
  "- Super admins have full access.",
].join("\n");

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "SynkSale POS API",
      version: API_DOC_VERSION,
      description: API_DESCRIPTION,
    },
    // Paths already include the /api/<version> prefix (from API_VERSION) except /health, so use a root server.
    servers: [
      {
        url: "/",
        description: `Same host as this document. Versioned API prefix is /api/${env.API_VERSION}`,
      },
    ],
    // Order here is the order shown in Swagger UI (UI sorting is not enabled in app.ts).
    // Every operation's tag must match one of these names exactly.
    tags: [
      { name: "Health", description: "Check that the server is up and running." },
      { name: "Platform Super Admin Auth", description: "Sign-in and tokens for SynkSale super admins." },
      { name: "Organization Auth", description: "Sign up, log in, tokens and profile for organization users." },
      { name: "Platform Organization Review", description: "Super admins review, approve or reject new organizations." },
      { name: "Stores", description: "Create and manage an organization's stores (locations)." },
      { name: "User Invites", description: "Invite staff to an organization and accept invitations." },
    ],
  });
}
