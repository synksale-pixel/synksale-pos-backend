/**
 * Purpose: Stock Controller.
 * Handlers for stock levels, the movement history, adjustments and transfers. Adjustments and
 * transfers run through runIdempotent, so a retried request replays its first response.
 */

import { Request, Response } from "express";
import type { ClientSession } from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import { getEffectivePermissions } from "../services/permission.service";
import { runIdempotent } from "../services/idempotency.service";
import {
  listStoreStock,
  getProductStock,
  listMovements,
  createAdjustment,
  listAdjustments,
  getAdjustment,
  createTransfer,
  listTransfers,
  getTransfer,
} from "../services/stock.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "manage stock");

/** The store of the URL, lower-cased to match the ids the tenant scope compares (see scopeToStore). */
const storeParam = (req: Request): string => (req.params.storeId as string).toLowerCase();

/** A single query-string value; repeated or nested parameters are ignored. */
const queryString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const queryNumber = (value: unknown): number | undefined => {
  const text = queryString(value);
  return text !== undefined && text.trim() !== "" ? Number(text) : undefined;
};

const paging = (req: Request) => ({
  from: queryString(req.query.from),
  to: queryString(req.query.to),
  page: queryNumber(req.query.page),
  limit: queryNumber(req.query.limit),
});

/** Sends a stock write through the idempotency record and replays a retried request. */
async function sendIdempotent(
  req: Request,
  res: Response,
  message: string,
  work: (session: ClientSession) => Promise<unknown>
) {
  const result = await runIdempotent(
    {
      organizationId: resolveOrganizationId(req),
      key: req.idempotencyKey!,
      userId: req.user!._id.toString(),
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      body: req.body,
    },
    201,
    async (session) => new ApiResponse(201, await work(session), message)
  );
  if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
  res.status(result.statusCode).json(result.body);
}

/** Stock costs (average cost, stock value) need inventory:read for the store. */
async function canSeeCost(req: Request, storeId: string): Promise<boolean> {
  const permissions = await getEffectivePermissions(req.user!, storeId);
  return permissions.includes("*") || permissions.includes("inventory:read");
}

export const storeStock = asyncHandler(async (req: Request, res: Response) => {
  const storeId = storeParam(req);
  const showCost = await canSeeCost(req, storeId);
  const status = queryString(req.query.status);
  const result = await listStoreStock(
    resolveOrganizationId(req),
    storeId,
    {
      search: queryString(req.query.search),
      categoryId: queryString(req.query.categoryId),
      includeSubcategories: queryString(req.query.includeSubcategories) !== "false",
      status,
      includeInactive: queryString(req.query.includeInactive) === "true",
      page: queryNumber(req.query.page),
      limit: queryNumber(req.query.limit),
    },
    showCost
  );
  res.status(200).json(new ApiResponse(200, result, "Stock fetched successfully."));
});

export const productStock = asyncHandler(async (req: Request, res: Response) => {
  const result = await getProductStock(resolveOrganizationId(req), req.params.productId as string, req.user!);
  res.status(200).json(new ApiResponse(200, result, "Stock fetched successfully."));
});

export const movements = asyncHandler(async (req: Request, res: Response) => {
  const result = await listMovements(resolveOrganizationId(req), storeParam(req), {
    ...paging(req),
    productId: queryString(req.query.productId),
    variantId: queryString(req.query.variantId),
    type: queryString(req.query.type),
  });
  res.status(200).json(new ApiResponse(200, result, "Stock movements fetched successfully."));
});

export const adjust = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  const storeId = storeParam(req);
  const showCost = await canSeeCost(req, storeId);
  await sendIdempotent(req, res, "Stock adjusted successfully.", async (session) => ({
    adjustment: await createAdjustment(organizationId, storeId, req.body, req.user!._id.toString(), session, showCost),
  }));
});

export const adjustments = asyncHandler(async (req: Request, res: Response) => {
  const result = await listAdjustments(resolveOrganizationId(req), storeParam(req), {
    ...paging(req),
    reason: queryString(req.query.reason),
  });
  res.status(200).json(new ApiResponse(200, result, "Stock adjustments fetched successfully."));
});

export const adjustment = asyncHandler(async (req: Request, res: Response) => {
  const result = await getAdjustment(
    resolveOrganizationId(req),
    storeParam(req),
    req.params.adjustmentId as string
  );
  res.status(200).json(new ApiResponse(200, { adjustment: result }, "Stock adjustment fetched successfully."));
});

export const transfer = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  await sendIdempotent(req, res, "Stock transferred successfully.", async (session) => ({
    transfer: await createTransfer(organizationId, req.body, req.user!._id.toString(), session),
  }));
});

export const transfers = asyncHandler(async (req: Request, res: Response) => {
  const result = await listTransfers(resolveOrganizationId(req), req.user!, {
    ...paging(req),
    storeId: queryString(req.query.storeId),
  });
  res.status(200).json(new ApiResponse(200, result, "Stock transfers fetched successfully."));
});

export const transferDetail = asyncHandler(async (req: Request, res: Response) => {
  const result = await getTransfer(resolveOrganizationId(req), req.user!, req.params.transferId as string);
  res.status(200).json(new ApiResponse(200, { transfer: result }, "Stock transfer fetched successfully."));
});
