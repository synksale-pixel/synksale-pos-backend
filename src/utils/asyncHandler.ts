import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Type definition for an asynchronous Express request handler.
 * It can return a Promise containing any value, or return synchronously.
 */
export type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown> | unknown;

/**
 * Wraps an asynchronous Express request handler to automatically catch any thrown errors
 * and forward them to the next middleware (which triggers the central error handler).
 *
 * Eliminates the need for writing boilerplate try/catch blocks in every controller.
 *
 * @param requestHandler The asynchronous function handling the request.
 * @returns A standard Express RequestHandler.
 */
export const asyncHandler = (
  requestHandler: AsyncRequestHandler
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(requestHandler(req, res, next)).catch((err) => {
      next(err);
    });
  };
};
