/**
 * Purpose: Tax Rate Routes.
 * READS need only authentication: the product form and the POS both need the rate list, and an
 * organization's tax rates are not sensitive.
 * WRITES need `tax:manage` and an organization-level role — tax rates apply to every store.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import {
  authenticate,
  requireOrganizationRole,
  authorize,
} from "../../middleware/rbac.middleware";
import { createTaxRateSchema, updateTaxRateSchema } from "../../validators/taxRate.validator";
import {
  list,
  getOne,
  create,
  update,
  makeDefault,
  deactivate,
  activate,
  remove,
} from "../../controllers/taxRate.controller";

const taxRateRouter = Router();

taxRateRouter.use(authenticate);

taxRateRouter.get("/", list);
taxRateRouter.get("/:taxRateId", getOne);

const canManage = [requireOrganizationRole, authorize("tax:manage")];

taxRateRouter.post("/", ...canManage, validateRequest(createTaxRateSchema), create);
taxRateRouter.patch("/:taxRateId", ...canManage, validateRequest(updateTaxRateSchema), update);
taxRateRouter.patch("/:taxRateId/default", ...canManage, makeDefault);
taxRateRouter.patch("/:taxRateId/deactivate", ...canManage, deactivate);
taxRateRouter.patch("/:taxRateId/activate", ...canManage, activate);
taxRateRouter.delete("/:taxRateId", ...canManage, remove);

export default taxRateRouter;
