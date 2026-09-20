/**
 * Purpose: Platform Organization Review Controller.
 * Handles Super Admin endpoints for listing, inspecting, approving, and rejecting
 * organization applications under the sales-assisted/gated onboarding model.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { logger } from "../config/logger.config";
import {
  listOrganizations,
  getOrganizationById,
  approveOrganization,
  rejectOrganization,
} from "../services/platformOrganization.service";

/**
 * List Organizations:
 * Returns a paginated list of organizations, optionally filtered by approvalStatus.
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const status = req.query.status as "pending" | "approved" | "rejected" | undefined;
  const page = req.query.page ? Number(req.query.page) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  const result = await listOrganizations({ status, page, limit });

  res
    .status(200)
    .json(new ApiResponse(200, result, "Organizations fetched successfully."));
});

/**
 * Get Organization By ID:
 * Returns full detail for a single organization application for review.
 */
export const getById = asyncHandler(async (req: Request, res: Response) => {
  const organization = await getOrganizationById(req.params.id);

  res
    .status(200)
    .json(new ApiResponse(200, organization, "Organization fetched successfully."));
});

/**
 * Approve Organization:
 * Grants the organization the ability to authenticate. Requires Super Admin authorization.
 */
export const approve = asyncHandler(async (req: Request, res: Response) => {
  const approvedByUserId = req.user!._id.toString();
  const organization = await approveOrganization(
    req.params.id,
    approvedByUserId,
    req.body?.slug
  );

  // TODO: promote this to a dedicated immutable AuditLog collection once the audit logging system is built — for now this relies on Winston file logs
  // TODO: trigger applicant notification once an email service is integrated
  logger.info(
    `[PLATFORM_ORG] Organization approved: ${organization._id} (${organization.slug}) by super admin: ${approvedByUserId}`
  );

  res
    .status(200)
    .json(new ApiResponse(200, organization, "Organization approved successfully."));
});

/**
 * Reject Organization:
 * Blocks the organization from authenticating until a future re-review approves it.
 */
export const reject = asyncHandler(async (req: Request, res: Response) => {
  const rejectedByUserId = req.user!._id.toString();
  const { reason } = req.body;
  const organization = await rejectOrganization(req.params.id, rejectedByUserId, reason);

  // TODO: promote this to a dedicated immutable AuditLog collection once the audit logging system is built — for now this relies on Winston file logs
  // TODO: trigger applicant notification once an email service is integrated
  logger.info(
    `[PLATFORM_ORG] Organization rejected: ${organization._id} (${organization.slug}) by super admin: ${rejectedByUserId} - Reason: ${reason}`
  );

  res
    .status(200)
    .json(new ApiResponse(200, organization, "Organization rejected successfully."));
});
