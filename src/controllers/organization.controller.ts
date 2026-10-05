/**
 * Purpose: Organization Controller (tenant side).
 * Handlers for reading and updating the caller's own organization.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import { getOrganizationProfile, updateOrganization } from "../services/organization.service";

const resolveOrganizationId = (req: Request): string =>
  resolveOrgId(req, "view or configure it");

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const organization = await getOrganizationProfile(resolveOrganizationId(req));
  res.status(200).json(new ApiResponse(200, { organization }, "Organization fetched successfully."));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const organization = await updateOrganization(
    resolveOrganizationId(req),
    req.body,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { organization }, "Organization updated successfully."));
});
