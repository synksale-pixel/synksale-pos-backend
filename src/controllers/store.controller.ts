/**
 * Purpose: Store Controller.
 * Handlers for creating, listing, reading, updating and (de)activating stores.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import {
  createStore,
  listStores,
  getStore,
  updateStore,
  setStoreActive,
} from "../services/store.service";

const resolveOrganizationId = (req: Request): string =>
  resolveOrgId(req, "manage stores");

export const create = asyncHandler(async (req: Request, res: Response) => {
  const store = await createStore(
    resolveOrganizationId(req),
    req.body,
    req.user!._id.toString()
  );
  res.status(201).json(new ApiResponse(201, { store }, "Store created successfully."));
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const page = req.query.page ? Number(req.query.page) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const isActive =
    req.query.isActive === "true" ? true : req.query.isActive === "false" ? false : undefined;

  const result = await listStores(resolveOrganizationId(req), req.user!, { page, limit, isActive });
  res.status(200).json(new ApiResponse(200, result, "Stores fetched successfully."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const store = await getStore(resolveOrganizationId(req), req.params.storeId as string);
  res.status(200).json(new ApiResponse(200, { store }, "Store fetched successfully."));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const store = await updateStore(
    resolveOrganizationId(req),
    req.params.storeId as string,
    req.body,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { store }, "Store updated successfully."));
});

export const deactivate = asyncHandler(async (req: Request, res: Response) => {
  const store = await setStoreActive(
    resolveOrganizationId(req),
    req.params.storeId as string,
    false,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { store }, "Store deactivated successfully."));
});

export const activate = asyncHandler(async (req: Request, res: Response) => {
  const store = await setStoreActive(
    resolveOrganizationId(req),
    req.params.storeId as string,
    true,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { store }, "Store activated successfully."));
});
