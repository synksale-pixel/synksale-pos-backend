/**
 * Purpose: Role Routes (read side).
 * Lets a client resolve role IDs for the invite and staffing endpoints.
 *
 * GATED ON `user:read`, NOT `user:manage_roles`: anyone who can invite or view staff needs to
 * see the role list, and store managers hold `user:invite` without `user:manage_roles`.
 * Reading your own organization's role names is low-sensitivity; assigning them is not, and
 * that is still gated separately on the endpoints that do the assigning.
 */

import { Router } from "express";
import { authenticate, authorizeAnyScope } from "../../middleware/rbac.middleware";
import { list, permissions } from "../../controllers/role.controller";

const roleRouter = Router();

roleRouter.use(authenticate);

// authorizeAnyScope, not authorize: a store manager holds `user:read` through their store role,
// and this route carries no storeId for the store role to be resolved against.
roleRouter.get("/", authorizeAnyScope("user:read"), list);

// The static permission catalog, for labelling permission keys in a role editor.
roleRouter.get("/permissions", authorizeAnyScope("user:read"), permissions);

export default roleRouter;
