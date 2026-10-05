/**
 * Purpose: Tax Rate Controller.
 * Handlers for listing, reading, creating, updating, defaulting, (de)activating and deleting
 * the organization's tax rates.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import {
  listTaxRates,
  getTaxRate,
  createTaxRate,
  updateTaxRate,
  setDefaultTaxRate,
  setTaxRateActive,
  deleteTaxRate,
} from "../services/taxRate.service";

const resolveOrganizationId = (req: Request): string =>
  resolveOrgId(req, "manage tax rates");

export const list = asyncHandler(async (req: Request, res: Response) => {
  const isActive =
    req.query.isActive === "true" ? true : req.query.isActive === "false" ? false : undefined;
  const result = await listTaxRates(resolveOrganizationId(req), { isActive });
  res.status(200).json(new ApiResponse(200, result, "Tax rates fetched successfully."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const taxRate = await getTaxRate(resolveOrganizationId(req), req.params.taxRateId as string);
  res.status(200).json(new ApiResponse(200, { taxRate }, "Tax rate fetched successfully."));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const taxRate = await createTaxRate(
    resolveOrganizationId(req),
    req.body,
    req.user!._id.toString()
  );
  res.status(201).json(new ApiResponse(201, { taxRate }, "Tax rate created successfully."));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const taxRate = await updateTaxRate(
    resolveOrganizationId(req),
    req.params.taxRateId as string,
    req.body,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { taxRate }, "Tax rate updated successfully."));
});

export const makeDefault = asyncHandler(async (req: Request, res: Response) => {
  const taxRate = await setDefaultTaxRate(
    resolveOrganizationId(req),
    req.params.taxRateId as string,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { taxRate }, "Default tax rate updated successfully."));
});

export const deactivate = asyncHandler(async (req: Request, res: Response) => {
  const taxRate = await setTaxRateActive(
    resolveOrganizationId(req),
    req.params.taxRateId as string,
    false,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { taxRate }, "Tax rate deactivated successfully."));
});

export const activate = asyncHandler(async (req: Request, res: Response) => {
  const taxRate = await setTaxRateActive(
    resolveOrganizationId(req),
    req.params.taxRateId as string,
    true,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { taxRate }, "Tax rate activated successfully."));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await deleteTaxRate(
    resolveOrganizationId(req),
    req.params.taxRateId as string,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, null, "Tax rate deleted successfully."));
});
