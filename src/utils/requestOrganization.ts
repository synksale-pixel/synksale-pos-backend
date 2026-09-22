/**
 * Purpose: Resolves the caller's organization ID from an authenticated request.
 *
 * The `authenticate` middleware POPULATES req.user.organizationId (it is a full Organization
 * document, not a bare ObjectId), so calling .toString() on it yields the document, not the ID.
 * Every tenant controller needs the same two lines, so they live here.
 */

import { Request } from "express";
import { ApiError } from "./ApiError";

/**
 * @param action Phrased to complete "You must belong to an organization to ..." (e.g. "manage stores").
 */
export function resolveOrganizationId(req: Request, action: string): string {
  const orgRef = req.user?.organizationId as unknown as
    | { _id: { toString(): string } }
    | null
    | undefined;

  if (!orgRef) {
    throw new ApiError(
      400,
      `Access Denied: You must belong to an organization to ${action}.`
    );
  }

  return orgRef._id.toString();
}
