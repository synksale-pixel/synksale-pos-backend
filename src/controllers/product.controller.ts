/**
 * Purpose: Product Controller.
 * Handlers for the catalog: listing/searching, barcode/SKU lookup, reading, creating, updating,
 * (de)activating and deleting products, and managing the variants of variant items.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import {
  listProducts,
  lookupProduct,
  getProduct,
  createProduct,
  updateProduct,
  setProductActive,
  deleteProduct,
  addVariant,
  updateVariant,
  setVariantActive,
  deleteVariant,
} from "../services/product.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "manage products");

/** A single query-string value; repeated or nested parameters are ignored. */
const queryString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const queryNumber = (value: unknown): number | undefined => {
  const text = queryString(value);
  return text !== undefined && text.trim() !== "" ? Number(text) : undefined;
};

export const list = asyncHandler(async (req: Request, res: Response) => {
  const type = queryString(req.query.type);
  const isActive = queryString(req.query.isActive);
  const result = await listProducts(resolveOrganizationId(req), {
    search: queryString(req.query.search),
    categoryId: queryString(req.query.categoryId),
    type: type === "goods" || type === "service" ? type : undefined,
    isActive: isActive === "true" ? true : isActive === "false" ? false : undefined,
    tag: queryString(req.query.tag),
    page: queryNumber(req.query.page),
    limit: queryNumber(req.query.limit),
  });
  res.status(200).json(new ApiResponse(200, result, "Products fetched successfully."));
});

export const lookup = asyncHandler(async (req: Request, res: Response) => {
  const result = await lookupProduct(resolveOrganizationId(req), queryString(req.query.code) ?? "");
  res.status(200).json(new ApiResponse(200, result, "Product found."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const product = await getProduct(resolveOrganizationId(req), req.params.productId as string);
  res.status(200).json(new ApiResponse(200, { product }, "Product fetched successfully."));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const product = await createProduct(resolveOrganizationId(req), req.body, req.user!._id.toString());
  res.status(201).json(new ApiResponse(201, { product }, "Product created successfully."));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const product = await updateProduct(
    resolveOrganizationId(req),
    req.params.productId as string,
    req.body,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { product }, "Product updated successfully."));
});

export const deactivate = asyncHandler(async (req: Request, res: Response) => {
  const product = await setProductActive(
    resolveOrganizationId(req),
    req.params.productId as string,
    false,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { product }, "Product deactivated successfully."));
});

export const activate = asyncHandler(async (req: Request, res: Response) => {
  const product = await setProductActive(
    resolveOrganizationId(req),
    req.params.productId as string,
    true,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { product }, "Product activated successfully."));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await deleteProduct(resolveOrganizationId(req), req.params.productId as string, req.user!._id.toString());
  res.status(200).json(new ApiResponse(200, null, "Product deleted successfully."));
});

export const createVariant = asyncHandler(async (req: Request, res: Response) => {
  const product = await addVariant(
    resolveOrganizationId(req),
    req.params.productId as string,
    req.body,
    req.user!._id.toString()
  );
  res.status(201).json(new ApiResponse(201, { product }, "Variant added successfully."));
});

export const editVariant = asyncHandler(async (req: Request, res: Response) => {
  const product = await updateVariant(
    resolveOrganizationId(req),
    req.params.productId as string,
    req.params.variantId as string,
    req.body,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { product }, "Variant updated successfully."));
});

export const deactivateVariant = asyncHandler(async (req: Request, res: Response) => {
  const product = await setVariantActive(
    resolveOrganizationId(req),
    req.params.productId as string,
    req.params.variantId as string,
    false,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { product }, "Variant deactivated successfully."));
});

export const activateVariant = asyncHandler(async (req: Request, res: Response) => {
  const product = await setVariantActive(
    resolveOrganizationId(req),
    req.params.productId as string,
    req.params.variantId as string,
    true,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { product }, "Variant activated successfully."));
});

export const removeVariant = asyncHandler(async (req: Request, res: Response) => {
  const product = await deleteVariant(
    resolveOrganizationId(req),
    req.params.productId as string,
    req.params.variantId as string,
    req.user!._id.toString()
  );
  res.status(200).json(new ApiResponse(200, { product }, "Variant deleted successfully."));
});
