/**
 * Purpose: Single mounting point for all v1 feature routes.
 * This barrel router facilitates versioned API routing.
 */

import { Router, Request, Response } from "express";
import { ApiResponse } from "../../utils/ApiResponse";

const v1Router = Router();

/**
 * GET /api/v1/health
 * Public health check endpoint for API consumers.
 * Distinguishes from infrastructure health check (/health) by outputting a standard ApiResponse.
 */
v1Router.get("/health", (_req: Request, res: Response) => {
  const response = new ApiResponse(
    200,
    { timestamp: new Date().toISOString() },
    "OK"
  );
  res.status(response.statusCode).json(response);
});

// Feature routers will be mounted here as they're built, e.g.:
// v1Router.use('/auth', authRouter);
// v1Router.use('/products', productRouter);

export default v1Router;
