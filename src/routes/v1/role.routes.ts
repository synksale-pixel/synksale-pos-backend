/**
 * Purpose: Role Routes.
 * Reading the organization's roles, and managing custom ones.
 *
 * READS are gated on `user:read`, not `role:manage`: anyone who can invite or view staff needs
 * the role list to resolve a roleId, and store managers hold `user:invite` without
 * `role:manage`. Reading your own organization's role names is low-sensitivity.
 *
 * WRITES are gated on `role:manage` AND an organization-level role — defining what permissions
 * exist in the organization is not a per-store decision.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import {
  authenticate,
  requireOrganizationRole,
  authorizeAnyScope,
} from "../../middleware/rbac.middleware";
import {
  createRoleSchema,
  updateRoleSchema,
} from "../../validators/role.validator";
import {
  list,
  getOne,
  create,
  update,
  remove,
  permissions,
} from "../../controllers/role.controller";

const roleRouter = Router();

roleRouter.use(authenticate);

// ---------------------------------------------------------------
// Reads
// ---------------------------------------------------------------

// authorizeAnyScope, not authorize: a store manager holds `user:read` through their store role,
// and these routes carry no storeId for that store role to be resolved against.
roleRouter.get("/", authorizeAnyScope("user:read"), list);

// Static path, registered before /:roleId so it is not swallowed by the param route.
roleRouter.get("/permissions", authorizeAnyScope("user:read"), permissions);

roleRouter.get("/:roleId", authorizeAnyScope("user:read"), getOne);

// ---------------------------------------------------------------
// Writes
// ---------------------------------------------------------------

roleRouter.post(
  "/",
  requireOrganizationRole,
  authorizeAnyScope("role:manage"),
  validateRequest(createRoleSchema),
  create
);

roleRouter.patch(
  "/:roleId",
  requireOrganizationRole,
  authorizeAnyScope("role:manage"),
  validateRequest(updateRoleSchema),
  update
);

roleRouter.delete(
  "/:roleId",
  requireOrganizationRole,
  authorizeAnyScope("role:manage"),
  remove
);

export default roleRouter;
