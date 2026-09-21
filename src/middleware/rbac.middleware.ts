/**
 * Purpose: Role-Based Access Control (RBAC) and Authentication Middlewares.
 * Implements token verification, store boundary scoping, and permission enforcement.
 */

import { Request, Response, NextFunction } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { getRequestContext } from "../utils/requestContext";
import { verifyAccessToken } from "../services/auth.service";
import {
  getEffectivePermissions,
  hasOrganizationScopeRole,
} from "../services/permission.service";
import { User, UserDocument } from "../models/user.model";
import { Store } from "../models/store.model";
import { IOrganization } from "../models/organization.model";
import { PermissionKey } from "../config/permissions.catalog";

/**
 * Authenticate Middleware:
 * 1. Checks for Authorization header with Bearer token.
 * 2. Decodes and verifies the access token.
 * 3. Fetches the active user from the database (populating their organization role for downstream scope checks).
 * 4. Attaches the user document to `req.user`.
 * 5. Sets `userId` and `organizationId` into the AsyncLocalStorage RequestContext.
 */
export const authenticate = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new ApiError(
        401,
        "Authentication failed: Access token is missing or invalid. Use 'Bearer <token>' format."
      );
    }

    const token = authHeader.split(" ")[1];
    const decoded = verifyAccessToken(token);

    // Fetch user and populate orgRoleId + organizationId in one round trip:
    // orgRoleId to check organization-wide roles immediately (efficiency design),
    // organizationId to re-validate the tenant's live approval/suspension state on every request.
    const user = await User.findById(decoded.userId).populate([
      "orgRoleId",
      "organizationId",
    ]);

    if (!user) {
      throw new ApiError(
        401,
        "Authentication failed: The user account associated with this token does not exist."
      );
    }

    if (!user.isActive) {
      throw new ApiError(
        401,
        "Authentication failed: The user account associated with this token has been deactivated."
      );
    }

    // Defense-in-depth: re-validate the tenant organization on every authenticated request,
    // not just at login. Closes the gap where a token issued before a suspension/rejection
    // would otherwise keep working until it naturally expires.
    const org = user.organizationId as unknown as IOrganization | null;
    if (org && typeof org === "object" && "approvalStatus" in org) {
      if (org.approvalStatus !== "approved") {
        throw new ApiError(
          401,
          "Authentication failed: Your organization is not approved for access."
        );
      }
      if (org.isActive === false) {
        throw new ApiError(
          401,
          "Authentication failed: Your organization account has been suspended."
        );
      }
    }

    // Attach Mongoose Document to Request
    req.user = user as UserDocument;

    // Set variables in request context for automatic tenant scoping
    // NOTE: organizationId is now a populated Organization document (not a bare ObjectId),
    // so we read it from the verified token payload instead of calling .toString() on it.
    const context = getRequestContext();
    if (context) {
      context.userId = user._id.toString();
      if (decoded.organizationId) {
        context.organizationId = decoded.organizationId;
      }
    }

    next();
  }
);

/**
 * scopeToStore Middleware:
 * 1. Validates that if a storeId is present in parameters/body/query, the user actually has permission to access it.
 * 2. Super Admins and users with organization-scoped roles (e.g. org_admin) have organization-wide access.
 * 3. Store-level staff must have an explicit assignment in their `storeAccess` array.
 * 4. Sets verified `storeId` in the RequestContext so the tenant scoping plugin applies it.
 *
 * CRITICAL: This must run BEFORE any controller queries so that the tenant scoping plugin filters query boundaries.
 */
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

const createScopeToStore = (allowInactive: boolean) =>
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new ApiError(
        401,
        "Authorization failed: Request user is not authenticated."
      );
    }

    const storeId =
      (req.params.storeId as string) ||
      (req.body?.storeId as string) ||
      (req.query.storeId as string);

    // If no store context is requested, proceed normally
    if (!storeId) {
      return next();
    }

    if (typeof storeId !== "string" || !OBJECT_ID_REGEX.test(storeId)) {
      throw new ApiError(400, "Invalid storeId format. Must be a 24-character hex string.");
    }

    let isAuthorized = false;

    // 1. Super Admins bypass store access boundary checks
    if (req.user.isSuperAdmin) {
      isAuthorized = true;
    }
    // 2. Organization-scoped roles (like Org Admin) bypass specific store access check
    else if (hasOrganizationScopeRole(req.user)) {
      isAuthorized = true;
    }
    // 3. Otherwise, check explicit user store access array
    else if (req.user.storeAccess && req.user.storeAccess.length > 0) {
      isAuthorized = req.user.storeAccess.some(
        (access) => access.storeId.toString() === storeId
      );
    }

    if (!isAuthorized) {
      throw new ApiError(
        403,
        "Access Denied: You do not have access authorization for the requested store."
      );
    }

    // Verify the store exists in the caller's organization (Store is org-scoped by the tenant
    // plugin, so a foreign or deleted store is not found) before it enters request context.
    // Pass the caller's organization explicitly rather than relying only on the token claim
    // in the request context (super admins have no organization, so they stay unscoped).
    const callerOrg = req.user.organizationId as unknown as { _id: unknown } | null;
    const storeFilter: Record<string, unknown> = { _id: storeId };
    if (callerOrg) {
      storeFilter.organizationId = callerOrg._id;
    }
    const store = await Store.findOne(storeFilter);
    if (!store) {
      throw new ApiError(404, "Store not found.");
    }
    if (!allowInactive && !store.isActive) {
      throw new ApiError(403, "Access Denied: This store has been deactivated.");
    }

    // Safely register storeId into request context
    const context = getRequestContext();
    if (context) {
      context.storeId = storeId;
    }

    next();
  });

export const scopeToStore = createScopeToStore(false);

/**
 * Same as scopeToStore but lets requests through for deactivated stores.
 * Only for store-management routes (view / update / reactivate).
 */
export const scopeToStoreAllowInactive = createScopeToStore(true);

/**
 * requireOrganizationRole Middleware:
 * Restricts a route to users holding an organization-scoped role (e.g. org_admin) or super admins,
 * so store-scoped staff cannot perform organization-level actions even if their store role
 * carries the route's permission. Use together with `authorize`, not instead of it.
 */
export const requireOrganizationRole = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return next(
      new ApiError(401, "Authorization failed: Request user is not authenticated.")
    );
  }
  if (!req.user.isSuperAdmin && !hasOrganizationScopeRole(req.user)) {
    return next(
      new ApiError(
        403,
        "Access Denied: This action requires an organization-level role."
      )
    );
  }
  next();
};

/**
 * authorize Middleware:
 * 1. Resolves effective permissions for the authenticated user based on organization and store context.
 * 2. Checks if the user holds the requiredPermission or the wildcard '*' permission.
 * 3. Throws a 403 Forbidden ApiError on failure.
 *
 * @param requiredPermission The PermissionKey required for the route.
 */
export const authorize = (requiredPermission: PermissionKey) => {
  return asyncHandler(
    async (req: Request, _res: Response, next: NextFunction) => {
      if (!req.user) {
        throw new ApiError(
          401,
          "Authorization failed: Request user is not authenticated."
        );
      }

      // Retrieve active storeId from context or request parameters
      const storeId =
        getRequestContext()?.storeId ||
        (req.params.storeId as string) ||
        (req.body.storeId as string) ||
        (req.query.storeId as string);

      // Resolve permissions dynamically
      const permissions = await getEffectivePermissions(req.user, storeId);

      // Allow if user holds direct permission key OR wildcard
      const hasPermission =
        permissions.includes("*") || permissions.includes(requiredPermission);

      if (!hasPermission) {
        throw new ApiError(
          403,
          `Access Denied: You do not possess the required permission (${requiredPermission}) to execute this action.`
        );
      }

      next();
    }
  );
};
