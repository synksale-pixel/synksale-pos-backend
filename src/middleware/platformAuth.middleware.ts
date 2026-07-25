/**
 * Purpose: Platform Authentication Middleware.
 * Authenticates super admins, checks DB state, attaches user to request, and populates request context.
 * Intentionally separate from tenant authentication middleware to isolate security boundaries.
 */

import { Request, Response, NextFunction } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { getRequestContext } from "../utils/requestContext";
import { verifySuperAdminAccessToken } from "../services/platformAuth.service";
import { User, UserDocument } from "../models/user.model";

export const authenticateSuperAdmin = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new ApiError(
        401,
        "Authentication failed: Platform access token is missing or invalid. Use 'Bearer <token>' format."
      );
    }

    const token = authHeader.split(" ")[1];
    const decoded = verifySuperAdminAccessToken(token);

    // Fetch user and ensure we do NOT populate organizationId or orgRoleId (must be null for super admins)
    const user = await User.findById(decoded.userId);

    if (!user) {
      throw new ApiError(
        401,
        "Authentication failed: The super admin account associated with this token does not exist."
      );
    }

    if (!user.isSuperAdmin) {
      throw new ApiError(
        403,
        "Access Denied: The authenticated user is not authorized to access platform routes."
      );
    }

    if (!user.isActive) {
      throw new ApiError(
        401,
        "Authentication failed: The super admin account associated with this token has been deactivated."
      );
    }

    // Attach Mongoose Document to Request
    req.user = user as UserDocument;

    // Set variables in request context for logging/tracking
    const context = getRequestContext();
    if (context) {
      context.userId = user._id.toString();
      // organizationId is left undefined/null because super admin does not belong to any tenant organization
    }

    next();
  }
);
