/**
 * Purpose: Tenant Authentication Routes.
 * Defines public and protected endpoints for tenant authentication (signup, login, refresh, logout, profile).
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import { authenticate } from "../../middleware/rbac.middleware";
import {
  signupSchema,
  tenantLoginSchema,
} from "../../validators/organizationAuth.validator";
import {
  refreshSchema,
  logoutSchema,
} from "../../validators/platformAuth.validator";
import {
  signup,
  login,
  refresh,
  logout,
  logoutAllDevices,
  me,
} from "../../controllers/tenantAuth.controller";

const tenantAuthRouter = Router();

// Public routes
tenantAuthRouter.post("/signup", validateRequest(signupSchema), signup);
tenantAuthRouter.post("/login", validateRequest(tenantLoginSchema), login);
tenantAuthRouter.post("/refresh", validateRequest(refreshSchema), refresh);
tenantAuthRouter.post("/logout", validateRequest(logoutSchema), logout);

// Protected routes (require authenticate middleware)
tenantAuthRouter.post("/logout-all", authenticate, logoutAllDevices);
tenantAuthRouter.get("/me", authenticate, me);

export default tenantAuthRouter;
