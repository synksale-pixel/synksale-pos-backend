/**
 * Purpose: Vendor Bill and Vendor Payment Routes (Phase 3d).
 * Organization-level (mounted at /bills and /vendor-payments): no store in the path, so
 * `authorize` checks organization-scoped roles only and store roles get 403.
 * - reads: `purchase:read`
 * - bills: `purchase:bill`; payments: `purchase:pay`. Creating and voiding need an
 *   Idempotency-Key header. Nothing is edited or deleted: void and enter again.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import { requireIdempotencyKey } from "../../middleware/idempotency.middleware";
import { authenticate, authorize } from "../../middleware/rbac.middleware";
import {
  createBillSchema,
  createVendorPaymentSchema,
  voidBillSchema,
  voidVendorPaymentSchema,
} from "../../validators/bill.validator";
import {
  listBillsHandler,
  getBillHandler,
  createBillHandler,
  voidBillHandler,
  listPaymentsHandler,
  getPaymentHandler,
  createPaymentHandler,
  voidPaymentHandler,
} from "../../controllers/bill.controller";

export const billRouter = Router();

billRouter.use(authenticate);

billRouter.get("/", authorize("purchase:read"), listBillsHandler);
billRouter.post("/", authorize("purchase:bill"), validateRequest(createBillSchema), requireIdempotencyKey, createBillHandler);
billRouter.get("/:billId", authorize("purchase:read"), getBillHandler);
billRouter.post("/:billId/void", authorize("purchase:bill"), validateRequest(voidBillSchema), requireIdempotencyKey, voidBillHandler);

export const vendorPaymentRouter = Router();

vendorPaymentRouter.use(authenticate);

vendorPaymentRouter.get("/", authorize("purchase:read"), listPaymentsHandler);
vendorPaymentRouter.post(
  "/",
  authorize("purchase:pay"),
  validateRequest(createVendorPaymentSchema),
  requireIdempotencyKey,
  createPaymentHandler
);
vendorPaymentRouter.get("/:paymentId", authorize("purchase:read"), getPaymentHandler);
vendorPaymentRouter.post(
  "/:paymentId/void",
  authorize("purchase:pay"),
  validateRequest(voidVendorPaymentSchema),
  requireIdempotencyKey,
  voidPaymentHandler
);
