/**
 * Purpose: Stock Routes.
 * STORE ROUTES (mounted at /stores/:storeId): scopeToStore verifies the caller may access the
 * store (and that it is active) before the permission is checked for that store.
 * - stock list: `product:read` (cost figures additionally need `inventory:read`)
 * - movement history and adjustments: `inventory:read`; recording an adjustment: `inventory:adjust`
 * TRANSFERS (mounted at /stock-transfers) span two stores:
 * - recording one: an organization-level role and `inventory:transfer`
 * - reading: `inventory:read` held anywhere; results are narrowed to the caller's stores
 * Recording an adjustment or a transfer needs an Idempotency-Key header.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import { requireIdempotencyKey } from "../../middleware/idempotency.middleware";
import {
  authenticate,
  scopeToStore,
  requireOrganizationRole,
  authorize,
  authorizeAnyScope,
} from "../../middleware/rbac.middleware";
import { createStockAdjustmentSchema, createStockTransferSchema } from "../../validators/stock.validator";
import {
  storeStock,
  movements,
  adjust,
  adjustments,
  adjustment,
  transfer,
  transfers,
  transferDetail,
} from "../../controllers/stock.controller";

// mergeParams: the :storeId of the mount path is what scopeToStore reads.
export const storeStockRouter = Router({ mergeParams: true });

storeStockRouter.use(authenticate, scopeToStore);

storeStockRouter.get("/stock", authorize("product:read"), storeStock);
storeStockRouter.get("/stock-movements", authorize("inventory:read"), movements);
storeStockRouter.post(
  "/stock-adjustments",
  authorize("inventory:adjust"),
  validateRequest(createStockAdjustmentSchema),
  requireIdempotencyKey,
  adjust
);
storeStockRouter.get("/stock-adjustments", authorize("inventory:read"), adjustments);
storeStockRouter.get("/stock-adjustments/:adjustmentId", authorize("inventory:read"), adjustment);

export const stockTransferRouter = Router();

stockTransferRouter.use(authenticate);

stockTransferRouter.post(
  "/",
  requireOrganizationRole,
  authorize("inventory:transfer"),
  validateRequest(createStockTransferSchema),
  requireIdempotencyKey,
  transfer
);
stockTransferRouter.get("/", authorizeAnyScope("inventory:read"), transfers);
stockTransferRouter.get("/:transferId", authorizeAnyScope("inventory:read"), transferDetail);
