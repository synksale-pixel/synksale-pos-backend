import { registry } from "../config/openapi.registry";
import { updateOrganizationSchema } from "../validators/organization.validator";
import { OrganizationProfileDataSchema, successEnvelope } from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Organization"];
const base = `${API}/organization`;

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "Get my organization",
  description:
    "Requires a **tenant** bearer token; no specific permission (any authenticated member). Returns the caller's own organization profile, including `currency` (code, name and `decimals`, the number of minor-unit digits to use when formatting money: BHD/KWD/OMR 3, others 2) and the `country` that uses it. Clients should read this once after login to format money.",
  security,
  responses: {
    200: {
      description: "Organization fetched.",
      content: json(
        successEnvelope(
          "GetOrganizationResponse",
          OrganizationProfileDataSchema,
          "Organization fetched successfully."
        )
      ),
    },
    401: TENANT_AUTH_401,
    404: errorResponse(
      "The organization record no longer exists.",
      "Organization not found.",
      404,
      "ORGANIZATION_NOT_FOUND"
    ),
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path: base,
  tags,
  summary: "Update my organization",
  description: [
    "Requires a **tenant** bearer token, an **organization-scoped role** (e.g. org_admin; store-scoped staff get 403 even if their role has the permission) and the **`organization:configure`** permission.",
    "",
    "Send at least one of `legalName`, `taxRegistrationNumber`, `settings`. Unknown fields are rejected (400). `legalName` and `taxRegistrationNumber` accept `null` to clear them. `taxRegistrationNumber` has spaces and hyphens removed and is uppercased, then must be 5-20 letters/digits. `settings` may contain `currency`, `timezone` (IANA) and `inventory.allowNegativeStock`.",
    "",
    "Changing `settings.currency` is refused with 409 `CURRENCY_STORE_MISMATCH` while any store is in a country that uses a different currency; `errors` lists every blocking store as `{ field: \"settings.currency\", code, meta: { storeId, storeCode, countryCode } }`. Move or fix those stores first.",
  ].join("\n"),
  security,
  request: { body: { required: true, content: json(updateOrganizationSchema) } },
  responses: {
    200: {
      description: "Organization updated. Returns the full updated profile.",
      content: json(
        successEnvelope(
          "UpdateOrganizationResponse",
          OrganizationProfileDataSchema,
          "Organization updated successfully."
        )
      ),
    },
    400: errorResponse(
      "Validation failed (unknown field, empty body, invalid currency/timezone/TRN). `code` is `VALIDATION_FAILED`.",
      "Request Validation Failed: taxRegistrationNumber: Tax registration number must be 5-20 letters or digits.",
      400,
      "VALIDATION_FAILED"
    ),
    401: TENANT_AUTH_401,
    403: errorResponse(
      "Not an organization-scoped role ('Access Denied: This action requires an organization-level role.') or missing `organization:configure` permission.",
      "Access Denied: This action requires an organization-level role.",
      403
    ),
    404: errorResponse(
      "The organization record no longer exists.",
      "Organization not found.",
      404,
      "ORGANIZATION_NOT_FOUND"
    ),
    409: errorResponse(
      "The new currency conflicts with existing stores (code `CURRENCY_STORE_MISMATCH`); one `errors` item per blocking store.",
      "The currency cannot be changed to AED: some stores are in a country that uses another currency.",
      409,
      "CURRENCY_STORE_MISMATCH",
      [
        {
          field: "settings.currency",
          code: "CURRENCY_STORE_MISMATCH",
          meta: { storeId: "665f1c2e8a4b3c0012ab34ef", storeCode: "MNM-001", countryCode: "BH" },
        },
      ]
    ),
    500: server500,
  },
});
