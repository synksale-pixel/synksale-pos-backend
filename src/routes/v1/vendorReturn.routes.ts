/**
 * Purpose: Vendor Return and Debit Note Routes (Phase 3e).
 * STORE ROUTES (mounted at /stores/:storeId/vendor-returns): scopeToStore verifies the caller may
 * access the store before the permission is checked for that store.
 * - reads: `purchase:read`, also for a deactivated store
 * - returning: `purchase:return` and an active store, with an Idempotency-Key header.
 * - returns are final: no PATCH, DELETE or void.
 * CROSS-STORE LIST (mounted at /vendor-returns): `purchase:read` held anywhere; results are
 * narrowed to the caller's stores.
 * DEBIT NOTES (mounted at /debit-notes): organization-level, so store roles get 403.
 * - reads: `purchase:read`; price adjustments, apply and void: `purchase:bill` (Idempotency-Key).
 *
 * The store router is mounted before the store stock router, whose scopeToStore would otherwise
 * refuse every request to a deactivated store first.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import { requireIdempotencyKey } from "../../middleware/idempotency.middleware";
import { authenticate, scopeToStore, scopeToStoreAllowInactive, authorize, authorizeAnyScope } from "../../middleware/rbac.middleware";
import {
  applyDebitNoteSchema,
  createDebitNoteSchema,
  createVendorReturnSchema,
  voidDebitNoteSchema,
} from "../../validators/vendorReturn.validator";
import {
  listAllReturns,
  listStoreReturns,
  getReturn,
  createReturn,
  listDebitNotesHandler,
  getDebitNoteHandler,
  createDebitNoteHandler,
  applyDebitNoteHandler,
  voidDebitNoteHandler,
} from "../../controllers/vendorReturn.controller";

// mergeParams: the :storeId of the mount path is what scopeToStore reads.
export const storeVendorReturnRouter = Router({ mergeParams: true });

storeVendorReturnRouter.use(authenticate);

const read = [scopeToStoreAllowInactive, authorize("purchase:read")];

storeVendorReturnRouter.get("/", ...read, listStoreReturns);
storeVendorReturnRouter.post(
  "/",
  scopeToStore,
  authorize("purchase:return"),
  validateRequest(createVendorReturnSchema),
  requireIdempotencyKey,
  createReturn
);
storeVendorReturnRouter.get("/:vendorReturnId", ...read, getReturn);

export const vendorReturnRouter = Router();

vendorReturnRouter.use(authenticate);

vendorReturnRouter.get("/", authorizeAnyScope("purchase:read"), listAllReturns);

export const debitNoteRouter = Router();

debitNoteRouter.use(authenticate);

debitNoteRouter.get("/", authorize("purchase:read"), listDebitNotesHandler);
debitNoteRouter.post("/", authorize("purchase:bill"), validateRequest(createDebitNoteSchema), requireIdempotencyKey, createDebitNoteHandler);
debitNoteRouter.get("/:debitNoteId", authorize("purchase:read"), getDebitNoteHandler);
debitNoteRouter.post(
  "/:debitNoteId/apply",
  authorize("purchase:bill"),
  validateRequest(applyDebitNoteSchema),
  requireIdempotencyKey,
  applyDebitNoteHandler
);
debitNoteRouter.post(
  "/:debitNoteId/void",
  authorize("purchase:bill"),
  validateRequest(voidDebitNoteSchema),
  requireIdempotencyKey,
  voidDebitNoteHandler
);
