/**
 * Purpose: Response body schemas (Zod + OpenAPI metadata) used by the API documentation.
 * These describe what controllers actually return (see ApiResponse and the global error handler).
 * SENSITIVE FIELDS (passwordHash, refreshTokens, inviteToken hash, inviteTokenExpiresAt) are
 * intentionally absent: the User model's toObject/toJSON transform strips them.
 */

import "../../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

// ---------- Envelopes ----------

/** Wraps a data schema in the standard ApiResponse success envelope. */
export function successEnvelope<T extends z.ZodTypeAny>(
  name: string,
  data: T,
  exampleMessage: string,
  statusCode = 200
) {
  return z
    .object({
      success: z.literal(true),
      statusCode: z.number().int().openapi({ example: statusCode }),
      message: z.string().openapi({ example: exampleMessage }),
      data,
    })
    .openapi(name);
}

/** Standard envelope for data-less successes (data is null). */
export const NullDataSuccessSchema = (name: string, message: string) =>
  successEnvelope(name, z.null(), message);

/** Shape of every error response produced by the global error handler. */
export const ErrorResponseSchema = z
  .object({
    success: z.literal(false),
    statusCode: z.number().int().openapi({ example: 400 }),
    message: z.string().openapi({
      example: "Request Validation Failed: email: Invalid email format.",
    }),
    requestId: z.string().uuid().openapi({
      description: "Correlation ID (also sent in the X-Request-Id response header).",
      example: "3f1c2b7e-8d54-4c1a-9a6e-2b0f6d1e4a77",
    }),
    errors: z.array(z.any()).openapi({
      description:
        "Detail items. For 400 validation errors these are Zod issues ({ code, path, message, ... }); for 409 conflicts it may contain the duplicate key values; often empty.",
      example: [
        { code: "invalid_string", validation: "email", path: ["email"], message: "Invalid email format." },
      ],
    }),
    stack: z.string().optional().openapi({
      description: "Only present when the server runs in development mode. Never present in production.",
    }),
  })
  .openapi("ErrorResponse");

// ---------- Domain objects ----------

const objectId = (example: string, description?: string) =>
  z.string().openapi({ description, example });

const isoDate = (example: string) => z.string().datetime().openapi({ example });

export const StoreAccessSchema = z
  .object({
    _id: objectId("665f1c2e8a4b3c0012ab3500"),
    id: objectId("665f1c2e8a4b3c0012ab3500"),
    storeId: objectId("665f1c2e8a4b3c0012ab34ef", "Store the user is assigned to."),
    roleId: objectId("665f1c2e8a4b3c0012ab34cd", "Store-scoped role the user holds at that store."),
  })
  .openapi("StoreAccess");

/** User as returned by login/refresh/invite/accept-invite/platform profile (references are bare IDs). */
export const UserSchema = z
  .object({
    _id: objectId("665f1c2e8a4b3c0012ab3401"),
    id: objectId("665f1c2e8a4b3c0012ab3401", "Same value as _id (Mongoose virtual)."),
    organizationId: objectId("665f1c2e8a4b3c0012ab3300", "Owning organization. null for Super Admins.").nullable(),
    email: z.string().email().openapi({ example: "rohan@sharmastore.in" }),
    firstName: z.string().openapi({ example: "Rohan" }),
    lastName: z.string().openapi({ example: "Sharma" }),
    isSuperAdmin: z.boolean().openapi({ example: false }),
    orgRoleId: objectId(
      "665f1c2e8a4b3c0012ab34cd",
      "Organization-wide role (e.g. org_admin). null if the user only has store-level roles."
    ).nullable(),
    storeAccess: z.array(StoreAccessSchema).openapi({
      description: "Per-store role assignments (store-scoped staff).",
    }),
    isActive: z.boolean().openapi({ description: "false until an invite is accepted.", example: true }),
    isDelete: z.boolean().openapi({ description: "Soft-delete flag.", example: false }),
    lastLoginAt: isoDate("2026-05-01T09:30:00.000Z").nullable(),
    inviteStatus: z.enum(["pending", "accepted"]).optional().openapi({ example: "accepted" }),
    createdAt: isoDate("2026-04-20T10:00:00.000Z"),
    updatedAt: isoDate("2026-05-01T09:30:00.000Z"),
  })
  .openapi("User");

export const OrganizationSummarySchema = z
  .object({
    id: objectId("665f1c2e8a4b3c0012ab3300"),
    name: z.string().openapi({ example: "Sharma General Store" }),
    slug: z.string().openapi({ example: "sharma-general-store" }),
  })
  .openapi("OrganizationSummary");

export const ApprovalStatusSchema = z
  .enum(["pending", "approved", "rejected"])
  .openapi("ApprovalStatus", { example: "pending" });

/** Full organization document (Super Admin review endpoints, and embedded in tenant /auth/me). */
export const OrganizationSchema = z
  .object({
    _id: objectId("665f1c2e8a4b3c0012ab3300"),
    id: objectId("665f1c2e8a4b3c0012ab3300"),
    name: z.string().openapi({ example: "Sharma General Store" }),
    slug: z.string().openapi({ example: "sharma-general-store" }),
    contactEmail: z.string().openapi({ example: "contact@sharmastore.in" }),
    contactPhone: z.string().openapi({ example: "+91 98765 43210" }),
    applicantEmail: z.string().optional().openapi({
      description: "Admin email that submitted the application.",
      example: "rohan@sharmastore.in",
    }),
    isActive: z.boolean().openapi({ description: "false = suspended tenant.", example: true }),
    isDelete: z.boolean().openapi({ example: false }),
    approvalStatus: ApprovalStatusSchema,
    approvedBy: objectId("665f1c2e8a4b3c0012ab3001", "Super Admin user ID.").nullable(),
    approvedAt: isoDate("2026-04-21T08:00:00.000Z").nullable(),
    rejectedBy: objectId("665f1c2e8a4b3c0012ab3001", "Super Admin user ID.").nullable(),
    rejectedAt: isoDate("2026-04-21T08:00:00.000Z").nullable(),
    rejectionReason: z.string().nullable().openapi({ example: null as unknown as string }),
    settings: z.object({
      currency: z.string().openapi({ example: "INR" }),
      timezone: z.string().openapi({ example: "UTC" }),
    }),
    createdAt: isoDate("2026-04-20T10:00:00.000Z"),
    updatedAt: isoDate("2026-04-21T08:00:00.000Z"),
  })
  .openapi("Organization");

export const RoleSchema = z
  .object({
    _id: objectId("665f1c2e8a4b3c0012ab34cd"),
    id: objectId("665f1c2e8a4b3c0012ab34cd"),
    organizationId: objectId("665f1c2e8a4b3c0012ab3300").nullable(),
    scope: z.enum(["platform", "organization", "store"]).openapi({ example: "organization" }),
    name: z.string().openapi({ example: "Organization Admin" }),
    slug: z.string().openapi({ example: "org_admin" }),
    isSystemRole: z.boolean().openapi({ example: true }),
    permissions: z.array(z.string()).openapi({
      description: "Permission keys granted by this role.",
      example: ["user:invite", "product:read"],
    }),
    isDelete: z.boolean().openapi({ example: false }),
    createdAt: isoDate("2026-04-20T10:00:00.000Z"),
    updatedAt: isoDate("2026-04-20T10:00:00.000Z"),
  })
  .openapi("Role");

/** /auth/me: user whose organizationId and orgRoleId are POPULATED (full objects), plus permissions. */
export const TenantMeSchema = UserSchema.extend({
  organizationId: OrganizationSchema.nullable().openapi({
    description: "Populated Organization object (not a bare ID) on this endpoint.",
  }),
  orgRoleId: RoleSchema.nullable().openapi({
    description: "Populated Role object (not a bare ID) on this endpoint. null if the user has no org-wide role.",
  }),
  permissions: z.array(z.string()).openapi({
    description:
      "Effective permission keys for the user (org role, plus the store role if ?storeId= is provided and the user is assigned to it). Super Admins get [\"*\"].",
    example: ["user:invite", "product:read", "sale:create"],
  }),
}).openapi("TenantMe");

// ---------- Per-endpoint data payloads ----------

export const TokenPairSchema = z.object({
  accessToken: z.string().openapi({
    description: "Short-lived JWT. Send as `Authorization: Bearer <accessToken>`.",
    example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2NjVm...",
  }),
  refreshToken: z.string().openapi({
    description: "Opaque, single-use refresh token. Replace your stored one with the newest value.",
    example: "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e",
  }),
});

export const SignupDataSchema = z
  .object({
    organization: z.object({
      id: objectId("665f1c2e8a4b3c0012ab3300"),
      name: z.string().openapi({ example: "Sharma General Store" }),
      slug: z.string().openapi({
        description: "Use this as orgSlug when logging in once approved.",
        example: "sharma-general-store",
      }),
      approvalStatus: ApprovalStatusSchema.openapi({ example: "pending" }),
    }),
  })
  .openapi("SignupData");

export const TenantLoginDataSchema = TokenPairSchema.extend({
  user: UserSchema,
  organization: OrganizationSummarySchema,
}).openapi("TenantLoginData");

export const AuthRefreshDataSchema = TokenPairSchema.extend({
  user: UserSchema,
}).openapi("AuthRefreshData");

export const InviteDataSchema = z
  .object({
    user: UserSchema.openapi({
      description: "The created pending user (isActive=false, inviteStatus=pending).",
    }),
    inviteToken: z.string().openapi({
      description:
        "Plaintext invite token. Returned ONLY in this response (only its hash is stored). No email is sent by the backend.",
      example: "b7d1f0c39a8e4d2f6c5b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a39281706",
    }),
    inviteLink: z.string().openapi({
      description: "Frontend URL to hand to the invitee: <FRONTEND_URL>/accept-invite?token=<inviteToken>.",
      example:
        "https://app.synksale.com/accept-invite?token=b7d1f0c39a8e4d2f6c5b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a39281706",
    }),
  })
  .openapi("InviteData");

export const AuthRefreshUserDataSchema = AuthRefreshDataSchema; // alias for readability in docs

export const PlatformLoginDataSchema = TokenPairSchema.extend({
  user: UserSchema,
}).openapi("PlatformAuthData");

export const OrganizationListDataSchema = z
  .object({
    organizations: z.array(OrganizationSchema),
    pagination: z.object({
      page: z.number().int().openapi({ example: 1 }),
      limit: z.number().int().openapi({ example: 20 }),
      total: z.number().int().openapi({ description: "Total matching organizations.", example: 42 }),
      totalPages: z.number().int().openapi({ example: 3 }),
    }),
  })
  .openapi("OrganizationListData");

export const HealthInfraSchema = z
  .object({
    status: z.literal("healthy"),
    timestamp: isoDate("2026-05-01T09:30:00.000Z"),
    uptime: z.number().openapi({ description: "Process uptime in seconds.", example: 1234.56 }),
    environment: z.enum(["development", "production", "test"]).openapi({ example: "development" }),
  })
  .openapi("InfraHealth");

export const HealthApiDataSchema = z
  .object({ timestamp: isoDate("2026-05-01T09:30:00.000Z") })
  .openapi("ApiHealthData");
