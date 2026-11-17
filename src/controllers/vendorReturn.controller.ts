/**
 * Purpose: Vendor Return and Debit Note Controller (Phase 3e).
 * Returns are store-level (plus a cross-store list); debit notes are organization-level. Every
 * write runs through runIdempotent, so a retried request replays its first response instead of
 * returning goods or crediting a bill twice.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import { getEffectivePermissions } from "../services/permission.service";
import { sendIdempotent } from "./stock.controller";
import { createVendorReturn, getVendorReturn, listVendorReturns, ListVendorReturnsQuery } from "../services/vendorReturn.service";
import { applyDebitNote, createDebitNote, getDebitNote, listDebitNotes, voidDebitNote } from "../services/debitNote.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "manage vendor returns and debit notes");

/** The store of the URL, lower-cased to match the ids the tenant scope compares (see scopeToStore). */
const storeParam = (req: Request): string => (req.params.storeId as string).toLowerCase();

/** A single query-string value; repeated or nested parameters are ignored. */
const queryString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const queryNumber = (value: unknown): number | undefined => {
  const text = queryString(value);
  return text !== undefined && text.trim() !== "" ? Number(text) : undefined;
};

/** Stock costs (average cost, stock value) need inventory:read for the store. */
async function canSeeCost(req: Request, storeId: string): Promise<boolean> {
  const permissions = await getEffectivePermissions(req.user!, storeId);
  return permissions.includes("*") || permissions.includes("inventory:read");
}

const returnListQuery = (req: Request): ListVendorReturnsQuery => ({
  search: queryString(req.query.search),
  vendorId: queryString(req.query.vendorId),
  goodsReceiptId: queryString(req.query.goodsReceiptId),
  reason: queryString(req.query.reason),
  from: queryString(req.query.from),
  to: queryString(req.query.to),
  page: queryNumber(req.query.page),
  limit: queryNumber(req.query.limit),
});

// ---------- Vendor returns ----------

export const listAllReturns = asyncHandler(async (req: Request, res: Response) => {
  const result = await listVendorReturns(
    resolveOrganizationId(req),
    { user: req.user! },
    { ...returnListQuery(req), storeId: queryString(req.query.storeId) }
  );
  res.status(200).json(new ApiResponse(200, result, "Vendor returns fetched successfully."));
});

export const listStoreReturns = asyncHandler(async (req: Request, res: Response) => {
  const storeId = storeParam(req);
  const result = await listVendorReturns(resolveOrganizationId(req), { storeId, showCost: await canSeeCost(req, storeId) }, returnListQuery(req));
  res.status(200).json(new ApiResponse(200, result, "Vendor returns fetched successfully."));
});

export const getReturn = asyncHandler(async (req: Request, res: Response) => {
  const storeId = storeParam(req);
  const result = await getVendorReturn(resolveOrganizationId(req), storeId, req.params.vendorReturnId as string, await canSeeCost(req, storeId));
  res.status(200).json(new ApiResponse(200, result, "Vendor return fetched successfully."));
});

export const createReturn = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  const storeId = storeParam(req);
  const showCost = await canSeeCost(req, storeId);
  await sendIdempotent(req, res, "Vendor return posted successfully.", (session) =>
    createVendorReturn(organizationId, storeId, req.body, req.user!._id.toString(), session, showCost)
  );
});

// ---------- Debit notes ----------

export const listDebitNotesHandler = asyncHandler(async (req: Request, res: Response) => {
  const q = req.query;
  const result = await listDebitNotes(resolveOrganizationId(req), {
    search: queryString(q.search),
    vendorId: queryString(q.vendorId),
    billId: queryString(q.billId),
    vendorReturnId: queryString(q.vendorReturnId),
    type: queryString(q.type),
    status: queryString(q.status),
    from: queryString(q.from),
    to: queryString(q.to),
    page: queryNumber(q.page),
    limit: queryNumber(q.limit),
  });
  res.status(200).json(new ApiResponse(200, result, "Debit notes fetched successfully."));
});

export const getDebitNoteHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await getDebitNote(resolveOrganizationId(req), req.params.debitNoteId as string);
  res.status(200).json(new ApiResponse(200, result, "Debit note fetched successfully."));
});

export const createDebitNoteHandler = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  await sendIdempotent(req, res, "Debit note recorded successfully.", (session) =>
    createDebitNote(organizationId, req.body, req.user!._id.toString(), session)
  );
});

export const applyDebitNoteHandler = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  await sendIdempotent(
    req,
    res,
    "Debit note credit applied successfully.",
    (session) => applyDebitNote(organizationId, req.params.debitNoteId as string, req.body, req.user!._id.toString(), session),
    200
  );
});

export const voidDebitNoteHandler = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = resolveOrganizationId(req);
  await sendIdempotent(
    req,
    res,
    "Debit note voided successfully.",
    (session) => voidDebitNote(organizationId, req.params.debitNoteId as string, req.body, req.user!._id.toString(), session),
    200
  );
});
