/**
 * Purpose: User Invitation Controller.
 * Handles endpoints for inviting organization staff members (protected)
 * and accepting staff invitations to activate their accounts (public).
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { inviteUser, acceptInvite } from "../services/userInvite.service";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId } from "../utils/requestOrganization";

/**
 * Invite User:
 * Creates a pending user invitation. Resolves context and delegates privilege check to service.
 * Plaintext invite link is returned in the response payload.
 */
export const invite = asyncHandler(async (req: Request, res: Response) => {
  const invitingUser = req.user!;
  const organizationId = resolveOrganizationId(req, "invite users");

  const { email, firstName, lastName, roleId, storeId } = req.body;

  const result = await inviteUser({
    organizationId,
    storeId,
    email,
    firstName,
    lastName,
    roleId,
    invitedByUserId: invitingUser._id.toString(),
  });

  // TODO: integrate an email service. Until then the invite link is returned in the response
  // OUTSIDE production only (see buildInviteDelivery); in production `delivery` comes back as
  // "email_pending" and the invitee cannot be reached, so this is a launch blocker.

  res.status(201).json(
    new ApiResponse(
      201,
      result,
      "User invitation created successfully."
    )
  );
});

/**
 * Accept Invite:
 * Completes the onboarding flow. Sets the user's password, activates their account,
 * and automatically logs them in by issuing session tokens.
 */
export const accept = asyncHandler(async (req: Request, res: Response) => {
  const { token, password } = req.body;
  const ipAddress = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  const result = await acceptInvite({
    token,
    password,
    ipAddress: String(ipAddress),
    userAgent: req.headers["user-agent"],
  });

  res.status(200).json(
    new ApiResponse(
      200,
      result,
      "Invitation accepted and account activated successfully."
    )
  );
});
