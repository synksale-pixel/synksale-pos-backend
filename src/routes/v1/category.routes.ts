/**
 * Purpose: Category Routes.
 * READS need `product:read` held anywhere (organization role or any store role), so cashiers can
 * browse categories. Categories are organization-wide, so there is nothing to narrow by store.
 * WRITES need an organization-level role and the matching product permission (categories share
 * the product permissions).
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import {
  authenticate,
  requireOrganizationRole,
  authorize,
  authorizeAnyScope,
} from "../../middleware/rbac.middleware";
import { createCategorySchema, updateCategorySchema } from "../../validators/category.validator";
import { list, getOne, create, update, remove } from "../../controllers/category.controller";

const categoryRouter = Router();

categoryRouter.use(authenticate);

const canRead = authorizeAnyScope("product:read");

categoryRouter.get("/", canRead, list);
categoryRouter.get("/:categoryId", canRead, getOne);

categoryRouter.post(
  "/",
  requireOrganizationRole,
  authorize("product:create"),
  validateRequest(createCategorySchema),
  create
);
categoryRouter.patch(
  "/:categoryId",
  requireOrganizationRole,
  authorize("product:update"),
  validateRequest(updateCategorySchema),
  update
);
categoryRouter.delete("/:categoryId", requireOrganizationRole, authorize("product:delete"), remove);

export default categoryRouter;
