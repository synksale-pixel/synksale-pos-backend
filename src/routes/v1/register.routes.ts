/**
 * Purpose: Register Routes (Phase 4a-2), mounted at /stores/:storeId/registers.
 * scopeToStoreAllowInactive verifies the caller may access the store, and lets a deactivated
 * store through so its registers can be set up before it opens.
 * - reads: access to the store only (every cashier picks a register);
 * - create, rename/deactivate, delete: `store:configure` there.
 *
 * Mounted before the store stock router, whose scopeToStore refuses deactivated stores.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import { authenticate, scopeToStoreAllowInactive, authorize } from "../../middleware/rbac.middleware";
import { createRegisterSchema, updateRegisterSchema } from "../../validators/register.validator";
import { list, getOne, create, update, remove } from "../../controllers/register.controller";

// mergeParams: the :storeId of the mount path is what scopeToStore reads.
export const storeRegisterRouter = Router({ mergeParams: true });

storeRegisterRouter.use(authenticate);

const write = [scopeToStoreAllowInactive, authorize("store:configure")];

storeRegisterRouter.get("/", scopeToStoreAllowInactive, list);
storeRegisterRouter.get("/:registerId", scopeToStoreAllowInactive, getOne);
storeRegisterRouter.post("/", ...write, validateRequest(createRegisterSchema), create);
storeRegisterRouter.patch("/:registerId", ...write, validateRequest(updateRegisterSchema), update);
storeRegisterRouter.delete("/:registerId", ...write, remove);
