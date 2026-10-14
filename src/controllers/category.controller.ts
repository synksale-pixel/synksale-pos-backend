/**
 * Purpose: Category Controller.
 * Handlers for listing, reading, creating, updating and deleting the organization's categories.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import {
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
} from "../services/category.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "manage categories");

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await listCategories(resolveOrganizationId(req));
  res.status(200).json(new ApiResponse(200, result, "Categories fetched successfully."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const category = await getCategory(resolveOrganizationId(req), req.params.categoryId as string);
  res.status(200).json(new ApiResponse(200, { category }, "Category fetched successfully."));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const category = await createCategory(resolveOrganizationId(req), req.body, req.user!._id.toString());
  res.status(201).json(new ApiResponse(201, { category }, "Category created successfully."));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const category = await updateCategory(
    resolveOrganizationId(req),
    req.params.categoryId as string,
    req.body,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { category }, "Category updated successfully."));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await deleteCategory(resolveOrganizationId(req), req.params.categoryId as string, req.user!._id.toString());
  res.status(200).json(new ApiResponse(200, null, "Category deleted successfully."));
});
