/**
 * Purpose: Role Controller.
 * Reading the organization's roles (so a client can resolve a roleId for the invite and
 * staffing endpoints) and managing custom roles.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import {
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  listPermissionCatalog,
  RoleActor,
} from "../services/role.service";
import {
  getPermissionsAcrossStores,
  resolveUserScope,
} from "../services/permission.service";

const resolveOrganizationId = (req: Request): string =>
  resolveOrgId(req, "manage roles");

/**
 * Resolves the acting user's ceiling once per request.
 * Permissions are read across every store the caller works at, since a role is not tied to a
 * particular store — the question is "what do you hold anywhere", not "what do you hold here".
 */
async function resolveActor(req: Request): Promise<RoleActor> {
  const user = req.user!;
  return {
    permissions: await getPermissionsAcrossStores(user),
    scope: await resolveUserScope(user),
    userId: user._id.toString(),
  };
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const scope = req.query.scope;
  const roles = await listRoles(resolveOrganizationId(req), {
    scope: scope === "organization" || scope === "store" ? scope : undefined,
  });

  res.status(200).json(new ApiResponse(200, { roles }, "Roles fetched successfully."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const role = await getRole(resolveOrganizationId(req), req.params.roleId as string);
  res.status(200).json(new ApiResponse(200, { role }, "Role fetched successfully."));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const role = await createRole(
    resolveOrganizationId(req),
    await resolveActor(req),
    req.body
  );
  res.status(201).json(new ApiResponse(201, { role }, "Role created successfully."));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const role = await updateRole(
    resolveOrganizationId(req),
    await resolveActor(req),
    req.params.roleId as string,
    req.body
  );
  res.status(200).json(new ApiResponse(200, { role }, "Role updated successfully."));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await deleteRole(
    resolveOrganizationId(req),
    await resolveActor(req),
    req.params.roleId as string
  );
  res.status(200).json(new ApiResponse(200, null, "Role deleted successfully."));
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
