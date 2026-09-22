/**
 * Purpose: User (staff) Routes.
 * The whole lifecycle of a staff member on one router: invite, accept, read the roster, and
 * change an existing user's access.
 *
 * WHY ONE ROUTER: invites and user management share the `/users` prefix, and two routers
 * mounted on the same prefix with overlapping path shapes (`/invite` vs `/:userId`) is a
 * routing footgun. Static paths are registered before the `/:userId` routes below.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import {
  authenticate,
  scopeToStore,
  scopeToStoreAllowInactive,
  requireOrganizationRole,
  authorize,
  authorizeAnyScope,
} from "../../middleware/rbac.middleware";
import {
  inviteSchema,
  acceptInviteSchema,
} from "../../validators/userInvite.validator";
import {
  setOrgRoleSchema,
  grantStoreAccessSchema,
  updateStoreAccessSchema,
} from "../../validators/user.validator";
import { invite, accept } from "../../controllers/userInvite.controller";
import {
  list,
  getOne,
  setOrgRole,
  grantStore,
  updateStore,
  revokeStore,
  deactivate,
  activate,
  resend,
  revoke,
} from "../../controllers/user.controller";

const userRouter = Router();

// ---------------------------------------------------------------
// Public
// ---------------------------------------------------------------

// Accept an invitation and activate the account. Registered BEFORE the authenticate
// middleware below, which is what keeps it public.
userRouter.post("/accept-invite", validateRequest(acceptInviteSchema), accept);

// ---------------------------------------------------------------
// Everything below this line requires a tenant access token.
// ---------------------------------------------------------------
userRouter.use(authenticate);

// Invite a new staff member. scopeToStore runs BEFORE authorize so the target store is
// validated and enters the request context first.
userRouter.post(
  "/invite",
  scopeToStore,
  authorize("user:invite"),
  validateRequest(inviteSchema),
  invite
);

// Roster. These routes carry no storeId, so they use authorizeAnyScope: a store manager holds
// `user:read` through their store role and would otherwise be rejected before the service ever
// runs. The service then narrows the result — organization-scoped roles see everyone, while
// store-scoped staff see only users who share one of their stores.
userRouter.get("/", authorizeAnyScope("user:read"), list);
userRouter.get("/:userId", authorizeAnyScope("user:read"), getOne);

// Organization-wide role. Organization-level action, so store-scoped staff are excluded
// even if their store role were to carry `user:manage_roles`.
userRouter.patch(
  "/:userId/org-role",
  requireOrganizationRole,
  authorize("user:manage_roles"),
  validateRequest(setOrgRoleSchema),
  setOrgRole
);

// Store assignments.
// Granting uses scopeToStore (never assign anyone to a deactivated store), while updating and
// revoking use scopeToStoreAllowInactive — staff must always be movable OFF a closed store.
userRouter.post(
  "/:userId/store-access",
  validateRequest(grantStoreAccessSchema),
  scopeToStore,
  authorize("user:manage_roles"),
  grantStore
);
userRouter.patch(
  "/:userId/store-access/:storeId",
  scopeToStoreAllowInactive,
  authorize("user:manage_roles"),
  validateRequest(updateStoreAccessSchema),
  updateStore
);
userRouter.delete(
  "/:userId/store-access/:storeId",
  scopeToStoreAllowInactive,
  authorize("user:manage_roles"),
  revokeStore
);

// Activation. The only removal path for a user who has accepted their invitation.
userRouter.patch(
  "/:userId/deactivate",
  requireOrganizationRole,
  authorize("user:manage"),
  deactivate
);
userRouter.patch(
  "/:userId/activate",
  requireOrganizationRole,
  authorize("user:manage"),
  activate
);

// Pending invite lifecycle. Store-agnostic (the invitee's store is not in the path), so the
// permission is checked across the caller's stores and the service enforces that a store-scoped
// caller can only reach an invitee who shares one of their stores.
userRouter.post("/:userId/invite/resend", authorizeAnyScope("user:invite"), resend);
userRouter.delete("/:userId/invite", authorizeAnyScope("user:invite"), revoke);

export default userRouter;
