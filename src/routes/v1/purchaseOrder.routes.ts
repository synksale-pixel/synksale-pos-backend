/**
 * Purpose: Purchase Order Routes.
 * STORE ROUTES (mounted at /stores/:storeId/purchase-orders): scopeToStore verifies the caller
 * may access the store before the permission is checked for that store.
 * - reads: `purchase:read`; writes: `purchase:order`
 * - a deactivated store's POs can still be read, cancelled and closed (scopeToStoreAllowInactive);
 *   creating, editing, deleting and issuing need an active store
 * - creating a PO needs an Idempotency-Key header
 * CROSS-STORE LIST (mounted at /purchase-orders): `purchase:read` held anywhere; results are
 * narrowed to the caller's stores.
 *
 * Mounted before the store stock router, whose scopeToStore would otherwise refuse every request
 * to a deactivated store first.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import { requireIdempotencyKey } from "../../middleware/idempotency.middleware";
import {
  authenticate,
  scopeToStore,
  scopeToStoreAllowInactive,
  authorize,
  authorizeAnyScope,
} from "../../middleware/rbac.middleware";
import {
  createPurchaseOrderSchema,
  updatePurchaseOrderSchema,
  issuePurchaseOrderSchema,
  cancelPurchaseOrderSchema,
  closePurchaseOrderSchema,
} from "../../validators/purchaseOrder.validator";
import {
  listAll,
  listForStore,
  getOne,
  create,
  update,
  remove,
  issue,
  cancel,
  close,
} from "../../controllers/purchaseOrder.controller";

// mergeParams: the :storeId of the mount path is what scopeToStore reads.
export const storePurchaseOrderRouter = Router({ mergeParams: true });

storePurchaseOrderRouter.use(authenticate);

const read = [scopeToStoreAllowInactive, authorize("purchase:read")];
const write = [scopeToStore, authorize("purchase:order")];
const settle = [scopeToStoreAllowInactive, authorize("purchase:order")];

storePurchaseOrderRouter.get("/", ...read, listForStore);
storePurchaseOrderRouter.post("/", ...write, validateRequest(createPurchaseOrderSchema), requireIdempotencyKey, create);
storePurchaseOrderRouter.get("/:purchaseOrderId", ...read, getOne);
storePurchaseOrderRouter.patch("/:purchaseOrderId", ...write, validateRequest(updatePurchaseOrderSchema), update);
storePurchaseOrderRouter.delete("/:purchaseOrderId", ...write, remove);
storePurchaseOrderRouter.post("/:purchaseOrderId/issue", ...write, validateRequest(issuePurchaseOrderSchema), issue);
storePurchaseOrderRouter.post("/:purchaseOrderId/cancel", ...settle, validateRequest(cancelPurchaseOrderSchema), cancel);
storePurchaseOrderRouter.post("/:purchaseOrderId/close", ...settle, validateRequest(closePurchaseOrderSchema), close);

export const purchaseOrderRouter = Router();

purchaseOrderRouter.use(authenticate);

purchaseOrderRouter.get("/", authorizeAnyScope("purchase:read"), listAll);
