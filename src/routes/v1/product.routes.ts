/**
 * Purpose: Product Routes.
 * READS (list/search, lookup, get) need `product:read` held anywhere (organization role or any
 * store role), so cashiers can search and scan. The catalog is organization-wide, so there is
 * nothing to narrow by store.
 * WRITES need an organization-level role and the matching product permission. Variant management
 * counts as updating the product.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import {
  authenticate,
  requireOrganizationRole,
  authorize,
  authorizeAnyScope,
} from "../../middleware/rbac.middleware";
import {
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  updateVariantSchema,
} from "../../validators/product.validator";
import {
  list,
  lookup,
  getOne,
  create,
  update,
  deactivate,
  activate,
  remove,
  createVariant,
  editVariant,
  deactivateVariant,
  activateVariant,
  removeVariant,
} from "../../controllers/product.controller";

const productRouter = Router();

productRouter.use(authenticate);

const canRead = authorizeAnyScope("product:read");
const canCreate = [requireOrganizationRole, authorize("product:create")];
const canUpdate = [requireOrganizationRole, authorize("product:update")];
const canDelete = [requireOrganizationRole, authorize("product:delete")];

// /lookup must be registered before /:productId, or it would be read as a product id.
productRouter.get("/", canRead, list);
productRouter.get("/lookup", canRead, lookup);
productRouter.get("/:productId", canRead, getOne);

productRouter.post("/", ...canCreate, validateRequest(createProductSchema), create);
productRouter.patch("/:productId", ...canUpdate, validateRequest(updateProductSchema), update);
productRouter.patch("/:productId/deactivate", ...canUpdate, deactivate);
productRouter.patch("/:productId/activate", ...canUpdate, activate);
productRouter.delete("/:productId", ...canDelete, remove);

productRouter.post("/:productId/variants", ...canUpdate, validateRequest(createVariantSchema), createVariant);
productRouter.patch(
  "/:productId/variants/:variantId",
  ...canUpdate,
  validateRequest(updateVariantSchema),
  editVariant
);
productRouter.patch("/:productId/variants/:variantId/deactivate", ...canUpdate, deactivateVariant);
productRouter.patch("/:productId/variants/:variantId/activate", ...canUpdate, activateVariant);
productRouter.delete("/:productId/variants/:variantId", ...canUpdate, removeVariant);

export default productRouter;
