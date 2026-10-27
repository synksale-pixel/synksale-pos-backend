import { registry, z } from "../config/openapi.registry";
import { createVendorSchema, listVendorsQuerySchema, updateVendorSchema } from "../validators/vendor.validator";
import { NullDataSuccessSchema, successEnvelope, VendorDataSchema, VendorListDataSchema } from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Vendors"];
const base = `${API}/vendors`;

const vendorIdParam = z.object({
  vendorId: z.string().openapi({
    description: "Vendor ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab3900",
  }),
});

/** A local VAT-registered supplier with net-30 terms. */
export const vendorExample = {
  name: "Gulf Roasters W.L.L.",
  legalName: "Gulf Roasters Trading W.L.L.",
  taxRegistrationNumber: "220000987600003",
  countryCode: "BH",
  vatTreatment: "vat_registered",
  contactName: "Hassan Ali",
  email: "orders@gulfroasters.bh",
  phone: "+973 1700 1234",
  address: { line1: "Building 1180, Road 3621", line2: "Block 436", city: "Manama", state: "Capital Governorate", postalCode: "436" },
  paymentTermsDays: 30,
  notes: "Delivers Sunday and Wednesday mornings.",
};

/** The least a vendor needs: a name. Everything else defaults (vatTreatment: not_registered). */
export const minimalVendorExample = { name: "Al Safa Wholesale" };

/** A foreign supplier: no Gulf TRN, so vatTreatment defaults to overseas. */
export const foreignVendorExample = {
  name: "Shenzhen Bright Packaging Co.",
  countryCode: "CN",
  email: "sales@brightpack.cn",
  paymentTermsDays: 0,
};

const readNote = `Requires a **tenant** bearer token and, held anywhere (org role or any store role), **\`purchase:read\`** (staff who receive goods pick the vendor) **or \`product:create\` / \`product:update\`** (the product form's preferred-vendor picker). Vendors are organization-wide.`;
const writeNote = `Requires a **tenant** bearer token, an **organization-scoped role** and **\`vendor:manage\`**.`;

const read403 = errorResponse(
  "No role grants `purchase:read`, `product:create` or `product:update`.",
  "Access Denied: You do not possess the required permission (purchase:read) to execute this action.",
  403
);
const write403 = errorResponse(
  "Not an organization-scoped role, or missing `vendor:manage`.",
  "Access Denied: This action requires an organization-level role.",
  403
);
const notFound404 = errorResponse(
  "Vendor does not exist in your organization (other organizations' and deleted vendors look the same). Code `VENDOR_NOT_FOUND`. (A `preferredVendorId` that does not exist inside a product request body is a 400, not a 404.)",
  "Vendor not found.",
  404,
  "VENDOR_NOT_FOUND",
  [{ field: "vendorId", code: "VENDOR_NOT_FOUND" }]
);
const nameTaken409 = errorResponse(
  "Another vendor in your organization already has this name (case-insensitive). Code `VENDOR_NAME_TAKEN`. Deleted vendors free their name.",
  "A vendor named 'Gulf Roasters W.L.L.' already exists.",
  409,
  "VENDOR_NAME_TAKEN",
  [{ field: "name", code: "VENDOR_NAME_TAKEN" }]
);
const validation400 = errorResponse(
  [
    "Validation failed (`VALIDATION_FAILED`):",
    "- name 1-120 characters; legalName up to 200; contactName up to 100; notes up to 1000. Empty strings are rejected: send null to clear a field.",
    "- taxRegistrationNumber 5-20 letters or digits after removing spaces and hyphens.",
    "- countryCode an assigned ISO 3166-1 alpha-2 code (any country; `GB`, not `UK`).",
    "- vatTreatment one of `vat_registered`, `not_registered`, `overseas`; `vat_registered` needs a TRN (on update, the stored TRN counts).",
    "- email a valid address; phone 7-20 digits, spaces, `+`, `-`, `(`, `)`.",
    "- address fields line1/line2 up to 200, city/state up to 100, postalCode up to 20; unknown address fields rejected.",
    "- paymentTermsDays a whole number 0-365.",
    "- Unknown fields rejected; an update must carry at least one field. A malformed `vendorId` in the path also returns 400.",
  ].join("\n"),
  "Request Validation Failed: taxRegistrationNumber: Tax registration number must be 5-20 letters or digits.",
  400,
  "VALIDATION_FAILED"
);

const exampleBodies = {
  local: { summary: "Local VAT-registered supplier, net 30", value: vendorExample },
  minimal: { summary: "Name only (country defaults to yours, VAT to not_registered, terms to 0)", value: minimalVendorExample },
  foreign: { summary: "Foreign supplier without a Gulf TRN (VAT defaults to overseas)", value: foreignVendorExample },
};

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List vendors",
  description: `${readNote}\n\nPaginated, ordered by name. For a picker send \`isActive=true\` and \`search\` as the user types.`,
  security,
  request: { query: listVendorsQuerySchema },
  responses: {
    200: {
      description: "Vendors fetched.",
      content: json(successEnvelope("VendorListResponse", VendorListDataSchema, "Vendors fetched successfully.")),
    },
    401: TENANT_AUTH_401,
    403: read403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/{vendorId}`,
  tags,
  summary: "Get a vendor",
  description: readNote,
  security,
  request: { params: vendorIdParam },
  responses: {
    200: {
      description: "Vendor fetched.",
      content: json(successEnvelope("GetVendorResponse", VendorDataSchema, "Vendor fetched successfully.")),
    },
    400: errorResponse("Malformed vendorId.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: read403,
    404: notFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: base,
  tags,
  summary: "Create a vendor",
  description: [
    writeNote,
    "",
    "Only `name` is required.",
    "- `countryCode` defaults to your organization's country (BH for a BHD organization).",
    "- `vatTreatment` defaults from the TRN and country: TRN → `vat_registered`; no TRN and a foreign country → `overseas`; otherwise `not_registered`. The form can show the derived value and let the user change it.",
    "- `paymentTermsDays` defaults to 0 (due on receipt).",
    "- Bills from vendors are always in your organization's currency in v1.",
  ].join("\n"),
  security,
  request: { body: { required: true, content: { "application/json": { schema: createVendorSchema, examples: exampleBodies } } } },
  responses: {
    201: {
      description: "Vendor created.",
      content: json(successEnvelope("CreateVendorResponse", VendorDataSchema, "Vendor created successfully.", 201)),
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
  path: `${base}/{vendorId}`,
  tags,
  summary: "Update a vendor",
  description: [
    writeNote,
    "",
    "Send only the fields to change; null clears an optional field. `address` is merged field by field.",
    "- `isActive: false` hides the vendor from pickers (`isActive=true`). From Phase 3b it blocks **new purchase orders** and **receipts without a PO**. Receipts against its open POs, bills, payments and returns are still allowed, so goods in transit and money owed can be settled. Products keep it as their preferred vendor.",
    "- `vatTreatment` is not re-derived when the TRN or country changes; send it too if it should change.",
    "- Changing the name, TRN or VAT treatment does not change documents already posted: they keep a copy of the vendor's details as they were.",
  ].join("\n"),
  security,
  request: {
    params: vendorIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateVendorSchema,
          examples: {
            terms: { summary: "Change payment terms", value: { paymentTermsDays: 45 } },
            deactivate: { summary: "Stop buying from this vendor", value: { isActive: false } },
            deregistered: {
              summary: "Vendor deregistered from VAT",
              value: { taxRegistrationNumber: null, vatTreatment: "not_registered" },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: "Vendor updated.",
      content: json(successEnvelope("UpdateVendorResponse", VendorDataSchema, "Vendor updated successfully.")),
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
  method: "delete",
  path: `${base}/{vendorId}`,
  tags,
  summary: "Delete a vendor",
  description: [
    writeNote,
    "",
    "Soft delete; the name becomes reusable. Products that named this vendor as preferred are cleared (`preferredVendor: null`).",
    "A vendor with any purchase order (from Phase 3b; any status, but deleted drafts do not count), receipt, bill or return cannot be deleted (`VENDOR_IN_USE`); deactivate it instead.",
  ].join("\n"),
  security,
  request: { params: vendorIdParam },
  responses: {
    200: {
      description: "Vendor deleted.",
      content: json(NullDataSuccessSchema("DeleteVendorResponse", "Vendor deleted successfully.")),
    },
    400: errorResponse("Malformed vendorId.", "Invalid path identifier: Value 'abc' is not a valid ObjectId for path '_id'", 400),
    401: TENANT_AUTH_401,
    403: write403,
    404: notFound404,
    409: errorResponse(
      "From Phase 3b: the vendor has purchase documents. Code `VENDOR_IN_USE`; `errors[0].meta.documentCount` says how many. Deactivate the vendor instead.",
      "This vendor has 3 purchase documents. Deactivate it instead.",
      409,
      "VENDOR_IN_USE",
      [{ code: "VENDOR_IN_USE", meta: { documentCount: 3 } }]
    ),
    500: server500,
  },
});
