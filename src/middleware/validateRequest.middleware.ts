/**
 * Purpose: Validation Middleware.
 * Standardized request body validation middleware using Zod.
 * Maps validation errors to a structured ApiError (400 Bad Request) via global error handler.
 */

import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";

export function validateRequest(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}
