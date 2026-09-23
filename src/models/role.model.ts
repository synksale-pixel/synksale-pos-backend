/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Role model definition.
 * Roles map to specific scopes ('platform' | 'organization' | 'store') and hold permissions.
 * This dynamic Role model enables flexible, tenant-specific role definitions.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";
import {
  isValidPermission,
  permissionFitsScope,
  PermissionKey,
} from "../config/permissions.catalog";

export interface IRole {
  organizationId: mongoose.Types.ObjectId | null;
  scope: "platform" | "organization" | "store";
  name: string;
  slug: string;
  isSystemRole: boolean;
  permissions: PermissionKey[];
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type RoleDocument = Document<
  mongoose.Types.ObjectId,
  Record<string, never>,
  IRole
> &
  IRole;

export type RoleModel = mongoose.Model<IRole, Record<string, never>>;

const roleSchema = new Schema<IRole, RoleModel>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null, // Only allowed for platform scope
      validate: {
        validator: function (this: any, val: any): boolean {
          // If scope is platform, organizationId must be null.
          // Otherwise, organizationId is strictly required.
          if (this.scope === "platform") {
            return val === null || val === undefined;
          }
          return val !== null && val !== undefined;
        },
        message:
          "Organization reference is required for organization and store scoped roles, and must be null for platform roles.",
      },
      index: true,
    },
    scope: {
      type: String,
      enum: ["platform", "organization", "store"],
      required: [true, "Role scope is required"],
    },
    name: {
      type: String,
      required: [true, "Role name is required"],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, "Role slug is required"],
      trim: true,
      lowercase: true,
    },
    isSystemRole: {
      type: Boolean,
      default: false, // Protected from deletion if true
    },
    permissions: {
      type: [String],
      required: [true, "Role permissions are required"],
      validate: {
        validator: function (val: string[]): boolean {
          // Reject if any permission key is invalid
          return val.every((key) => isValidPermission(key));
        },
        message:
          "One or more role permissions are invalid or not defined in the catalog.",
      },
    },
    isDelete: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Compound Unique Index: { organizationId: 1, slug: 1 }
 * Enables the same role slug to be defined across different organizations (e.g. Org A has "cashier", Org B has "cashier")
 * but ensures no duplicates exist within a single organization.
 * For platform roles, organizationId is null, ensuring "platform_admin" slug remains globally unique at the platform scope level.
 */
/**
 * Excludes soft-deleted roles so a slug is released when its role is deleted.
 * Without the partial filter, deleting "Shift Supervisor" would keep `shift_supervisor`
 * occupied forever and recreating it would fail with a confusing duplicate-key 409.
 */
roleSchema.index(
  { organizationId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { isDelete: false } }
);

/**
 * A role may only hold permissions that are meaningful at its own scope: a store-scoped role
 * cannot carry an organization-wide permission such as `report:view_org`. Enforced in the
 * service for a precise error message; repeated here so no code path can bypass it.
 */
roleSchema.pre("validate", function (next) {
  const offending = (this.permissions ?? []).filter(
    (key) => !permissionFitsScope(this.scope, key)
  );
  if (offending.length > 0) {
    return next(
      new Error(
        `Permissions not valid at ${this.scope} scope: ${offending.join(", ")}.`
      )
    );
  }
  next();
});

// ==========================================
// Pre-query Hooks (Soft Delete Filter)
// ==========================================
roleSchema.pre(/^find|countDocuments/, function (this: any, next) {
  const filter = this.getFilter();
  if (filter.isDelete === undefined) {
    filter.isDelete = { $ne: true };
  }
  next();
});

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  return ret;
};

roleSchema.set("toJSON", {
  transform: cleanTransform,
  virtuals: true,
});

roleSchema.set("toObject", {
  transform: cleanTransform,
  virtuals: true,
});

/**
 * Defense-in-depth tenant isolation (see the equivalent note in user.model.ts).
 * organizationId and isDelete are already defined here, so only the pre-query hooks are added.
 * Platform-scoped roles (organizationId: null) are only ever resolved outside a tenant request
 * context, so they are not affected by the injected filter.
 */
roleSchema.plugin(tenantScopePlugin, { scope: "organization" });

const Role = mongoose.model<IRole, RoleModel>("Role", roleSchema);

export default Role;
export { Role };
