/**
 * Purpose: Middleware that generates or propagates a unique correlation ID (requestId)
 * for every incoming HTTP request. Injects this ID into standard Express Request/Response objects
 * and executes downstream middleware/handlers within an AsyncLocalStorage context.
 */

import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4, validate as uuidValidate } from "uuid";
import { requestContextStorage } from "../utils/requestContext";

/**
 * Request ID Middleware:v
 * 1. Checks if the incoming request already has a valid X-Request-Id header.
 *    If present and is a valid UUID, it reuses it. Otherwise, generates a new UUID v4.
 * 2. Injects the ID into the Express Request object as `req.id`.
 * 3. Appends the ID to the response as the `X-Request-Id` header.
 * 4. Runs the downstream request lifecycle in the AsyncLocalStorage context containing the ID.
 */
export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const incomingId = req.headers["x-request-id"];
  let requestId: string;

  if (typeof incomingId === "string" && uuidValidate(incomingId)) {
    requestId = incomingId;
  } else {
    requestId = uuidv4();
  }

  // Attach request ID to request object (enabled by declaration merging in types/express.d.ts)
  req.id = requestId;

  // Set the response header so clients can correlate their requests with logs
  res.setHeader("X-Request-Id", requestId);

  // Execute all subsequent request handling inside the AsyncLocalStorage context
  requestContextStorage.run({ requestId }, () => {
    next();
  });
};

export default requestIdMiddleware;
