/**
 * Purpose: Goods Receipt Controller.
 * Handlers for the store's goods receipts and the cross-store list. Receiving runs through
 * runIdempotent, so a retried request replays its first response instead of adding stock twice.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import { getEffectivePermissions } from "../services/permission.service";
import { sendIdempotent } from "./stock.controller";
import { listGoodsReceipts, getGoodsReceipt, createGoodsReceipt, ListGoodsReceiptsQuery } from "../services/goodsReceipt.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "receive goods");

/** The store of the URL, lower-cased to match the ids the tenant scope compares (see scopeToStore). */
const storeParam = (req: Request): string => (req.params.storeId as string).toLowerCase();

/** A single query-string value; repeated or nested parameters are ignored. */
const queryString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const queryNumber = (value: unknown): number | undefined => {
  const text = queryString(value);
  return text !== undefined && text.trim() !== "" ? Number(text) : undefined;
};

const listQuery = (req: Request): ListGoodsReceiptsQuery => ({
  search: queryString(req.query.search),
  vendorId: queryString(req.query.vendorId),
  purchaseOrderId: queryString(req.query.purchaseOrderId),
  withoutPurchaseOrder: queryString(req.query.withoutPurchaseOrder),
  from: queryString(req.query.from),
  to: queryString(req.query.to),
  page: queryNumber(req.query.page),
  limit: queryNumber(req.query.limit),
});

/** Receiving without a PO, or at another cost, also needs purchase:order for this store. */
async function canOrder(req: Request, storeId: string): Promise<boolean> {
  const permissions = await getEffectivePermissions(req.user!, storeId);
  return permissions.includes("*") || permissions.includes("purchase:order");
}

export const listAll = asyncHandler(async (req: Request, res: Response) => {
  const result = await listGoodsReceipts(
    resolveOrganizationId(req),
    { user: req.user! },
    { ...listQuery(req), storeId: queryString(req.query.storeId) }
  );
  res.status(200).json(new ApiResponse(200, result, "Goods receipts fetched successfully."));
});

export const listForStore = asyncHandler(async (req: Request, res: Response) => {
  const result = await listGoodsReceipts(resolveOrganizationId(req), { storeId: storeParam(req) }, listQuery(req));
  res.status(200).json(new ApiResponse(200, result, "Goods receipts fetched successfully."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const result = await getGoodsReceipt(resolveOrganizationId(req), storeParam(req), req.params.goodsReceiptId as string);
  res.status(200).json(new ApiResponse(200, result, "Goods receipt fetched successfully."));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  const storeId = storeParam(req);
  const mayOrder = await canOrder(req, storeId);
  await sendIdempotent(req, res, "Goods received successfully.", (session) =>
    createGoodsReceipt(organizationId, storeId, req.body, req.user!._id.toString(), session, mayOrder)
  );
});
