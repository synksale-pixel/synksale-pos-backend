import { Schema, Query } from "mongoose";
import { getRequestContext } from "../../utils/requestContext";

/**
 * Options configuration for the tenantScopePlugin.
 * - scope: 'organization' - isolates documents by organizationId (e.g. Store itself).
 * - scope: 'organization+store' - isolates documents by both organizationId and storeId (e.g. Products, Sales).
 */
export interface TenantScopeOptions {
  scope: "organization" | "organization+store";
}

/**
 * Mongoose schema plugin to enforce multi-tenant isolation and soft deletion.
 *
 * 1. Automatic Schema Injection:
 *    - Injects `organizationId` (and `storeId` if scope is organization+store) fields.
 *    - Injects `isDelete` boolean field for soft deletion.
 * 2. Automatic Query Scoping (Defense-in-Depth):
 *    - Automatically hooks into find, findOne, findOneAndUpdate, countDocuments, updateMany, deleteMany.
 *    - Injects active tenant context (organizationId, storeId) from AsyncLocalStorage if present.
 *    - Injects `isDelete: { $ne: true }` to filter out soft-deleted records.
 *    - Safely bypasses injection if request context is absent (e.g., in seed/migration scripts).
 */
export function tenantScopePlugin(schema: Schema, options: TenantScopeOptions) {
  // Define fields dynamically if they do not exist
  if (!schema.path("isDelete")) {
    schema.add({
      isDelete: {
        type: Boolean,
        default: false,
        index: true,
      },
    });
  }

  if (!schema.path("organizationId")) {
    schema.add({
      organizationId: {
        type: Schema.Types.ObjectId,
        ref: "Organization",
        required: true,
        index: true,
      },
    });
  }

  if (options.scope === "organization+store" && !schema.path("storeId")) {
    schema.add({
      storeId: {
        type: Schema.Types.ObjectId,
        ref: "Store",
        required: true,
        index: true,
      },
    });
  }

  // Pre-query hook to inject tenant scoping filters and exclude soft-deleted documents
  const preQueryHook = function (this: Query<never, never>) {
    const filter = this.getFilter();
    const context = getRequestContext();

    // 1. Inject Tenant Context (if available in current AsyncLocalStorage context)
    if (context) {
      if (context.organizationId && filter.organizationId === undefined) {
        filter.organizationId = context.organizationId;
      }
      if (
        options.scope === "organization+store" &&
        context.storeId &&
        filter.storeId === undefined
      ) {
        filter.storeId = context.storeId;
      }
    }

    // 2. Enforce Soft Delete Filter
    // Only filter out soft-deleted records if the query doesn't explicitly query for `isDelete` status.
    if (filter.isDelete === undefined) {
      filter.isDelete = { $ne: true };
    }
  };

  // Register the preQueryHook across standard read/update/delete operations
  const targetMethods = [
    "find",
    "findOne",
    "findOneAndUpdate",
    "countDocuments",
    "updateMany",
    "updateOne",
    "deleteOne",
    "deleteMany",
  ];

  targetMethods.forEach((method) => {
    schema.pre(method as never, preQueryHook);
  });
}
