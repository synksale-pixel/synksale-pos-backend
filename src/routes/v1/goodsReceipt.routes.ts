/**
 * Purpose: Goods Receipt Routes.
 * STORE ROUTES (mounted at /stores/:storeId/goods-receipts): scopeToStore verifies the caller
 * may access the store before the permission is checked for that store.
 * - reads: `purchase:read`, also for a deactivated store
 * - receiving: `purchase:receive` and an active store, with an Idempotency-Key header. Receiving
 *   without a PO or at another cost also needs `purchase:order` (checked in the service).
 * - receipts are final: no PATCH or DELETE.
 * CROSS-STORE LIST (mounted at /goods-receipts): `purchase:read` held anywhere; results are
 * narrowed to the caller's stores.
 *
 * Mounted before the store stock router, whose scopeToStore would otherwise refuse every request
 * to a deactivated store first.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import { requireIdempotencyKey } from "../../middleware/idempotency.middleware";
import { authenticate, scopeToStore, scopeToStoreAllowInactive, authorize, authorizeAnyScope } from "../../middleware/rbac.middleware";
import { createGoodsReceiptSchema } from "../../validators/goodsReceipt.validator";
import { listAll, listForStore, getOne, create } from "../../controllers/goodsReceipt.controller";

// mergeParams: the :storeId of the mount path is what scopeToStore reads.
export const storeGoodsReceiptRouter = Router({ mergeParams: true });

storeGoodsReceiptRouter.use(authenticate);

const read = [scopeToStoreAllowInactive, authorize("purchase:read")];

storeGoodsReceiptRouter.get("/", ...read, listForStore);
storeGoodsReceiptRouter.post(
  "/",
  scopeToStore,
  authorize("purchase:receive"),
  validateRequest(createGoodsReceiptSchema),
  requireIdempotencyKey,
  create
);
storeGoodsReceiptRouter.get("/:goodsReceiptId", ...read, getOne);

export const goodsReceiptRouter = Router();

goodsReceiptRouter.use(authenticate);

goodsReceiptRouter.get("/", authorizeAnyScope("purchase:read"), listAll);
