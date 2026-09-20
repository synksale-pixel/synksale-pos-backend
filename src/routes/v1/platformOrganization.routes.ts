/**
 * Purpose: Platform Organization Review Routes.
 * Defines Super Admin-only endpoints for reviewing, approving, and rejecting
 * organization applications under the sales-assisted/gated onboarding model.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import { authenticateSuperAdmin } from "../../middleware/platformAuth.middleware";
import {
  approveOrganizationSchema,
  rejectOrganizationSchema,
} from "../../validators/platformOrganization.validator";
import {
  list,
  getById,
  approve,
  reject,
} from "../../controllers/platformOrganization.controller";

const platformOrganizationRouter = Router();

// All routes in this router require an authenticated Super Admin
platformOrganizationRouter.use(authenticateSuperAdmin);

platformOrganizationRouter.get("/", list);
platformOrganizationRouter.get("/:id", getById);
platformOrganizationRouter.post(
  "/:id/approve",
  validateRequest(approveOrganizationSchema),
  approve
);
platformOrganizationRouter.post(
  "/:id/reject",
  validateRequest(rejectOrganizationSchema),
  reject
);

export default platformOrganizationRouter;
