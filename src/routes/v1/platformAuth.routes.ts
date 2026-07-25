/**
 * Purpose: Platform Authentication Routes.
 * Defines the public and protected endpoints for Super Admin authentication operations.
 * Separated from tenant routes to maintain a clear boundary of trust.
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import { authenticateSuperAdmin } from "../../middleware/platformAuth.middleware";
import {
  loginSchema,
  refreshSchema,
  logoutSchema,
} from "../../validators/platformAuth.validator";
import {
  login,
  refresh,
  logout,
  logoutAllDevices,
  getProfile,
} from "../../controllers/platformAuth.controller";

const platformAuthRouter = Router();

// Public routes
platformAuthRouter.post("/login", validateRequest(loginSchema), login);
platformAuthRouter.post("/refresh", validateRequest(refreshSchema), refresh);
platformAuthRouter.post("/logout", validateRequest(logoutSchema), logout);

// Protected routes (require authenticateSuperAdmin middleware)
platformAuthRouter.post(
  "/logout-all",
  authenticateSuperAdmin,
  logoutAllDevices
);
platformAuthRouter.get("/me", authenticateSuperAdmin, getProfile);

export default platformAuthRouter;
