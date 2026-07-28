/**
 * Purpose: User Invitation Routes.
 * Defines the endpoint for inviting organization staff members (protected)
 * and the endpoint for accepting staff invitations (public).
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import {
  authenticate,
  scopeToStore,
  authorize,
} from "../../middleware/rbac.middleware";
import {
  inviteSchema,
  acceptInviteSchema,
} from "../../validators/userInvite.validator";
import { invite, accept } from "../../controllers/userInvite.controller";

const userInviteRouter = Router();

// Protected: Invite user to organization (requires 'user:invite' permission)
// scopeToStore runs BEFORE authorize so that the target store ID context is parsed and checked.
userInviteRouter.post(
  "/invite",
  authenticate,
  scopeToStore,
  authorize("user:invite"),
  validateRequest(inviteSchema),
  invite
);

// Public: Accept invitation and activate account
userInviteRouter.post(
  "/accept-invite",
  validateRequest(acceptInviteSchema),
  accept
);

export default userInviteRouter;
