/**
 * Purpose: Single mounting point for all v1 feature routes.
 * This barrel router facilitates versioned API routing.
 */

import { Router, Request, Response } from "express";
import { ApiResponse } from "../../utils/ApiResponse";
import platformAuthRouter from "./platformAuth.routes";
import platformOrganizationRouter from "./platformOrganization.routes";
import tenantAuthRouter from "./tenantAuth.routes";
import userRouter from "./user.routes";
import roleRouter from "./role.routes";
import storeRouter from "./store.routes";
import organizationRouter from "./organization.routes";
import taxRateRouter from "./taxRate.routes";
import categoryRouter from "./category.routes";
import productRouter from "./product.routes";
import { storeStockRouter, stockTransferRouter } from "./stock.routes";

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
v1Router.use("/platform/auth", platformAuthRouter);
v1Router.use("/platform/organizations", platformOrganizationRouter);
v1Router.use("/auth", tenantAuthRouter);
v1Router.use("/users", userRouter);
v1Router.use("/roles", roleRouter);
v1Router.use("/stores", storeRouter);
v1Router.use("/stores/:storeId", storeStockRouter);
v1Router.use("/organization", organizationRouter);
v1Router.use("/tax-rates", taxRateRouter);
v1Router.use("/categories", categoryRouter);
v1Router.use("/products", productRouter);
v1Router.use("/stock-transfers", stockTransferRouter);

export default v1Router;
