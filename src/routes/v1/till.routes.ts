/**
 * Purpose: Till Routes (Phase 4a-2), mounted at /stores/:storeId/till.
 * The till's catalog reads: access to the store, an ACTIVE store (scopeToStore) and
 * `sale:create` there (cashiers, store managers, org admins). They never return costs.
 */

import { Router } from "express";
import { authenticate, scopeToStore, authorize } from "../../middleware/rbac.middleware";
import { lookup, items } from "../../controllers/till.controller";

// mergeParams: the :storeId of the mount path is what scopeToStore reads.
export const storeTillRouter = Router({ mergeParams: true });

storeTillRouter.use(authenticate, scopeToStore, authorize("sale:create"));

storeTillRouter.get("/lookup", lookup);
storeTillRouter.get("/items", items);
