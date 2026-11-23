/**
 * Purpose: Register Controller (Phase 4a-2).
 * Handlers for a store's registers. scopeToStore has verified the store before these run.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import {
  listRegisters,
  getRegister,
  createRegister,
  updateRegister,
  deleteRegister,
} from "../services/register.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "manage registers");

const storeIdOf = (req: Request) => (req.params.storeId as string).toLowerCase();

export const list = asyncHandler(async (req: Request, res: Response) => {
  const isActive = typeof req.query.isActive === "string" ? req.query.isActive : undefined;
  const result = await listRegisters(resolveOrganizationId(req), storeIdOf(req), {
    isActive: isActive === "true" ? true : isActive === "false" ? false : undefined,
  });
  res.status(200).json(new ApiResponse(200, result, "Registers fetched successfully."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const register = await getRegister(resolveOrganizationId(req), storeIdOf(req), req.params.registerId as string);
  res.status(200).json(new ApiResponse(200, { register }, "Register fetched successfully."));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const register = await createRegister(resolveOrganizationId(req), storeIdOf(req), req.body, req.user!._id.toString());
  res.status(201).json(new ApiResponse(201, { register }, "Register created successfully."));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const register = await updateRegister(
    resolveOrganizationId(req),
    storeIdOf(req),
    req.params.registerId as string,
    req.body,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { register }, "Register updated successfully."));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await deleteRegister(resolveOrganizationId(req), storeIdOf(req), req.params.registerId as string, req.user!._id.toString());
  res.status(200).json(new ApiResponse(200, null, "Register deleted successfully."));
});
