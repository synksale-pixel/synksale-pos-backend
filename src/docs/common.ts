/**
 * Purpose: Shared helpers for the *.openapi.ts route documentation files.
 */
import { env } from "../config/env.config";
import { ErrorResponseSchema } from "../validators/responses";

/** Versioned API prefix, e.g. /api/v1 (driven by API_VERSION). */
export const API = `/api/${env.API_VERSION}`;

/** Builds a JSON error response entry that references the shared ErrorResponse schema. */
export function errorResponse(
  description: string,
  exampleMessage?: string,
  statusCode?: number
) {
  return {
    description,
    content: {
      "application/json": {
        schema: ErrorResponseSchema,
        ...(exampleMessage
          ? {
              example: {
                success: false,
                statusCode: statusCode ?? 400,
                message: exampleMessage,
                requestId: "3f1c2b7e-8d54-4c1a-9a6e-2b0f6d1e4a77",
                errors: [],
              },
            }
          : {}),
      },
    },
  };
}

export const json = <T>(schema: T) => ({ "application/json": { schema } });

export const validation400 = errorResponse(
  "Request validation failed (Zod). `errors` contains the Zod issues.",
  "Request Validation Failed: email: Invalid email format.",
  400
);
export const server500 = errorResponse(
  "Unexpected server error.",
  "An unexpected system error occurred on our server.",
  500
);

export const TENANT_AUTH_401 = errorResponse(
  "Missing/invalid/expired TENANT bearer token, user missing or deactivated, or the organization is not approved / is suspended (re-checked on every request). A platform token is rejected here too.",
  "Authentication failed: Access token is missing or invalid. Use 'Bearer <token>' format.",
  401
);
export const PLATFORM_AUTH_401 = errorResponse(
  "Missing/invalid/expired PLATFORM bearer token, or the Super Admin account is missing/deactivated. A tenant token is rejected here too.",
  "Authentication failed: Platform access token is missing or invalid. Use 'Bearer <token>' format.",
  401
);
export const PLATFORM_AUTH_403 = errorResponse(
  "Token is valid but the user is not a Super Admin.",
  "Access Denied: The authenticated user is not authorized to access platform routes.",
  403
);
