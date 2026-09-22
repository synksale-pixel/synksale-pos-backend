/**
 * Purpose: Role Controller (read side).
 * Exposes the organization's roles so a client can resolve a roleId for the invite and
 * staffing endpoints, plus the static permission catalog for labelling permission keys.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import { listRoles, listPermissionCatalog } from "../services/role.service";

export const list = asyncHandler(async (req: Request, res: Response) => {
  const scope = req.query.scope;
  const roles = await listRoles(resolveOrgId(req, "view roles"), {
    scope: scope === "organization" || scope === "store" ? scope : undefined,
  });

  res.status(200).json(new ApiResponse(200, { roles }, "Roles fetched successfully."));
});

export const permissions = asyncHandler(async (_req: Request, res: Response) => {
  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { permissions: listPermissionCatalog() },
        "Permission catalog fetched successfully."
      )
    );
});
