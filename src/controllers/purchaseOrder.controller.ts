/**
 * Purpose: Purchase Order Controller.
 * Handlers for the store's purchase orders and the cross-store list. Creating a PO runs through
 * runIdempotent, so a retried request replays its first response.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import { deletePurchaseOrderQuerySchema } from "../validators/purchaseOrder.validator";
import { sendIdempotent } from "./stock.controller";
import {
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
  issuePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  ListPurchaseOrdersQuery,
} from "../services/purchaseOrder.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "manage purchase orders");

/** The store of the URL, lower-cased to match the ids the tenant scope compares (see scopeToStore). */
const storeParam = (req: Request): string => (req.params.storeId as string).toLowerCase();

const poParam = (req: Request): string => req.params.purchaseOrderId as string;

/** A single query-string value; repeated or nested parameters are ignored. */
const queryString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const queryNumber = (value: unknown): number | undefined => {
  const text = queryString(value);
  return text !== undefined && text.trim() !== "" ? Number(text) : undefined;
};

const listQuery = (req: Request): ListPurchaseOrdersQuery => ({
  search: queryString(req.query.search),
  vendorId: queryString(req.query.vendorId),
  status: queryString(req.query.status),
  from: queryString(req.query.from),
  to: queryString(req.query.to),
  page: queryNumber(req.query.page),
  limit: queryNumber(req.query.limit),
});

const sendPo = (res: Response, status: number, purchaseOrder: unknown, message: string) =>
  res.status(status).json(new ApiResponse(status, { purchaseOrder }, message));

export const listAll = asyncHandler(async (req: Request, res: Response) => {
  const result = await listPurchaseOrders(
    resolveOrganizationId(req),
    { user: req.user! },
    { ...listQuery(req), storeId: queryString(req.query.storeId) }
  );
  res.status(200).json(new ApiResponse(200, result, "Purchase orders fetched successfully."));
});

export const listForStore = asyncHandler(async (req: Request, res: Response) => {
  const result = await listPurchaseOrders(resolveOrganizationId(req), { storeId: storeParam(req) }, listQuery(req));
  res.status(200).json(new ApiResponse(200, result, "Purchase orders fetched successfully."));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const po = await getPurchaseOrder(resolveOrganizationId(req), storeParam(req), poParam(req));
  sendPo(res, 200, po, "Purchase order fetched successfully.");
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  const storeId = storeParam(req);
  await sendIdempotent(req, res, "Purchase order created successfully.", async (session) => ({
    purchaseOrder: await createPurchaseOrder(organizationId, storeId, req.body, req.user!._id.toString(), session),
  }));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const po = await updatePurchaseOrder(resolveOrganizationId(req), storeParam(req), poParam(req), req.body, req.user!._id.toString());
  sendPo(res, 200, po, "Purchase order updated successfully.");
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  // DELETE has no body, so the version comes from the query string (a ZodError becomes a 400).
  const { version } = deletePurchaseOrderQuerySchema.parse({ version: queryString(req.query.version) });
  await deletePurchaseOrder(resolveOrganizationId(req), storeParam(req), poParam(req), version, req.user!._id.toString());
  res.status(200).json(new ApiResponse(200, null, "Purchase order deleted successfully."));
});

export const issue = asyncHandler(async (req: Request, res: Response) => {
  const po = await issuePurchaseOrder(resolveOrganizationId(req), storeParam(req), poParam(req), req.body.version, req.user!._id.toString());
  sendPo(res, 200, po, "Purchase order issued successfully.");
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const po = await cancelPurchaseOrder(resolveOrganizationId(req), storeParam(req), poParam(req), req.body, req.user!._id.toString());
  sendPo(res, 200, po, "Purchase order cancelled successfully.");
});

export const close = asyncHandler(async (req: Request, res: Response) => {
  const po = await closePurchaseOrder(resolveOrganizationId(req), storeParam(req), poParam(req), req.body, req.user!._id.toString());
  sendPo(res, 200, po, "Purchase order closed successfully.");
});
