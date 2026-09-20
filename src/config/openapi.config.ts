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

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "SynkSale POS API",
      version: API_DOC_VERSION,
      description: [
        "REST API for the SynkSale multi-tenant POS backend.",
        "",
        "## Authentication: two separate token types",
        "Tenant and platform (Super Admin) authentication are completely separate systems with different JWT secrets. A token from one is rejected by the other with a 401, so check which scheme an endpoint lists:",
        "- **tenantBearerAuth**: tenant users (org admins, staff). Obtained from `POST /auth/login`. Used on `/auth/*` (protected ones), `/users/invite`.",
        "- **platformBearerAuth**: SynkSale Super Admins. Obtained from `POST /platform/auth/login`. Used on `/platform/*`.",
        "Send as `Authorization: Bearer <accessToken>`. Access tokens are short-lived; use the refresh endpoint (refresh tokens rotate on every use, so always store the newest one).",
        "",
        "## Response envelope",
        "Success: `{ success: true, statusCode, message, data }`.",
        "Error: `{ success: false, statusCode, message, requestId, errors[] }` (plus `stack` in development only). `requestId` is also returned in the `X-Request-Id` header; quote it when reporting problems.",
        "",
        "## Permissions (dynamic RBAC)",
        "Some tenant routes require a permission key (for example `user:invite`). A valid token without that permission yields 403. Permissions are resolved per user from their organization role and, when a `storeId` is supplied, their role at that store. Super Admins have the wildcard `*`.",
        "",
        "## Store scoping",
        "On store-scoped routes a `storeId` (in path, body or query) must be a store the user is assigned to, unless the user holds an organization-scoped role. Otherwise 403.",
        "",
        "## Onboarding model",
        "New organizations sign up via `POST /auth/signup` and start as `pending`. Tenant login is blocked (403) until a Super Admin approves them via `/platform/organizations/{id}/approve`.",
      ].join("\n"),
    },
    // Paths already include the /api/<version> prefix (from API_VERSION) except /health, so use a root server.
    servers: [
      {
        url: "/",
        description: `Same host as this document. Versioned API prefix is /api/${env.API_VERSION}`,
      },
    ],
    tags: [
      { name: "Health", description: "Liveness/health endpoints (public)." },
      { name: "Tenant Auth", description: "Signup, login, tokens and profile for organization (tenant) users." },
      { name: "User Invites", description: "Inviting staff to an organization and accepting invitations." },
      { name: "Platform Auth", description: "Super Admin authentication (separate token system)." },
      { name: "Platform Organizations", description: "Super Admin review of organization applications." },
    ],
  });
}
