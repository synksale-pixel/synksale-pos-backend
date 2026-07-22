/**
 * Purpose: Centralized Express error-handling middleware.
 * Catches unmatched routes, handles specific third-party/native error translations,
 * logs comprehensive details with redacted sensitive parameters, and structures client responses.
 */

import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/ApiError";
import { env } from "../config/env.config";
import logger from "../config/logger.config";

/**
 * Recursively redacts sensitive keys from request payloads to prevent credential leaking in logs.
 * Supports deeply nested objects, arrays, and primitive values.
 */
function redact(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(redact);
  }

  if (typeof data === "object") {
    const sensitiveKeys = new Set([
      "password",
      "token",
      "refreshToken",
      "card",
      "cardDetails",
      "cardNumber",
      "cvv",
      "accessToken",
    ]);

    const redactedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>
    )) {
      if (sensitiveKeys.has(key)) {
        redactedObj[key] = "[REDACTED]";
      } else if (typeof value === "object") {
        redactedObj[key] = redact(value);
      } else {
        redactedObj[key] = value;
      }
    }
    return redactedObj;
  }

  return data;
}

/**
 * Catches all requests directed to non-existent API routes.
 * Creates a structured 404 ApiError and propagates it down the middleware pipeline.
 */
export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const message = `Route not found: ${req.method} ${req.originalUrl}`;
  const error = new ApiError(404, message);
  next(error);
};

/**
 * Centralized global error handling middleware.
 * Express requires exactly four arguments in the signature so that it is registered
 * as an error-handling middleware instead of a standard request-handling middleware.
 */
export const globalErrorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): Response => {
  let error: ApiError;

  // 1. Check if error is already a validated ApiError instance.
  if (err instanceof ApiError) {
    error = err;
  } else {
    // 2. Identify the status code (default to 500 for generic internal errors)
    const statusCode =
      (err as { statusCode?: number }).statusCode ||
      (err as { status?: number }).status ||
      500;

    // 3. Normalization & Translation of specific exceptions
    if (err.name === "ValidationError") {
      // Translates Mongoose Schema Validation failures
      const mongooseErr = err as unknown as {
        errors: Record<string, { message: string }>;
      };
      const issues = Object.keys(mongooseErr.errors || {}).map((key) => ({
        field: key,
        message: mongooseErr.errors[key]?.message,
      }));
      const formattedMsg = issues
        .map((i) => `${i.field}: ${i.message}`)
        .join(", ");
      error = new ApiError(
        400,
        `Database Validation Failed: ${formattedMsg}`,
        issues,
        err.stack
      );
    } else if (err.name === "CastError") {
      // Translates Mongoose ObjectId casting failures
      const castErr = err as unknown as { path: string; value: unknown };
      error = new ApiError(
        400,
        `Invalid path identifier: Value '${castErr.value}' is not a valid ObjectId for path '${castErr.path}'`,
        [{ path: castErr.path, value: castErr.value }],
        err.stack
      );
    } else if ((err as { code?: number }).code === 11000) {
      // Translates Mongoose Unique Constraint index duplicate key failures
      const duplicateErr = err as { keyValue?: Record<string, unknown> };
      const fields = duplicateErr.keyValue
        ? Object.keys(duplicateErr.keyValue).join(", ")
        : "field";
      error = new ApiError(
        409,
        `Duplicate Conflict Error: A record matching these values (${fields}) already exists.`,
        [duplicateErr.keyValue],
        err.stack
      );
    } else if (
      err.name === "ZodError" ||
      (err as { issues?: unknown[] }).issues
    ) {
      // Translates Zod request body validation schema failures
      const zodErr = err as unknown as {
        issues: Array<{ path: string[]; message: string }>;
      };
      const issues = zodErr.issues || [];
      const formattedMsg = issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", ");
      error = new ApiError(
        400,
        `Request Validation Failed: ${formattedMsg}`,
        issues,
        err.stack
      );
    } else if (err.name === "JsonWebTokenError") {
      // Translates JWT signature validation failures
      error = new ApiError(
        401,
        "Authentication failed: Access token signature is invalid or corrupted.",
        [],
        err.stack
      );
    } else if (err.name === "TokenExpiredError") {
      // Translates JWT expiration validations
      error = new ApiError(
        401,
        "Authentication failed: Access token has expired. Please log in again.",
        [],
        err.stack
      );
    } else {
      // Default fallback for general server-side exceptions.
      // Uses generic message for client safety if it is a 500 server error to prevent stack leakage,
      // but respects standard client-facing messages for other status codes (e.g. 403 Forbidden).
      const clientMessage =
        statusCode === 500
          ? "An unexpected system error occurred on our server."
          : err.message || "Something went wrong";

      error = new ApiError(statusCode, clientMessage, [], err.stack);
    }
  }

  // 4. Server-Side Logging
  // Gather request and user context parameters safely
  const extendedReq = req as Request & {
    user?: { id?: string; storeId?: string };
    userId?: string;
    storeId?: string;
  };
  const sanitizedBody = req.body ? redact(req.body) : undefined;

  const logMetadata = {
    method: req.method,
    url: req.originalUrl,
    userId: extendedReq.user?.id || extendedReq.userId,
    storeId: extendedReq.user?.storeId || extendedReq.storeId,
    body: sanitizedBody,
    statusCode: error.statusCode,
    originalError: {
      name: err.name,
      message: err.message,
      stack: err.stack,
    },
  };

  logger.error(
    `[Exception] ${req.method} ${req.originalUrl} failed with status ${error.statusCode}: ${err.message || error.message}`,
    logMetadata
  );

  // 5. Client Response Structure
  // Ensure stack traces are withheld in production to mitigate system footprint exposure
  return res.status(error.statusCode).json({
    success: error.success,
    statusCode: error.statusCode,
    message: error.message,
    errors: error.errors,
    ...(env.NODE_ENV === "development" && { stack: error.stack }),
  });
};

export default globalErrorHandler;
