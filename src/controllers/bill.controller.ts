/**
 * Purpose: Vendor Bill and Vendor Payment Controller (Phase 3d).
 * Organization-level handlers: bills and payments have no store in the path. Creating and voiding
 * run through runIdempotent, so a retried request replays its first response instead of billing
 * or paying twice.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import { sendIdempotent } from "./stock.controller";
import { listBills, getBill, createBill, voidBill } from "../services/bill.service";
import {
  listVendorPayments,
  getVendorPayment,
  createVendorPayment,
  voidVendorPayment,
} from "../services/vendorPayment.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "manage vendor bills and payments");

/** A single query-string value; repeated or nested parameters are ignored. */
const queryString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const queryNumber = (value: unknown): number | undefined => {
  const text = queryString(value);
  return text !== undefined && text.trim() !== "" ? Number(text) : undefined;
};

// ---------- Bills ----------

export const listBillsHandler = asyncHandler(async (req: Request, res: Response) => {
  const q = req.query;
  const result = await listBills(resolveOrganizationId(req), {
    search: queryString(q.search),
    vendorId: queryString(q.vendorId),
    status: queryString(q.status),
    overdue: queryString(q.overdue),
    goodsReceiptId: queryString(q.goodsReceiptId),
    from: queryString(q.from),
    to: queryString(q.to),
    dueFrom: queryString(q.dueFrom),
    dueTo: queryString(q.dueTo),
    page: queryNumber(q.page),
    limit: queryNumber(q.limit),
  });
  res.status(200).json(new ApiResponse(200, result, "Bills fetched successfully."));
});

export const getBillHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await getBill(resolveOrganizationId(req), req.params.billId as string);
  res.status(200).json(new ApiResponse(200, result, "Bill fetched successfully."));
});

export const createBillHandler = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  await sendIdempotent(req, res, "Bill recorded successfully.", (session) =>
    createBill(organizationId, req.body, req.user!._id.toString(), session)
  );
});

export const voidBillHandler = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  await sendIdempotent(
    req,
    res,
    "Bill voided successfully.",
    (session) => voidBill(organizationId, req.params.billId as string, req.body, req.user!._id.toString(), session),
    200
  );
});

// ---------- Vendor payments ----------

export const listPaymentsHandler = asyncHandler(async (req: Request, res: Response) => {
  const q = req.query;
  const result = await listVendorPayments(resolveOrganizationId(req), {
    search: queryString(q.search),
    vendorId: queryString(q.vendorId),
    billId: queryString(q.billId),
    status: queryString(q.status),
    method: queryString(q.method),
    from: queryString(q.from),
    to: queryString(q.to),
    page: queryNumber(q.page),
    limit: queryNumber(q.limit),
  });
  res.status(200).json(new ApiResponse(200, result, "Vendor payments fetched successfully."));
});

export const getPaymentHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await getVendorPayment(resolveOrganizationId(req), req.params.paymentId as string);
  res.status(200).json(new ApiResponse(200, result, "Vendor payment fetched successfully."));
});

export const createPaymentHandler = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  await sendIdempotent(req, res, "Vendor payment recorded successfully.", (session) =>
    createVendorPayment(organizationId, req.body, req.user!._id.toString(), session)
  );
});

export const voidPaymentHandler = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  await sendIdempotent(
    req,
    res,
    "Vendor payment voided successfully.",
    (session) => voidVendorPayment(organizationId, req.params.paymentId as string, req.body, req.user!._id.toString(), session),
    200
  );
});
