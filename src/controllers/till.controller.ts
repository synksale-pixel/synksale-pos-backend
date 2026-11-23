/**
 * Purpose: Till Controller (Phase 4a-2).
 * The till's catalog reads at one store. scopeToStore has verified the (active) store first.
 */

import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { resolveOrganizationId as resolveOrgId } from "../utils/requestOrganization";
import { tillLookup, listTillItems } from "../services/till.service";

const resolveOrganizationId = (req: Request): string => resolveOrgId(req, "use the till");

const storeIdOf = (req: Request) => (req.params.storeId as string).toLowerCase();

/** A single query-string value; repeated or nested parameters are ignored. */
const queryString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const queryNumber = (value: unknown): number | undefined => {
  const text = queryString(value);
  return text !== undefined && text.trim() !== "" ? Number(text) : undefined;
};

export const lookup = asyncHandler(async (req: Request, res: Response) => {
  const result = await tillLookup(resolveOrganizationId(req), storeIdOf(req), queryString(req.query.code) ?? "");
  res.status(200).json(new ApiResponse(200, result, "Item found."));
});

export const items = asyncHandler(async (req: Request, res: Response) => {
  const result = await listTillItems(resolveOrganizationId(req), storeIdOf(req), {
    search: queryString(req.query.search),
    categoryId: queryString(req.query.categoryId),
    page: queryNumber(req.query.page),
    limit: queryNumber(req.query.limit),
  });
  res.status(200).json(new ApiResponse(200, result, "Items fetched successfully."));
});
