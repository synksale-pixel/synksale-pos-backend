/**
 * Purpose: Organization Routes (tenant side).
 * The caller's own organization: any member can read it (clients need the currency to format
 * money); updating needs `organization:configure` and an organization-level role.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import {
  authenticate,
  requireOrganizationRole,
  authorize,
} from "../../middleware/rbac.middleware";
import { updateOrganizationSchema } from "../../validators/organization.validator";
import { getOne, update } from "../../controllers/organization.controller";

const organizationRouter = Router();

organizationRouter.use(authenticate);

organizationRouter.get("/", getOne);
organizationRouter.patch(
  "/",
  requireOrganizationRole,
  authorize("organization:configure"),
  validateRequest(updateOrganizationSchema),
  update
);

export default organizationRouter;
