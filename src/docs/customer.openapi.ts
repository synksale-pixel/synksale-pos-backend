/**
 * Purpose: Swagger for Phase 4a-2 customers.
 */
import { registry, z } from "../config/openapi.registry";
import {
  createCustomerSchema,
  CUSTOMER_IMPORT_MAX_ROWS,
  customerLookupQuerySchema,
  importCustomersSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from "../validators/customer.validator";
import {
  CustomerDataSchema,
  CustomerImportDataSchema,
  CustomerListDataSchema,
  CustomerLookupDataSchema,
  NullDataSuccessSchema,
  successEnvelope,
} from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401, validation400 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Customers"];
const base = `${API}/customers`;
const path = `${base}/{customerId}`;


const customerIdParam = z.object({
  customerId: z.string().openapi({
    description: "Customer ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab4300",
  }),
});

/** Walk-in customer added at the till: the least a customer needs. */
export const customerExample = { name: "Fatima Al Khalifa", phone: "+973 3600 1234" };

/** A B2B customer: their TRN gets them a full tax invoice, which prints the address. */
export const businessCustomerExample = {
  name: "Gulf Traders W.L.L.",
  phone: "+973 1700 1234",
  email: "accounts@gulftraders.bh",
  taxRegistrationNumber: "220000555500003",
  address: { line1: "Office 12, Building 2050", line2: "Road 2832, Block 428", city: "Seef", postalCode: "428" },
  notes: "Monthly bulk orders.",
};

/** India: the GSTIN gives the customer's state (29, Karnataka). */
export const indiaBusinessCustomerExample = {
  name: "Sharma Traders",
  phone: "+91 98450 12345",
  taxRegistrationNumber: "29ABCDE1234F1ZW",
  address: { city: "Bengaluru", state: "Karnataka", postalCode: "560001" },
};

export const updateCustomerExample = { email: "fatima.k@example.bh", address: { city: "Riffa" } };

export const importCustomersExample = {
  rows: [
    { name: "Fatima Al Khalifa", phone: "+973 3600 1234", email: "fatima@example.bh" },
    { name: "Gulf Traders W.L.L.", phone: "17001234", taxRegistrationNumber: "220000555500003", address: { city: "Seef" } },
    { name: "Ali Hassan", phone: "3600 1234" },
    { name: "", phone: "12" },
  ],
};

const readNote =
  "Requires a **tenant** bearer token and **`customer:read`** held anywhere (organization role or any store role: cashiers have it). Customers are organization-wide, so there is nothing to narrow by store.";
const createNote =
  "Requires a **tenant** bearer token and **`customer:create`** held anywhere (cashiers have it, for the till's inline \"Add customer\").";
const manageNote =
  "Requires a **tenant** bearer token and **`customer:manage`** held anywhere (store managers and org admins; not cashiers).";

const read403 = errorResponse(
  "No role grants `customer:read`.",
  "Access Denied: You do not possess the required permission (customer:read) to execute this action.",
  403
);
const create403 = errorResponse(
  "No role grants `customer:create`.",
  "Access Denied: You do not possess the required permission (customer:create) to execute this action.",
  403
);
const manage403 = errorResponse(
  "No role grants `customer:manage`.",
  "Access Denied: You do not possess the required permission (customer:manage) to execute this action.",
  403
);
const notFound404 = errorResponse(
  "The customer does not exist in your organization (other organizations' and deleted customers look the same). Code `CUSTOMER_NOT_FOUND`.",
  "Customer not found.",
  404,
  "CUSTOMER_NOT_FOUND"
);
const phoneExists409 = errorResponse(
  "Another customer already has this phone number (compared normalised: `+973 3600 1234` = `36001234`). Code `CUSTOMER_PHONE_EXISTS`; `errors[0].meta` names the existing customer (`customerId`, `name`, `isActive`), so the till can offer `Attach {name}?` (or `Reactivate {name}?` when `isActive` is false) instead. Deactivated customers count too.",
  "A customer with this phone number already exists.",
  409,
  "CUSTOMER_PHONE_EXISTS",
  [{ field: "phone", code: "CUSTOMER_PHONE_EXISTS", message: "A customer with this phone number already exists.", meta: { customerId: "665f1c2e8a4b3c0012ab4300", isActive: true, name: "Fatima Al Khalifa" } }]
);

const COUNTRY_RULES =
  "**Country rules** (checked on the server, `400 VALIDATION_FAILED` on `taxRegistrationNumber`): the tax number must be valid for your organization's country (see the field). India: `stateCode` comes from the GSTIN's first two digits.";

const RESPONSE_SHAPE =
  "Response: the customer (`address` always present with nulls, `stateCode` read-only, `saleCount`). No loyalty points or wallet balance in v1.";

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List customers",
  description: [readNote, "", "Paginated, newest first. For the till's phone search use `GET /customers/lookup`, which is built for typing speed."].join("\n"),
  security,
  request: { query: listCustomersQuerySchema },
  responses: {
    200: {
      description: "A page of customers.",
      content: json(successEnvelope("CustomerListResponse", CustomerListDataSchema, "Customers fetched successfully.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: read403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path: `${base}/lookup`,
  tags,
  summary: "Find a customer by phone at the till",
  description: [
    readNote,
    "",
    "Built to run as the cashier types (indexed on the normalised phone). The input is normalised like a stored phone: digits only, your country's calling code and (AE, SA, IN) the trunk 0 removed.",
    "",
    "- `match`: the active customer with exactly that number. Attach them automatically.",
    "- `suggestions`: up to 4 other active customers whose number **starts with** the typed digits (not \"contains\": decided in the Phase 4 review), shortest numbers first.",
    "",
    "Deactivated customers never appear. Fewer than 4 digits after normalising: `400 VALIDATION_FAILED` on `phone`. Nothing found: `200` with `match: null` and no suggestions (offer \"Add customer\" with the typed number).",
  ].join("\n"),
  security,
  request: { query: customerLookupQuerySchema },
  responses: {
    200: {
      description: "The exact match (or null) and suggestions.",
      content: json(successEnvelope("CustomerLookupResponse", CustomerLookupDataSchema, "Customer lookup completed.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: read403,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path,
  tags,
  summary: "Get a customer",
  description: [readNote].join("\n"),
  security,
  request: { params: customerIdParam },
  responses: {
    200: {
      description: "The customer.",
      content: json(successEnvelope("CustomerResponse", CustomerDataSchema, "Customer fetched successfully.")),
    },
    400: validation400,
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
  summary: "Add a customer",
  description: [
    createNote,
    "",
    "Only `name` and `phone` are required. From the till, pre-fill `phone` with what the cashier typed in the lookup.",
    "",
    COUNTRY_RULES,
    "",
    "No `Idempotency-Key`: a retried create hits `CUSTOMER_PHONE_EXISTS` with the first attempt's `customerId`, so attach that one.",
    "",
    RESPONSE_SHAPE,
  ].join("\n"),
  security,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createCustomerSchema,
          examples: {
            walkIn: { summary: "Walk-in customer from the till", value: customerExample },
            business: { summary: "B2B customer (full tax invoice)", value: businessCustomerExample },
            india: { summary: "India B2B customer with a GSTIN", value: indiaBusinessCustomerExample },
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: "Customer created.",
      content: json(successEnvelope("CustomerCreateResponse", CustomerDataSchema, "Customer created successfully.", 201)),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: create403,
    409: phoneExists409,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: `${base}/import`,
  tags,
  summary: "Import customers in bulk",
  description: [
    manageNote,
    "",
    `Up to ${CUSTOMER_IMPORT_MAX_ROWS} rows per call, each with the fields of a create. **Rows are handled one by one and partial success is normal**: the response is \`200\` with a result per row (\`created\`, \`duplicate\` or \`invalid\`) and a summary. Only a malformed body (no \`rows\`, an empty or oversized list) is a \`400\`.`,
    "",
    "- A row whose phone belongs to an existing customer, or to an earlier row of the same import, is a `duplicate` naming that customer. Existing customers are never changed, so the same file can be sent again safely.",
    "- A row that fails a create's validation (including the tax number's country rules) is `invalid`, with the same `errors` a create would give.",
    "",
    "Optional for the frontend: creating customers one at a time with `POST /customers` also works. This is faster for large lists and gives one report.",
  ].join("\n"),
  security,
  request: {
    body: { required: true, content: { "application/json": { schema: importCustomersSchema, example: importCustomersExample } } },
  },
  responses: {
    200: {
      description: "Import processed; see each row's result.",
      content: json(successEnvelope("CustomerImportResponse", CustomerImportDataSchema, "Customer import processed.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: manage403,
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path,
  tags,
  summary: "Update a customer",
  description: [
    manageNote,
    "",
    "Send only what changes; `null` clears an optional field. Changing `phone` is checked for duplicates like a create. Clearing `taxRegistrationNumber` makes future sales simplified invoices; past sales keep the invoice they were issued with (4c snapshots the customer).",
    "",
    COUNTRY_RULES,
  ].join("\n"),
  security,
  request: {
    params: customerIdParam,
    body: { required: true, content: { "application/json": { schema: updateCustomerSchema, example: updateCustomerExample } } },
  },
  responses: {
    200: {
      description: "Customer updated.",
      content: json(successEnvelope("CustomerUpdateResponse", CustomerDataSchema, "Customer updated successfully.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: manage403,
    404: notFound404,
    409: phoneExists409,
    500: server500,
  },
});

registry.registerPath({
  method: "delete",
  path,
  tags,
  summary: "Delete a customer",
  description: [
    manageNote,
    "",
    "Only a customer with no sales (`saleCount` 0). Otherwise `409 CUSTOMER_HAS_SALES`: deactivate them instead. A deleted customer's phone number is free to be used again.",
  ].join("\n"),
  security,
  request: { params: customerIdParam },
  responses: {
    200: {
      description: "Customer deleted.",
      content: json(NullDataSuccessSchema("CustomerDeleteResponse", "Customer deleted successfully.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: manage403,
    404: notFound404,
    409: errorResponse(
      "The customer has sales. Deactivate them instead. Code `CUSTOMER_HAS_SALES`.",
      "This customer has sales and cannot be deleted. Deactivate them instead.",
      409,
      "CUSTOMER_HAS_SALES"
    ),
    500: server500,
  },
});
