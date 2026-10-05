import { registry, z } from "../config/openapi.registry";
import { createTaxRateSchema, updateTaxRateSchema } from "../validators/taxRate.validator";
import {
  NullDataSuccessSchema,
  TaxRateDataSchema,
  TaxRateListDataSchema,
  successEnvelope,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Tax Rates"];
const base = `${API}/tax-rates`;

const taxRateIdParam = z.object({
  taxRateId: z.string().openapi({
    description: "Tax rate ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab3600",
  }),
});

const readNote =
  "Requires a **tenant** bearer token only (authentication, no permission): the product form and the POS need the rate list.";
const writeNote = (extra = "") =>
  `Requires a **tenant** bearer token, an **organization-scoped role** and the **\`tax:manage\`** permission (org_admin and accountant by default). Tax rates apply to every store.${extra}`;

const badId400 = errorResponse(
  "Malformed `taxRateId` (not a 24-char hex ObjectId; no `code`).",
  "Invalid path identifier: Value 'not-an-id' is not a valid ObjectId for path '_id'",
  400
);
const notFound404 = errorResponse(
  "Tax rate does not exist in your organization (rates of other organizations and deleted rates are reported the same way). Code `TAX_RATE_NOT_FOUND`.",
  "Tax rate not found.",
  404,
  "TAX_RATE_NOT_FOUND"
);
const write403 = errorResponse(
  "Not an organization-scoped role ('Access Denied: This action requires an organization-level role.') or missing `tax:manage` permission.",
  "Access Denied: This action requires an organization-level role.",
  403
);
const validation400 = errorResponse(
  "Request validation failed (code `VALIDATION_FAILED`): name 1-50 chars, 1-5 components, each rate 0-100 with at most 4 decimals, combined rate at most 100, unknown fields rejected on update.",
  "Request Validation Failed: components: The combined rate cannot exceed 100%.",
  400,
  "VALIDATION_FAILED"
);
const nameTaken409 = errorResponse(
  "A non-deleted tax rate with this name already exists in your organization (case-insensitive). Code `TAX_RATE_NAME_TAKEN`.",
  "A tax rate named 'VAT 10%' already exists.",
  409,
  "TAX_RATE_NAME_TAKEN",
  [{ field: "name", code: "TAX_RATE_NAME_TAKEN" }]
);

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List tax rates",
  description: `${readNote}\n\nReturns every non-deleted rate of the organization (there are only a handful, so no pagination), the default rate first, then by rate and name. Use \`isActive\` to hide deactivated rates when populating a picker.`,
  security,
  request: {
    query: z.object({
      isActive: z.enum(["true", "false"]).optional().openapi({
        description: "Filter by active state. Any other value is ignored.",
        example: "true",
      }),
    }),
  },
  responses: {
    200: {
      description: "Tax rates fetched.",
      content: json(
        successEnvelope("TaxRateListResponse", TaxRateListDataSchema, "Tax rates fetched successfully.")
      ),
    },
    401: TENANT_AUTH_401,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/{taxRateId}`,
  tags,
  summary: "Get a tax rate",
  description: readNote,
  security,
  request: { params: taxRateIdParam },
  responses: {
    200: {
      description: "Tax rate fetched.",
      content: json(successEnvelope("GetTaxRateResponse", TaxRateDataSchema, "Tax rate fetched successfully.")),
    },
    400: badId400,
    401: TENANT_AUTH_401,
    404: notFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: base,
  tags,
  summary: "Create a tax rate",
  description: `${writeNote()}\n\n\`rate\` in the response is the exact sum of \`components[].rate\`. Send \`isDefault: true\` to make it the organization's default (the previous default is unset atomically). New rates are active.`,
  security,
  request: { body: { required: true, content: json(createTaxRateSchema) } },
  responses: {
    201: {
      description: "Tax rate created.",
      content: json(successEnvelope("CreateTaxRateResponse", TaxRateDataSchema, "Tax rate created successfully.", 201)),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: write403,
    409: nameTaken409,
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{taxRateId}`,
  tags,
  summary: "Update a tax rate",
  description: `${writeNote()}\n\nOnly \`name\` and \`components\` can be changed (at least one); other fields, including \`isDefault\`, are rejected with 400 - use the dedicated endpoints. \`components\` replaces the whole list. Documents already issued keep the rate they copied, so a change only affects documents created afterwards.`,
  security,
  request: {
    params: taxRateIdParam,
    body: { required: true, content: json(updateTaxRateSchema) },
  },
  responses: {
    200: {
      description: "Tax rate updated.",
      content: json(successEnvelope("UpdateTaxRateResponse", TaxRateDataSchema, "Tax rate updated successfully.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    409: nameTaken409,
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{taxRateId}/default`,
  tags,
  summary: "Make a tax rate the default",
  description: `${writeNote()}\n\nNo request body. Unsets the previous default atomically. Idempotent. The rate must be active.`,
  security,
  request: { params: taxRateIdParam },
  responses: {
    200: {
      description: "Default tax rate updated.",
      content: json(
        successEnvelope("SetDefaultTaxRateResponse", TaxRateDataSchema, "Default tax rate updated successfully.")
      ),
    },
    400: badId400,
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    409: errorResponse(
      "The rate is inactive (code `TAX_RATE_INACTIVE`); activate it first.",
      "An inactive tax rate cannot be the default. Activate it first.",
      409,
      "TAX_RATE_INACTIVE"
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{taxRateId}/deactivate`,
  tags,
  summary: "Deactivate a tax rate",
  description: `${writeNote()}\n\nNo request body. An inactive rate stays on the products/documents that already use it but should not be offered for new ones. The default rate cannot be deactivated.`,
  security,
  request: { params: taxRateIdParam },
  responses: {
    200: {
      description: "Tax rate deactivated.",
      content: json(successEnvelope("DeactivateTaxRateResponse", TaxRateDataSchema, "Tax rate deactivated successfully.")),
    },
    400: badId400,
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    409: errorResponse(
      "The rate is the organization's default (code `TAX_RATE_IS_DEFAULT`); make another rate the default first.",
      "The default tax rate cannot be deactivated. Make another rate the default first.",
      409,
      "TAX_RATE_IS_DEFAULT"
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: `${base}/{taxRateId}/activate`,
  tags,
  summary: "Reactivate a tax rate",
  description: `${writeNote()}\n\nNo request body.`,
  security,
  request: { params: taxRateIdParam },
  responses: {
    200: {
      description: "Tax rate activated.",
      content: json(successEnvelope("ActivateTaxRateResponse", TaxRateDataSchema, "Tax rate activated successfully.")),
    },
    400: badId400,
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "delete",
  path: `${base}/{taxRateId}`,
  tags,
  summary: "Delete a tax rate",
  description: `${writeNote()}\n\nSoft delete: the rate disappears from every endpoint and its name can be reused. Responds 200 with \`data: null\`. The default rate cannot be deleted.`,
  security,
  request: { params: taxRateIdParam },
  responses: {
    200: {
      description: "Tax rate deleted.",
      content: json(NullDataSuccessSchema("DeleteTaxRateResponse", "Tax rate deleted successfully.")),
    },
    400: badId400,
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    409: errorResponse(
      "The rate is the organization's default (code `TAX_RATE_IS_DEFAULT`); make another rate the default first.",
      "The default tax rate cannot be deleted. Make another rate the default first.",
      409,
      "TAX_RATE_IS_DEFAULT"
    ),
    500: server500,
  },
});
