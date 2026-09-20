/**
 * Purpose: Central OpenAPI registry + zod-to-openapi bootstrap.
 *
 * WHY THIS IS A SEPARATE FILE FROM openapi.config.ts:
 * `extendZodWithOpenApi(z)` patches Zod's prototype, and it MUST run before any
 * validator calls `.openapi()`. Validators therefore import this file first
 * (`import "../config/openapi.registry";`). Doing the patch in openapi.config.ts
 * instead would create an import cycle (openapi.config -> docs -> validators ->
 * openapi.config), because openapi.config also pulls in the route docs.
 * This file has no dependency on validators or docs, so it is always safe to load first.
 * Patching is idempotent, and zod's prototype is shared, so a plain `import { z } from "zod"`
 * in validator files works after this side-effect import.
 */
import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/** The single shared registry every route-doc file registers onto. */
export const registry = new OpenAPIRegistry();

/**
 * Two DIFFERENT bearer schemes on purpose. Tenant and platform access tokens are signed with
 * different secrets and are not interchangeable: sending a tenant token to a /platform route
 * (or vice versa) yields a 401. Keeping them as separate named schemes makes it visible
 * to the frontend dev which token each endpoint needs.
 */
export const tenantBearerAuth = registry.registerComponent(
  "securitySchemes",
  "tenantBearerAuth",
  {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "TENANT access token (from POST /auth/login, /auth/refresh or /users/accept-invite). Signed with the tenant secret. Not valid on /platform/* routes.",
  }
);

export const platformBearerAuth = registry.registerComponent(
  "securitySchemes",
  "platformBearerAuth",
  {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "PLATFORM (Super Admin) access token (from POST /platform/auth/login or /platform/auth/refresh). Signed with a separate platform secret. Not valid on tenant routes.",
  }
);

export { z };
