/**
 * Purpose: Customer Controller (Phase 4a-2).
 * Handlers for listing, looking up, reading, creating, importing, updating and deleting the
 * organization's customers.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import {
  listCustomers,
  lookupCustomer,
  getCustomer,
  createCustomer,
  importCustomers,
  updateCustomer,
  deleteCustomer,
} from "../services/customer.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "manage customers");

/** A single query-string value; repeated or nested parameters are ignored. */
const queryString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const queryNumber = (value: unknown): number | undefined => {
  const text = queryString(value);
  return text !== undefined && text.trim() !== "" ? Number(text) : undefined;
};

const queryBoolean = (value: unknown): boolean | undefined => {
  const text = queryString(value);
  return text === "true" ? true : text === "false" ? false : undefined;
};

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await listCustomers(resolveOrganizationId(req), {
    search: queryString(req.query.search),
    isActive: queryBoolean(req.query.isActive),
    hasTaxRegistrationNumber: queryBoolean(req.query.hasTaxRegistrationNumber),
    page: queryNumber(req.query.page),
    limit: queryNumber(req.query.limit),
  });
  res.status(200).json(new ApiResponse(200, result, "Customers fetched successfully."));
});

export const lookup = asyncHandler(async (req: Request, res: Response) => {
  const result = await lookupCustomer(resolveOrganizationId(req), queryString(req.query.phone));
  res.status(200).json(new ApiResponse(200, result, "Customer lookup completed."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const customer = await getCustomer(resolveOrganizationId(req), req.params.customerId as string);
  res.status(200).json(new ApiResponse(200, { customer }, "Customer fetched successfully."));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const customer = await createCustomer(resolveOrganizationId(req), req.body, req.user!._id.toString());
  res.status(201).json(new ApiResponse(201, { customer }, "Customer created successfully."));
});

export const importMany = asyncHandler(async (req: Request, res: Response) => {
  const result = await importCustomers(resolveOrganizationId(req), req.body.rows, req.user!._id.toString());
  res.status(200).json(new ApiResponse(200, result, "Customer import processed."));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const customer = await updateCustomer(
    resolveOrganizationId(req),
    req.params.customerId as string,
    req.body,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { customer }, "Customer updated successfully."));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await deleteCustomer(resolveOrganizationId(req), req.params.customerId as string, req.user!._id.toString());
  res.status(200).json(new ApiResponse(200, null, "Customer deleted successfully."));
});
