/**
 * Purpose: Vendor Controller.
 * Handlers for listing, reading, creating, updating and deleting the organization's vendors.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import { listVendors, getVendor, createVendor, updateVendor, deleteVendor } from "../services/vendor.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "manage vendors");

/** A single query-string value; repeated or nested parameters are ignored. */
const queryString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const queryNumber = (value: unknown): number | undefined => {
  const text = queryString(value);
  return text !== undefined && text.trim() !== "" ? Number(text) : undefined;
};

export const list = asyncHandler(async (req: Request, res: Response) => {
  const isActive = queryString(req.query.isActive);
  const result = await listVendors(resolveOrganizationId(req), {
    search: queryString(req.query.search),
    isActive: isActive === "true" ? true : isActive === "false" ? false : undefined,
    countryCode: queryString(req.query.countryCode),
    vatTreatment: queryString(req.query.vatTreatment),
    page: queryNumber(req.query.page),
    limit: queryNumber(req.query.limit),
  });
  res.status(200).json(new ApiResponse(200, result, "Vendors fetched successfully."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const vendor = await getVendor(resolveOrganizationId(req), req.params.vendorId as string);
  res.status(200).json(new ApiResponse(200, { vendor }, "Vendor fetched successfully."));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const vendor = await createVendor(resolveOrganizationId(req), req.body, req.user!._id.toString());
  res.status(201).json(new ApiResponse(201, { vendor }, "Vendor created successfully."));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const vendor = await updateVendor(resolveOrganizationId(req), req.params.vendorId as string, req.body, req.user!._id.toString());
  res.status(200).json(new ApiResponse(200, { vendor }, "Vendor updated successfully."));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await deleteVendor(resolveOrganizationId(req), req.params.vendorId as string, req.user!._id.toString());
  res.status(200).json(new ApiResponse(200, null, "Vendor deleted successfully."));
});
