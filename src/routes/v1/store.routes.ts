/**
 * Purpose: Store Routes.
 * Store management for an organization. Reads are filtered to accessible stores;
 * writes require `store:create` (create) or `store:configure` (update/activate/deactivate).
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import {
  authenticate,
  scopeToStoreAllowInactive,
  requireOrganizationRole,
  authorize,
} from "../../middleware/rbac.middleware";
import { createStoreSchema, updateStoreSchema } from "../../validators/store.validator";
import {
  create,
  list,
  getOne,
  update,
  deactivate,
  activate,
} from "../../controllers/store.controller";

const storeRouter = Router();

storeRouter.use(authenticate);

storeRouter.post("/", authorize("store:create"), validateRequest(createStoreSchema), create);
storeRouter.get("/", list);

// The param is named `:storeId` (not `:id`) so scopeToStore and authorize pick it up.
// Inactive stores stay readable/manageable here so they can be reactivated.
storeRouter.get("/:storeId", scopeToStoreAllowInactive, getOne);
storeRouter.patch(
  "/:storeId",
  scopeToStoreAllowInactive,
  authorize("store:configure"),
  validateRequest(updateStoreSchema),
  update
);
// Activate/deactivate affect every user of the store, so they need an organization-level role
// in addition to `store:configure` (store managers hold that permission for their own store).
storeRouter.patch(
  "/:storeId/deactivate",
  scopeToStoreAllowInactive,
  requireOrganizationRole,
  authorize("store:configure"),
  deactivate
);
storeRouter.patch(
  "/:storeId/activate",
  scopeToStoreAllowInactive,
  requireOrganizationRole,
  authorize("store:configure"),
  activate
);

export default storeRouter;
