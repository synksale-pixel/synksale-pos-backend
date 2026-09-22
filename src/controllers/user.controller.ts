/**
 * Purpose: User (staff) Management Controller.
 * Handlers for reading the organization roster and changing an existing user's access.
 *
 * Query parameters are parsed leniently here (matching the store endpoints): invalid values
 * fall back to defaults rather than erroring, so a stale bookmark never 400s.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import {
  listUsers,
  getUser,
  setUserOrgRole,
  grantStoreAccess,
  updateStoreAccess,
  revokeStoreAccess,
  setUserActive,
  resendInvite,
  revokeInvite,
  ListUsersInput,
} from "../services/user.service";

const resolveOrganizationId = (req: Request): string =>
  resolveOrgId(req, "manage staff");

const actorId = (req: Request): string => req.user!._id.toString();

export const list = asyncHandler(async (req: Request, res: Response) => {
  const status = req.query.status as ListUsersInput["status"];

  const result = await listUsers(resolveOrganizationId(req), req.user!, {
    page: req.query.page ? Number(req.query.page) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    q: req.query.q ? String(req.query.q) : undefined,
    storeId: req.query.storeId ? String(req.query.storeId) : undefined,
    roleId: req.query.roleId ? String(req.query.roleId) : undefined,
    status:
      status === "active" || status === "inactive" || status === "pending"
        ? status
        : undefined,
  });

  res.status(200).json(new ApiResponse(200, result, "Users fetched successfully."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const user = await getUser(
    resolveOrganizationId(req),
    req.user!,
    req.params.userId as string
  );
  res.status(200).json(new ApiResponse(200, { user }, "User fetched successfully."));
});

export const setOrgRole = asyncHandler(async (req: Request, res: Response) => {
  const user = await setUserOrgRole(
    resolveOrganizationId(req),
    req.user!,
    req.params.userId as string,
    req.body.roleId,
    actorId(req)
  );
  res
    .status(200)
    .json(new ApiResponse(200, { user }, "Organization role updated successfully."));
});

export const grantStore = asyncHandler(async (req: Request, res: Response) => {
  const user = await grantStoreAccess(
    resolveOrganizationId(req),
    req.user!,
    req.params.userId as string,
    req.body.storeId,
    req.body.roleId,
    actorId(req)
  );
  res
    .status(201)
    .json(new ApiResponse(201, { user }, "Store access granted successfully."));
});

export const updateStore = asyncHandler(async (req: Request, res: Response) => {
  const user = await updateStoreAccess(
    resolveOrganizationId(req),
    req.user!,
    req.params.userId as string,
    req.params.storeId as string,
    req.body.roleId,
    actorId(req)
  );
  res
    .status(200)
    .json(new ApiResponse(200, { user }, "Store access updated successfully."));
});

export const revokeStore = asyncHandler(async (req: Request, res: Response) => {
  const user = await revokeStoreAccess(
    resolveOrganizationId(req),
    req.user!,
    req.params.userId as string,
    req.params.storeId as string,
    actorId(req)
  );
  res
    .status(200)
    .json(new ApiResponse(200, { user }, "Store access revoked successfully."));
});

export const deactivate = asyncHandler(async (req: Request, res: Response) => {
  const user = await setUserActive(
    resolveOrganizationId(req),
    req.user!,
    req.params.userId as string,
    false,
    actorId(req)
  );
  res.status(200).json(new ApiResponse(200, { user }, "User deactivated successfully."));
});

export const activate = asyncHandler(async (req: Request, res: Response) => {
  const user = await setUserActive(
    resolveOrganizationId(req),
    req.user!,
    req.params.userId as string,
    true,
    actorId(req)
  );
  res.status(200).json(new ApiResponse(200, { user }, "User activated successfully."));
});

export const resend = asyncHandler(async (req: Request, res: Response) => {
  const result = await resendInvite(
    resolveOrganizationId(req),
    req.user!,
    req.params.userId as string,
    actorId(req)
  );
  res.status(200).json(new ApiResponse(200, result, "Invitation resent successfully."));
});

export const revoke = asyncHandler(async (req: Request, res: Response) => {
  await revokeInvite(
    resolveOrganizationId(req),
    req.user!,
    req.params.userId as string,
    actorId(req)
  );
  res.status(200).json(new ApiResponse(200, null, "Invitation revoked successfully."));
});
