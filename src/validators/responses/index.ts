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
    code: z.string().optional().openapi({
      description:
        "Stable machine-readable error code. OPTIONAL: present only when the server set one, so switch on it when you need to tell errors with the same status apart. Values: `VALIDATION_FAILED` (Zod/Mongoose validation 400), `DUPLICATE` (unique-index 409), plus domain codes such as `TAX_RATE_NAME_TAKEN`, `TAX_RATE_IS_DEFAULT`, `TAX_RATE_INACTIVE`, `TAX_RATE_NOT_FOUND`, `TAX_RATE_IN_USE`, `STORE_COUNTRY_CURRENCY_MISMATCH`, `CURRENCY_STORE_MISMATCH`, `CURRENCY_LOCKED`, `ORGANIZATION_NOT_FOUND`, and the catalog codes `CATEGORY_NOT_FOUND`, `CATEGORY_NAME_TAKEN`, `CATEGORY_IN_USE`, `CATEGORY_HAS_CHILDREN`, `CATEGORY_DEPTH_EXCEEDED`, `CATEGORY_CYCLE`, `PRODUCT_NOT_FOUND`, `VARIANT_NOT_FOUND`, `SKU_TAKEN`, `BARCODE_TAKEN`, `TAX_RATE_REQUIRED`, `PRODUCT_IS_VARIANT_ITEM`, `PRODUCT_NOT_VARIANT_ITEM`, `ATTRIBUTE_OPTION_IN_USE`, `ATTRIBUTES_LOCKED`, `VARIANT_COMBINATION_TAKEN`, `LAST_ACTIVE_VARIANT`, `TOO_MANY_DECIMALS`, `INVALID_AMOUNT`, `AMOUNT_OUT_OF_RANGE`, `PRODUCT_IN_USE`, `VARIANT_IN_USE`, and the stock codes `STORE_NOT_FOUND`, `STORE_INACTIVE`, `VARIANT_NOT_STOCKED`, `INSUFFICIENT_STOCK`, `UNIT_LOCKED`, `STOCK_ON_HAND`, `ADJUSTMENT_NOT_FOUND`, `TRANSFER_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS` (`PRODUCT_IN_USE`, `VARIANT_IN_USE` and the stock codes arrive with stock tracking). Most older errors (401/403, plain 404/409) carry no code.",
      example: "TAX_RATE_NAME_TAKEN",
    }),
    requestId: z.string().uuid().openapi({
      description: "Correlation ID (also sent in the X-Request-Id response header).",
      example: "3f1c2b7e-8d54-4c1a-9a6e-2b0f6d1e4a77",
    }),
    errors: z.array(z.any()).openapi({
      description:
        "Detail items; often empty. Coded domain errors use `{ field?, code?, message?, meta? }` where `meta` carries values for the UI message (e.g. `{ countryCode, organizationCurrency }`). For 400 validation errors these are Zod issues ({ code, path, message, ... }); for E11000 409 conflicts it may contain the duplicate key values.",
      example: [
        { code: "invalid_string", validation: "email", path: ["email"], message: "Invalid email format." },
      ],
    }),
    stack: z.string().optional().openapi({
      description: "Only present when the server runs in development mode. Never present in production.",
    }),
  })
  .openapi("ErrorResponse");

/** The pagination block returned by every paginated list endpoint. */
export const PaginationSchema = z
  .object({
    page: z.number().int().openapi({ example: 1 }),
    limit: z.number().int().openapi({ example: 20 }),
    total: z.number().int().openapi({ description: "Total matching records.", example: 42 }),
    totalPages: z.number().int().openapi({ example: 3 }),
  })
  .openapi("Pagination");

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
    legalName: z.string().nullable().optional().openapi({
      description: "Registered legal name printed on documents. null/absent when not set.",
      example: "Al Noor Trading W.L.L.",
    }),
    taxRegistrationNumber: z.string().nullable().optional().openapi({
      description: "VAT Tax Registration Number (TRN). null/absent when the business is not VAT-registered.",
      example: "220000123400002",
    }),
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
      currency: z.string().openapi({
        description: "ISO 4217 code: BHD (default), KWD, OMR, AED, QAR, SAR or INR.",
        example: "BHD",
      }),
      timezone: z.string().openapi({ example: "Asia/Bahrain" }),
      inventory: z
        .object({
          allowNegativeStock: z.boolean().openapi({
            description: "Whether sales and stock adjustments may take stock below zero. Stock transfers always need enough stock at the source store, whatever this setting says.",
            example: false,
          }),
        })
        .optional()
        .openapi({ description: "May be absent on organizations created before this setting existed." }),
      sales: z
        .object({
          pricesIncludeTax: z.boolean().openapi({
            description: "Whether selling prices are entered VAT-inclusive.",
            example: true,
          }),
        })
        .optional()
        .openapi({ description: "May be absent on organizations created before this setting existed (treated as true)." }),
    }),
    createdAt: isoDate("2026-04-20T10:00:00.000Z"),
    updatedAt: isoDate("2026-04-21T08:00:00.000Z"),
  })
  .openapi("Organization");

/** Tenant-side organization profile (GET/PATCH /organization), shaped by toProfile(). */
export const OrganizationProfileSchema = z
  .object({
    id: objectId("665f1c2e8a4b3c0012ab3300"),
    name: z.string().openapi({ example: "Al Noor Trading" }),
    slug: z.string().openapi({ example: "al-noor-trading" }),
    legalName: z.string().nullable().openapi({ example: "Al Noor Trading W.L.L." }),
    taxRegistrationNumber: z.string().nullable().openapi({ example: "220000123400002" }),
    contactEmail: z.string().openapi({ example: "contact@alnoor.bh" }),
    contactPhone: z.string().openapi({ example: "+973 1700 0000" }),
    settings: z.object({
      currency: z.string().openapi({ example: "BHD" }),
      timezone: z.string().openapi({ example: "Asia/Bahrain" }),
      inventory: z.object({
        allowNegativeStock: z.boolean().openapi({ example: false }),
      }),
      sales: z.object({
        pricesIncludeTax: z.boolean().openapi({
          description: "Selling prices are VAT-inclusive (default true). Cost prices are always VAT-exclusive.",
          example: true,
        }),
      }),
    }),
    currency: z
      .object({
        code: z.string().openapi({ example: "BHD" }),
        name: z.string().openapi({ example: "Bahraini Dinar" }),
        decimals: z.number().int().openapi({
          description: "Minor-unit digits for formatting money (BHD/KWD/OMR 3, others 2).",
          example: 3,
        }),
      })
      .openapi({ description: "Details of settings.currency, for formatting money." }),
    country: z
      .object({
        code: z.string().openapi({ example: "BH" }),
        name: z.string().openapi({ example: "Bahrain" }),
      })
      .nullable()
      .openapi({ description: "The country that uses the organization's currency." }),
  })
  .openapi("OrganizationProfile");

export const OrganizationProfileDataSchema = z
  .object({ organization: OrganizationProfileSchema })
  .openapi("OrganizationProfileData");

export const TaxComponentSchema = z
  .object({
    name: z.string().openapi({ example: "VAT" }),
    rate: z.number().openapi({ description: "Percentage, 0-100, max 4 decimals.", example: 10 }),
  })
  .openapi("TaxComponent");

export const TaxRateSchema = z
  .object({
    _id: objectId("665f1c2e8a4b3c0012ab3600"),
    id: objectId("665f1c2e8a4b3c0012ab3600"),
    organizationId: objectId("665f1c2e8a4b3c0012ab3300"),
    name: z.string().openapi({ description: "Unique per organization, case-insensitive.", example: "VAT 10%" }),
    components: z.array(TaxComponentSchema),
    rate: z.number().openapi({ description: "Exact sum of the component rates (percent).", example: 10 }),
    isDefault: z.boolean().openapi({
      description: "The rate pre-selected for new products. At most one per organization.",
      example: true,
    }),
    isActive: z.boolean().openapi({ example: true }),
    isDelete: z.boolean().openapi({ description: "Soft-delete flag; deleted rates are never returned.", example: false }),
    createdAt: isoDate("2026-05-01T09:30:00.000Z"),
    updatedAt: isoDate("2026-05-01T09:30:00.000Z"),
  })
  .openapi("TaxRate");

export const TaxRateDataSchema = z.object({ taxRate: TaxRateSchema }).openapi("TaxRateData");

export const TaxRateListDataSchema = z
  .object({ taxRates: z.array(TaxRateSchema) })
  .openapi("TaxRateListData");

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
    delivery: z.enum(["response", "email_pending"]).openapi({
      description:
        "How the invitee receives the link. Outside production this is `response` and the two fields below are present. In production it is `email_pending`, `inviteToken`/`inviteLink` are OMITTED (a plaintext token must not travel through response logs), and no email service is wired up yet — so production invites are not deliverable.",
      example: "response",
    }),
    inviteToken: z.string().optional().openapi({
      description:
        "Plaintext invite token. Only its hash is stored, and it is returned ONLY outside production.",
      example: "b7d1f0c39a8e4d2f6c5b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a39281706",
    }),
    inviteLink: z.string().optional().openapi({
      description:
        "Frontend URL to hand to the invitee: <FRONTEND_URL>/accept-invite?token=<inviteToken>. Returned ONLY outside production.",
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
    pagination: PaginationSchema,
  })
  .openapi("OrganizationListData");

export const StoreSchema = z
  .object({
    _id: objectId("665f1c2e8a4b3c0012ab34ef"),
    id: objectId("665f1c2e8a4b3c0012ab34ef"),
    organizationId: objectId("665f1c2e8a4b3c0012ab3300"),
    name: z.string().openapi({ example: "Sharma Store - Indiranagar" }),
    code: z.string().openapi({ description: "Unique within the organization, uppercase.", example: "MNM-001" }),
    address: z.object({
      line1: z.string().openapi({ example: "12, 100 Feet Road" }),
      line2: z.string().optional().openapi({ example: "Indiranagar" }),
      city: z.string().openapi({ example: "Bengaluru" }),
      state: z.string().openapi({ example: "Karnataka" }),
      country: z.string().openapi({ example: "India" }),
      postalCode: z.string().openapi({ example: "560038" }),
    }),
    countryCode: z.string().optional().openapi({
      description:
        "ISO 3166-1 alpha-2 country (BH, KW, OM, AE, QA, SA, IN). Absent only on stores created before this field existed.",
      example: "IN",
    }),
    timezone: z.string().openapi({ example: "Asia/Kolkata" }),
    isActive: z.boolean().openapi({ example: true }),
    isDelete: z.boolean().openapi({ example: false }),
    createdAt: isoDate("2026-05-01T09:30:00.000Z"),
    updatedAt: isoDate("2026-05-01T09:30:00.000Z"),
  })
  .openapi("Store");

export const StoreDataSchema = z.object({ store: StoreSchema }).openapi("StoreData");

export const StoreListDataSchema = z
  .object({
    stores: z.array(StoreSchema),
    pagination: PaginationSchema,
  })
  .openapi("StoreListData");

/** A roster user: orgRoleId is POPULATED (full Role object) on the staff endpoints. */
export const StaffUserSchema = UserSchema.extend({
  orgRoleId: RoleSchema.nullable().openapi({
    description:
      "Populated Role object (not a bare ID) on the staff endpoints. null if the user holds no organization-wide role.",
  }),
}).openapi("StaffUser");

export const UserDataSchema = z.object({ user: StaffUserSchema }).openapi("UserData");

export const UserListDataSchema = z
  .object({
    users: z.array(StaffUserSchema),
    pagination: PaginationSchema,
  })
  .openapi("UserListData");

/** A role as returned by the role endpoints, with how many users currently hold it. */
export const RoleWithUsageSchema = RoleSchema.extend({
  usageCount: z.number().int().openapi({
    description:
      "How many users hold this role, organization-wide or at any store. A role with usageCount > 0 cannot be deleted (409).",
    example: 3,
  }),
}).openapi("RoleWithUsage");

export const RoleDataSchema = z
  .object({ role: RoleWithUsageSchema })
  .openapi("RoleData");

export const RoleListDataSchema = z
  .object({ roles: z.array(RoleWithUsageSchema) })
  .openapi("RoleListData");

export const PermissionCatalogDataSchema = z
  .object({
    permissions: z.array(
      z.object({
        key: z.string().openapi({ example: "sale:create" }),
        label: z.string().openapi({ example: "Create Sales" }),
        category: z.string().openapi({ example: "Sales" }),
        minScope: z.enum(["platform", "organization", "store"]).openapi({
          description:
            "The lowest scope at which this permission is meaningful. A role may only hold permissions at or below its own scope — this is ENFORCED (400) when creating or editing a role, not just advisory: e.g. a store-scoped role cannot hold a permission whose minScope is `organization`.",
          example: "store",
        }),
      })
    ),
  })
  .openapi("PermissionCatalogData");

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

// ---------- Catalog (Phase 1) ----------

export const CategorySchema = z
  .object({
    _id: objectId("665f1c2e8a4b3c0012ab3700"),
    id: objectId("665f1c2e8a4b3c0012ab3700"),
    organizationId: objectId("665f1c2e8a4b3c0012ab3300"),
    name: z.string().openapi({ example: "Beverages" }),
    sortOrder: z.number().int().openapi({ description: "Order among siblings, ascending; ties sort by name.", example: 10 }),
    parentId: objectId("665f1c2e8a4b3c0012ab3700")
      .nullable()
      .openapi({ description: "The parent category; null for a top-level category.", example: null as unknown as string }),
    depth: z.number().int().openapi({ description: "0 for a top-level category, 1 for a subcategory.", example: 0 }),
    productCount: z.number().int().openapi({
      description: "Non-deleted products directly in this category (not counting its subcategories).",
      example: 24,
    }),
    totalProductCount: z.number().int().openapi({
      description: "Non-deleted products in this category and all its subcategories.",
      example: 31,
    }),
    createdAt: isoDate("2026-10-13T09:00:00.000Z"),
    updatedAt: isoDate("2026-10-13T09:00:00.000Z"),
  })
  .openapi("Category");

export const CategoryDataSchema = z.object({ category: CategorySchema }).openapi("CategoryData");

export const CategoryListDataSchema = z
  .object({ categories: z.array(CategorySchema) })
  .openapi("CategoryListData");

const money = (example: string | null, description?: string) =>
  z.string().openapi({
    description: description ?? "Decimal string at the organization's currency decimals.",
    example: example as string,
  });

export const ProductBarcodesSchema = z
  .object({
    upc: z.string().nullable().openapi({ example: null as unknown as string }),
    ean: z.string().nullable().openapi({ example: "6291041500213" }),
    isbn: z.string().nullable().openapi({ example: null as unknown as string }),
    mpn: z.string().nullable().openapi({ example: null as unknown as string }),
  })
  .openapi("ProductBarcodes");

export const ProductVariantSchema = z
  .object({
    id: objectId("665f1c2e8a4b3c0012ab3801"),
    attributeValues: z.record(z.string()).openapi({
      description: "Empty object on the default variant of a single item.",
      example: { Size: "M", Colour: "Red" },
    }),
    name: z.string().openapi({
      description: "Display name: the product name plus attribute values (e.g. 'Crew-neck T-shirt - M / Red').",
      example: "Crew-neck T-shirt - M / Red",
    }),
    sku: z.string().nullable().openapi({ example: "TSHIRT-RED-M" }),
    barcodes: ProductBarcodesSchema,
    sellingPrice: money("4.500", "VAT-inclusive when the organization's pricesIncludeTax is true."),
    costPrice: money(
      "2.750",
      "VAT-exclusive. Once stock tracking ships, null for callers without `inventory:read` or a product write permission (e.g. cashiers)."
    ).nullable(),
    reorderPoint: z.number().nullable().openapi({ example: 10 }),
    // Optional only until the stock ledger ships (Phase 2 implementation); then always present.
    stockOnHand: z.number().nullable().optional().openapi({
      description:
        "Quantity on hand across all stores of the organization. null when the product does not track inventory. Per-store figures: GET /products/{productId}/stock. Returned once stock tracking ships.",
      example: 42,
    }),
    isDefault: z.boolean().openapi({
      description: "true only for the single hidden variant of a single item.",
      example: false,
    }),
    isActive: z.boolean().openapi({ example: true }),
  })
  .openapi("ProductVariant");

const productCore = {
  _id: objectId("665f1c2e8a4b3c0012ab3800"),
  id: objectId("665f1c2e8a4b3c0012ab3800"),
  name: z.string().openapi({ example: "Crew-neck T-shirt" }),
  type: z.enum(["goods", "service"]).openapi({ example: "goods" }),
  itemType: z.enum(["single", "variant"]).openapi({ example: "variant" }),
  category: z
    .object({
      id: objectId("665f1c2e8a4b3c0012ab3700"),
      name: z.string().openapi({ example: "T-shirts" }),
      path: z.string().openapi({
        description: "Category names from the top level down, joined by ' › '. Just the name for a top-level category. Use it where names may repeat under different parents.",
        example: "Apparel › T-shirts",
      }),
    })
    .nullable(),
  unit: z.string().openapi({ example: "pcs" }),
  imageUrl: z.string().nullable().openapi({ example: "https://cdn.example.com/tshirt.jpg" }),
  taxPreference: z.enum(["standard", "zero_rated", "exempt", "out_of_scope"]).openapi({ example: "standard" }),
  isActive: z.boolean().openapi({ example: true }),
  priceRange: z
    .object({ min: money("4.500"), max: money("5.000") })
    .nullable()
    .openapi({ description: "Lowest and highest selling price across active variants; null when none is active." }),
};

/** List rows: enough for a product grid; fetch the product for variants and details. */
export const ProductSummarySchema = z
  .object({
    ...productCore,
    sku: z.string().nullable().openapi({ description: "Single items only (null for variant items).", example: null as unknown as string }),
    variantCount: z.number().int().openapi({ description: "Active variants.", example: 6 }),
    // Optional only until the stock ledger ships (Phase 2 implementation); then always present.
    stockOnHand: z.number().nullable().optional().openapi({
      description: "Quantity on hand across all stores and active variants. null when the product does not track inventory. Returned once stock tracking ships.",
      example: 42,
    }),
    updatedAt: isoDate("2026-10-13T09:00:00.000Z"),
  })
  .openapi("ProductSummary");

export const ProductSchema = z
  .object({
    ...productCore,
    organizationId: objectId("665f1c2e8a4b3c0012ab3300"),
    brand: z.string().nullable().openapi({ example: "Al Noor" }),
    manufacturer: z.string().nullable().openapi({ example: "Al Noor Garments" }),
    taxRate: z
      .object({
        id: objectId("665f1c2e8a4b3c0012ab3600"),
        name: z.string().openapi({ example: "VAT 10%" }),
        rate: z.number().openapi({ example: 10 }),
      })
      .nullable()
      .openapi({ description: "The rate applied (null unless taxPreference is standard)." }),
    dimensions: z
      .object({
        length: z.number(),
        width: z.number(),
        height: z.number(),
        unit: z.enum(["cm", "in"]),
      })
      .nullable(),
    weight: z.object({ value: z.number(), unit: z.enum(["kg", "lb"]) }).nullable(),
    reportingTags: z.array(z.string()).openapi({ example: [] }),
    sales: z.object({ description: z.string().nullable() }),
    purchase: z.object({
      description: z.string().nullable(),
      preferredVendorName: z.string().nullable().openapi({ example: "Gulf Textiles W.L.L." }),
    }),
    inventory: z.object({
      trackInventory: z.boolean().openapi({ example: true }),
      returnable: z.boolean().openapi({ example: true }),
      valuationMethod: z.literal("weighted_average"),
    }),
    attributes: z
      .array(z.object({ name: z.string(), options: z.array(z.string()) }))
      .openapi({ description: "Empty for single items.", example: [{ name: "Size", options: ["S", "M", "L"] }] }),
    variants: z.array(ProductVariantSchema).openapi({
      description:
        "Always at least one. A single item has exactly one variant with isDefault: true; use its id wherever a variantId is needed (stock, purchase and sale lines).",
    }),
    createdAt: isoDate("2026-10-13T09:00:00.000Z"),
    updatedAt: isoDate("2026-10-13T09:00:00.000Z"),
  })
  .openapi("Product");

export const ProductDataSchema = z.object({ product: ProductSchema }).openapi("ProductData");

export const ProductListDataSchema = z
  .object({
    products: z.array(ProductSummarySchema),
    pagination: PaginationSchema,
  })
  .openapi("ProductListData");

export const ProductLookupDataSchema = z
  .object({
    product: ProductSchema,
    variantId: objectId("665f1c2e8a4b3c0012ab3801", "The variant whose SKU or barcode matched."),
    matchedOn: z.enum(["sku", "upc", "ean", "isbn"]).openapi({ example: "ean" }),
  })
  .openapi("ProductLookupData");

// ---------- Stock (Phase 2) ----------

const quantity = (example: number, description?: string) => z.number().openapi({ description, example });

const StockStoreRefSchema = z
  .object({
    id: objectId("665f1c2e8a4b3c0012ab3400"),
    name: z.string().openapi({ example: "Seef Mall" }),
    code: z.string().openapi({ example: "SEEF-01" }),
  })
  .openapi("StockStoreRef");

const StockVariantRefSchema = z
  .object({
    id: objectId("665f1c2e8a4b3c0012ab3801"),
    name: z.string().openapi({ description: "Product name plus attribute values.", example: "Crew-neck T-shirt - M / Red" }),
    sku: z.string().nullable().openapi({ example: "TSHIRT-RED-M" }),
  })
  .openapi("StockVariantRef");

const StockProductRefSchema = z
  .object({
    id: objectId("665f1c2e8a4b3c0012ab3800"),
    name: z.string().openapi({ example: "Crew-neck T-shirt" }),
    unit: z.string().openapi({ example: "pcs" }),
  })
  .openapi("StockProductRef");

const StockUserRefSchema = z
  .object({
    id: objectId("665f1c2e8a4b3c0012ab3500"),
    name: z.string().openapi({ example: "Fatima Al Khalifa" }),
  })
  .nullable()
  .openapi("StockUserRef", { description: "Who made the change; null for system-generated movements." });

// Response enums that later phases will grow are plain strings, so generated client types and
// exhaustive switches do not break when a value is added.
const REASON_LIST =
  "`damaged`, `expired`, `theft_loss`, `found`, `count_correction`, `opening_balance` or `other`";

const COST_HIDDEN = "null when the caller lacks `inventory:read`.";

/** One variant's stock in one store. */
export const StockLevelSchema = z
  .object({
    variant: StockVariantRefSchema.extend({ isActive: z.boolean().openapi({ example: true }) }),
    product: StockProductRefSchema.extend({
      isActive: z.boolean().openapi({ example: true }),
      category: z
        .object({
          id: objectId("665f1c2e8a4b3c0012ab3700"),
          name: z.string().openapi({ example: "T-shirts" }),
          path: z.string().openapi({ example: "Apparel › T-shirts" }),
        })
        .nullable(),
    }),
    quantity: quantity(18, "On hand in this store. Negative only when the organization allows negative stock."),
    reorderPoint: z.number().nullable().openapi({ example: 10 }),
    isLow: z.boolean().openapi({ description: "true when a reorder point is set and quantity is at or below it.", example: false }),
    averageCost: money(
      "1.600",
      `Weighted average cost per unit in this store, VAT-exclusive. null until the variant has received stock here, and ${COST_HIDDEN}`
    ).nullable(),
    stockValue: money("28.800", `quantity × averageCost (0 when quantity is 0 or negative); ${COST_HIDDEN}`).nullable(),
    lastMovementAt: isoDate("2026-10-17T08:15:00.000Z").nullable().openapi({
      description: "null when the variant has never had stock in this store (it is still listed, with quantity 0).",
    }),
  })
  .openapi("StockLevel");

export const StockLevelListDataSchema = z
  .object({
    store: StockStoreRefSchema,
    items: z.array(StockLevelSchema),
    pagination: PaginationSchema,
  })
  .openapi("StockLevelListData");

export const ProductStockDataSchema = z
  .object({
    product: StockProductRefSchema.extend({
      trackInventory: z.boolean().openapi({ example: true }),
    }),
    variants: z.array(
      z.object({
        variant: StockVariantRefSchema.extend({ isActive: z.boolean().openapi({ example: true }) }),
        totalQuantity: quantity(42, "Sum over the stores listed below."),
        stores: z
          .array(
            z.object({
              store: StockStoreRefSchema,
              quantity: quantity(18),
              averageCost: money("1.600", `null until stock is received here, and ${COST_HIDDEN}`).nullable(),
              stockValue: money("28.800", COST_HIDDEN).nullable(),
            })
          )
          .openapi({
            description: "Every active store the caller can access, including stores with no stock of this variant (quantity 0).",
          }),
      })
    ),
  })
  .openapi("ProductStockData");

export const StockMovementSchema = z
  .object({
    id: objectId("665f1c2e8a4b3c0012ab3900"),
    store: StockStoreRefSchema,
    variant: StockVariantRefSchema,
    product: StockProductRefSchema,
    type: z.string().openapi({
      description:
        "`opening`, `adjustment`, `transfer_out` or `transfer_in` in Phase 2. Purchases and sales will add `purchase`, `purchase_return`, `sale` and `sale_return`: show unknown types as they are rather than failing.",
      example: "adjustment",
    }),
    quantityChange: quantity(-2, "Signed: positive adds stock, negative removes it."),
    quantityAfter: quantity(16, "Stock in this store right after this movement."),
    unitCost: money("1.600", "Cost per unit used for this movement, VAT-exclusive."),
    valueChange: money("-3.200", "quantityChange × unitCost; negative when stock is removed."),
    source: z
      .object({
        type: z.string().openapi({
          description:
            "`product` (opening stock entered when the product or variant was created), `adjustment` or `transfer` in Phase 2. Purchases and sales will add more: show unknown values as they are.",
          example: "adjustment",
        }),
        id: objectId("665f1c2e8a4b3c0012ab3a00", "The id of the source record."),
        number: z.string().nullable().openapi({
          description:
            "The source document's number for display (e.g. an invoice number), when it has one. null for product opening stock, and for adjustments and transfers until they get document numbers.",
          example: null as unknown as string,
        }),
      })
      .openapi({ description: "The record that caused this movement." }),
    reason: z.string().nullable().openapi({
      description: `Adjustments only: ${REASON_LIST}. More may be added: show unknown values as they are.`,
      example: "damaged",
    }),
    note: z.string().nullable().openapi({ example: "Carton dropped in the stockroom." }),
    createdBy: StockUserRefSchema,
    createdAt: isoDate("2026-10-17T08:15:00.000Z"),
  })
  .openapi("StockMovement");

export const StockMovementListDataSchema = z
  .object({
    movements: z.array(StockMovementSchema),
    pagination: PaginationSchema,
  })
  .openapi("StockMovementListData");

const adjustmentCore = {
  id: objectId("665f1c2e8a4b3c0012ab3a00"),
  store: StockStoreRefSchema,
  reason: z.string().openapi({
    description: `${REASON_LIST}. More may be added: show unknown values as they are.`,
    example: "damaged",
  }),
  note: z.string().nullable().openapi({ example: "Carton dropped in the stockroom." }),
  valueChange: money("-3.200", "Sum of the lines' valueChange."),
  createdBy: StockUserRefSchema,
  createdAt: isoDate("2026-10-17T08:15:00.000Z"),
};

export const StockAdjustmentSummarySchema = z
  .object({
    ...adjustmentCore,
    lineCount: z.number().int().openapi({ example: 3 }),
  })
  .openapi("StockAdjustmentSummary");

export const StockAdjustmentSchema = z
  .object({
    ...adjustmentCore,
    lines: z.array(
      z.object({
        variant: StockVariantRefSchema,
        product: StockProductRefSchema,
        mode: z.enum(["change", "count"]).openapi({
          description: "`change`: quantityChange was sent. `count`: countedQuantity was sent.",
          example: "change",
        }),
        countedQuantity: z.number().nullable().openapi({ description: "Count mode only.", example: null as unknown as number }),
        quantityBefore: quantity(18),
        quantityChange: quantity(-2, "0 when a count matched the stock (no movement is written for that line)."),
        quantityAfter: quantity(16),
        unitCost: money("1.600"),
        valueChange: money("-3.200"),
      })
    ),
  })
  .openapi("StockAdjustment");

export const StockAdjustmentDataSchema = z.object({ adjustment: StockAdjustmentSchema }).openapi("StockAdjustmentData");

export const StockAdjustmentListDataSchema = z
  .object({
    adjustments: z.array(StockAdjustmentSummarySchema),
    pagination: PaginationSchema,
  })
  .openapi("StockAdjustmentListData");

const transferCore = {
  id: objectId("665f1c2e8a4b3c0012ab3b00"),
  fromStore: StockStoreRefSchema,
  toStore: StockStoreRefSchema,
  note: z.string().nullable().openapi({ example: "Weekend restock for the mall branch." }),
  totalValue: money("9.600", "Sum of quantity × unitCost over the lines."),
  createdBy: StockUserRefSchema,
  createdAt: isoDate("2026-10-17T08:15:00.000Z"),
};

export const StockTransferSummarySchema = z
  .object({
    ...transferCore,
    lineCount: z.number().int().openapi({ example: 2 }),
  })
  .openapi("StockTransferSummary");

export const StockTransferSchema = z
  .object({
    ...transferCore,
    lines: z.array(
      z.object({
        variant: StockVariantRefSchema,
        product: StockProductRefSchema,
        quantity: quantity(6),
        unitCost: money("1.600", "The source store's average cost at the time of the transfer."),
        fromQuantityAfter: quantity(12, "Source store stock right after the transfer."),
        toQuantityAfter: quantity(30, "Destination store stock right after the transfer."),
      })
    ),
  })
  .openapi("StockTransfer");

export const StockTransferDataSchema = z.object({ transfer: StockTransferSchema }).openapi("StockTransferData");

export const StockTransferListDataSchema = z
  .object({
    transfers: z.array(StockTransferSummarySchema),
    pagination: PaginationSchema,
  })
  .openapi("StockTransferListData");
