import { registry, z } from "../config/openapi.registry";
import {
  approveOrganizationSchema,
  rejectOrganizationSchema,
} from "../validators/platformOrganization.validator";
import {
  OrganizationListDataSchema,
  OrganizationSchema,
  successEnvelope,
} from "../validators/responses";
import {
  API,
  errorResponse,
  json,
  server500,
  PLATFORM_AUTH_401,
  PLATFORM_AUTH_403,
} from "./common";

const security = [{ platformBearerAuth: [] }];
const tags = ["Platform Organization Review"];
const base = `${API}/platform/organizations`;
const note =
  "Requires a **platform** (Super Admin) bearer token; a tenant token is rejected with 401. No per-permission check: any Super Admin may call it. Not store-scoped.";

const idParam = z.object({
  id: z.string().openapi({
    description: "Organization ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab3300",
  }),
});

const badId400 = errorResponse(
  "Malformed organization ID (`Invalid path identifier: ...`).",
  "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'",
  400
);
const notFound404 = errorResponse(
  "Organization not found.",
  "Organization not found.",
  404
);

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List organization applications",
  description: `${note}\n\nNewest first. Optional filtering by approval status and pagination. Query parameters are not strictly validated by the server: invalid/non-positive \`page\`/\`limit\` fall back to defaults (page 1, limit 20), \`limit\` is capped at 100, and an unknown \`status\` just yields an empty list.`,
  security,
  request: {
    query: z.object({
      status: z.enum(["pending", "approved", "rejected"]).optional().openapi({
        description: "Filter by approval status.",
        example: "pending",
      }),
      page: z.number().int().optional().openapi({
        description: "1-based page number (default 1).",
        example: 1,
      }),
      limit: z.number().int().optional().openapi({
        description: "Page size (default 20, max 100).",
        example: 20,
      }),
    }),
  },
  responses: {
    200: {
      description: "Organizations fetched.",
      content: json(
        successEnvelope(
          "OrganizationListResponse",
          OrganizationListDataSchema,
          "Organizations fetched successfully."
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
  path: `${base}/{id}`,
  tags,
  summary: "Get one organization application",
  description: note,
  security,
  request: { params: idParam },
  responses: {
    200: {
      description: "Organization fetched.",
      content: json(
        successEnvelope(
          "OrganizationResponse",
          OrganizationSchema,
          "Organization fetched successfully."
        )
      ),
    },
    400: badId400,
    401: PLATFORM_AUTH_401,
    403: PLATFORM_AUTH_403,
    404: notFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${base}/{id}/approve`,
  tags,
  summary: "Approve an organization application",
  description: `${note}\n\nApproves a \`pending\` (or previously \`rejected\`) organization so its users can log in. Optionally corrects the login slug via \`slug\` (the body may be omitted or \`{}\`). Approving an already-approved organization is 400. Clears any earlier rejection data.`,
  security,
  request: {
    params: idParam,
    body: { required: false, content: json(approveOrganizationSchema) },
  },
  responses: {
    200: {
      description: "Organization approved.",
      content: json(
        successEnvelope(
          "OrganizationApproveResponse",
          OrganizationSchema,
          "Organization approved successfully."
        )
      ),
    },
    400: errorResponse(
      "Validation failed (bad slug), malformed ID, or 'This organization is already approved.'",
      "This organization is already approved.",
      400
    ),
    401: PLATFORM_AUTH_401,
    403: PLATFORM_AUTH_403,
    404: notFound404,
    409: errorResponse(
      "Slug already used by another organization; another pending/approved organization exists for the same applicant email; or the status changed concurrently (reload and retry).",
      "This slug is already in use by another organization.",
      409
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${base}/{id}/reject`,
  tags,
  summary: "Reject an organization application",
  description: `${note}\n\nOnly \`pending\` applications can be rejected (400 otherwise, e.g. already approved or already rejected).`,
  security,
  request: {
    params: idParam,
    body: { required: true, content: json(rejectOrganizationSchema) },
  },
  responses: {
    200: {
      description: "Organization rejected.",
      content: json(
        successEnvelope(
          "OrganizationRejectResponse",
          OrganizationSchema,
          "Organization rejected successfully."
        )
      ),
    },
    400: errorResponse(
      "Validation failed, malformed ID, or 'Only pending organizations can be rejected. This organization is <status>.'",
      "Only pending organizations can be rejected. This organization is approved.",
      400
    ),
    401: PLATFORM_AUTH_401,
    403: PLATFORM_AUTH_403,
    404: notFound404,
    500: server500,
  },
});
