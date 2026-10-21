/**
 * Purpose: Requires a well-formed `Idempotency-Key` header (stock adjustments and transfers).
 * Runs after authentication, RBAC and body validation, so a key is only ever recorded for a
 * request that was allowed to run. A missing or malformed key is a 400 VALIDATION_FAILED.
 */

import { Request, Response, NextFunction } from "express";
import { idempotencyHeadersSchema, IDEMPOTENCY_HEADER } from "../validators/stock.validator";

export function requireIdempotencyKey(req: Request, _res: Response, next: NextFunction) {
  try {
    // Node lower-cases incoming header names.
    const parsed = idempotencyHeadersSchema.parse({ [IDEMPOTENCY_HEADER]: req.headers[IDEMPOTENCY_HEADER] });
    req.idempotencyKey = parsed[IDEMPOTENCY_HEADER];
    next();
  } catch (error) {
    next(error);
  }
}
