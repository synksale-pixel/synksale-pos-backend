/**
 * Purpose: Vendor Routes.
 * READS need, held anywhere (organization role or any store role), `purchase:read` (staff who
 * receive goods pick the vendor) or `product:create` / `product:update` (the product form's
 * preferred-vendor picker). Vendors are organization-wide, so there is nothing to narrow by store.
 * WRITES need an organization-level role and `vendor:manage`.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import {
  authenticate,
  requireOrganizationRole,
  authorize,
  authorizeAnyScope,
} from "../../middleware/rbac.middleware";
import { createVendorSchema, updateVendorSchema } from "../../validators/vendor.validator";
import { list, getOne, create, update, remove } from "../../controllers/vendor.controller";

const vendorRouter = Router();

vendorRouter.use(authenticate);

const canRead = authorizeAnyScope("purchase:read", "product:create", "product:update");
const canManage = [requireOrganizationRole, authorize("vendor:manage")];

vendorRouter.get("/", canRead, list);
vendorRouter.get("/:vendorId", canRead, getOne);

vendorRouter.post("/", ...canManage, validateRequest(createVendorSchema), create);
vendorRouter.patch("/:vendorId", ...canManage, validateRequest(updateVendorSchema), update);
vendorRouter.delete("/:vendorId", ...canManage, remove);

export default vendorRouter;
