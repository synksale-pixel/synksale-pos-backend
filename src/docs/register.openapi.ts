/**
 * Purpose: Swagger for Phase 4a-2 registers (contract preview: documented for frontend sign-off;
 * the routes answer 404 until the implementation ships).
 */
import { registry, z } from "../config/openapi.registry";
import { createRegisterSchema, listRegistersQuerySchema, updateRegisterSchema } from "../validators/register.validator";
import { NullDataSuccessSchema, RegisterDataSchema, RegisterListDataSchema, successEnvelope } from "../validators/responses";
import { API, errorResponse, json, server500, TENANT_AUTH_401, validation400 } from "./common";

const security = [{ tenantBearerAuth: [] }];
const tags = ["Registers"];
const base = `${API}/stores/{storeId}/registers`;
const path = `${base}/{registerId}`;

export const PREVIEW =
  "**Contract preview (Phase 4a-2):** documented for frontend sign-off; the route answers 404 until the implementation ships.";

const storeIdParam = z.object({
  storeId: z.string().openapi({ description: "Store ID (24-char hex ObjectId).", example: "665f1c2e8a4b3c0012ab3400" }),
});
const registerParams = storeIdParam.extend({
  registerId: z.string().openapi({
    description: "Register ID (24-char hex ObjectId). A malformed ID returns 400.",
    example: "665f1c2e8a4b3c0012ab4200",
  }),
});

export const registerExample = { name: "Counter 2" };
export const updateRegisterExample = { name: "Counter 2 (drive-through)", isActive: true };

const readNote =
  "Requires a **tenant** bearer token and access to the store (an organization-scoped role, or an assignment to this store). **No permission is needed**: every cashier picks a register. Works for a deactivated store too, so it can be set up before it opens.";
const writeNote =
  "Requires a **tenant** bearer token, access to the store and **`store:configure`** there (store managers and org admins).";

const NEW_STORE_NOTE =
  "Every store has a register from the start: creating a store creates one named `Register 1`, and the 4a-2 migration gives each existing store one. Rename it, or add more for stores with several tills.";

const store403 = errorResponse(
  "No access to this store, or (writes) no `store:configure` there.",
  "Access Denied: You do not have access authorization for the requested store.",
  403
);
const store404 = errorResponse("The store does not exist in your organization (or is deleted). No `code`.", "Store not found.", 404);
const notFound404 = errorResponse(
  "The store, or the register in this store, does not exist. A register of another store is `REGISTER_NOT_FOUND` too.",
  "Register not found.",
  404,
  "REGISTER_NOT_FOUND"
);
const nameTaken409 = errorResponse(
  "Another register of this store has this name (case-insensitive). Code `REGISTER_NAME_TAKEN`, with `field: name`.",
  "Another register in this store is already named 'Counter 2'.",
  409,
  "REGISTER_NAME_TAKEN",
  [{ field: "name", code: "REGISTER_NAME_TAKEN" }]
);

registry.registerPath({
  method: "get",
  path: base,
  tags,
  summary: "List a store's registers",
  description: [PREVIEW, "", readNote, "", "All registers, sorted by name, not paginated (a store has few). The till shows `isActive=true` ones in its picker and remembers the choice per device; 4b's shift open and 4c's sale send that `registerId`.", "", NEW_STORE_NOTE].join("\n"),
  security,
  request: { params: storeIdParam, query: listRegistersQuerySchema },
  responses: {
    200: {
      description: "The store's registers.",
      content: json(successEnvelope("RegisterListResponse", RegisterListDataSchema, "Registers fetched successfully.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: store403,
    404: store404,
    500: server500,
  },
});

registry.registerPath({
  method: "get",
  path,
  tags,
  summary: "Get a register",
  description: [PREVIEW, "", readNote].join("\n"),
  security,
  request: { params: registerParams },
  responses: {
    200: {
      description: "The register.",
      content: json(successEnvelope("RegisterResponse", RegisterDataSchema, "Register fetched successfully.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: store403,
    404: notFound404,
    500: server500,
  },
});

registry.registerPath({
  method: "post",
  path: base,
  tags,
  summary: "Add a register",
  description: [PREVIEW, "", writeNote, "", "No `Idempotency-Key`: a retried create hits `REGISTER_NAME_TAKEN` instead of making a second register."].join("\n"),
  security,
  request: {
    params: storeIdParam,
    body: { required: true, content: { "application/json": { schema: createRegisterSchema, example: registerExample } } },
  },
  responses: {
    201: {
      description: "Register created.",
      content: json(successEnvelope("RegisterCreateResponse", RegisterDataSchema, "Register created successfully.", 201)),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: store403,
    404: store404,
    409: nameTaken409,
    500: server500,
  },
});

registry.registerPath({
  method: "patch",
  path,
  tags,
  summary: "Rename, deactivate or reactivate a register",
  description: [
    PREVIEW,
    "",
    writeNote,
    "",
    "Send only what changes. A renamed register keeps its id, so past sales still point at it (and show its current name).",
    "",
    "From 4b: a register with an open shift cannot be deactivated (`409 REGISTER_HAS_OPEN_SHIFT`).",
  ].join("\n"),
  security,
  request: {
    params: registerParams,
    body: { required: true, content: { "application/json": { schema: updateRegisterSchema, example: updateRegisterExample } } },
  },
  responses: {
    200: {
      description: "Register updated.",
      content: json(successEnvelope("RegisterUpdateResponse", RegisterDataSchema, "Register updated successfully.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: store403,
    404: notFound404,
    409: nameTaken409,
    500: server500,
  },
});

registry.registerPath({
  method: "delete",
  path,
  tags,
  summary: "Delete a register",
  description: [
    PREVIEW,
    "",
    writeNote,
    "",
    "Only a register that has never had a shift: once 4b ships, a used register is `409 REGISTER_IN_USE` (sales and shifts keep pointing at it). Deactivate it instead.",
  ].join("\n"),
  security,
  request: { params: registerParams },
  responses: {
    200: {
      description: "Register deleted.",
      content: json(NullDataSuccessSchema("RegisterDeleteResponse", "Register deleted successfully.")),
    },
    400: validation400,
    401: TENANT_AUTH_401,
    403: store403,
    404: notFound404,
    409: errorResponse(
      "The register has had shifts (from 4b). Deactivate it instead. Code `REGISTER_IN_USE`.",
      "This register has shifts and cannot be deleted. Deactivate it instead.",
      409,
      "REGISTER_IN_USE"
    ),
    500: server500,
  },
});
