/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: User model definition.
 * Represents physical users who log into the POS system.
 * Supports multi-store access, hashed refresh tokens at rest, and dynamic RBAC roles.
 */

import mongoose, { Schema, Document } from "mongoose";
import bcrypt from "bcryptjs";

export interface IRefreshToken {
  token: string; // SHA-256 hashed refresh token
  createdAt: Date;
  expiresAt: Date;
  userAgent?: string;
  ipAddress?: string;
}

// Hashes of rotated-out refresh tokens, kept until they would have expired so that
// replaying one can be detected as a possible token theft.
export interface IUsedRefreshToken {
  token: string; // SHA-256 hashed refresh token
  expiresAt: Date;
}

export interface IStoreAccess {
  storeId: mongoose.Types.ObjectId;
  roleId: mongoose.Types.ObjectId;
}

export interface IUser {
  organizationId: mongoose.Types.ObjectId | null;
  email: string;
  passwordHash?: string;
  firstName: string;
  lastName: string;
  isSuperAdmin: boolean;
  orgRoleId: mongoose.Types.ObjectId | null;
  storeAccess: IStoreAccess[];
  refreshTokens: IRefreshToken[];
  usedRefreshTokens: IUsedRefreshToken[];
  isActive: boolean;
  isDelete: boolean;
  lastLoginAt: Date | null;
  inviteToken?: string;
  inviteTokenExpiresAt?: Date;
  inviteStatus?: "pending" | "accepted";
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUserMethods {
  comparePassword(candidatePassword: string): Promise<boolean>;
}

export type UserDocument = Document<
  mongoose.Types.ObjectId,
  Record<string, never>,
  IUser
> &
  IUser &
  IUserMethods;

export type UserModel = mongoose.Model<
  IUser,
  Record<string, never>,
  IUserMethods
>;

const refreshTokenSchema = new Schema<IRefreshToken>({
  token: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  userAgent: String,
  ipAddress: String,
});

const usedRefreshTokenSchema = new Schema<IUsedRefreshToken>(
  {
    token: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false }
);

const storeAccessSchema = new Schema<IStoreAccess>({
  storeId: {
    type: Schema.Types.ObjectId,
    ref: "Store",
    required: [true, "Store reference is required"],
  },
  roleId: {
    type: Schema.Types.ObjectId,
    ref: "Role",
    required: [true, "Role reference is required"],
  },
});

const userSchema = new Schema<
  IUser,
  UserModel,
  Record<string, never>,
  IUserMethods
>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: function (this: any) {
        // Required only for tenant users (i.e. isSuperAdmin is false or undefined)
        return !this.isSuperAdmin;
      },
      index: true, // Speeds up scoping users by organization
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      // index: true,
    },
    passwordHash: {
      type: String,
      required: function (this: any) {
        // Required unless the user has a pending invitation
        return this.inviteStatus !== "pending";
      },
      select: false, // Ensures password hash is never leaked by default in queries
    },
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      trim: true,
    },
    isSuperAdmin: {
      type: Boolean,
      default: false, // Platform-level bypass flag (intentionally separate from the dynamic Role system)
    },
    orgRoleId: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      default: null, // Scoped to organization-wide permissions (e.g. Org Admin)
    },
    storeAccess: [storeAccessSchema], // Array of store-specific roles (supports multi-store staff)
    refreshTokens: [refreshTokenSchema], // Supports multi-device login sessions
    usedRefreshTokens: [usedRefreshTokenSchema], // Rotated-out tokens, for reuse detection
    isActive: {
      type: Boolean,
      default: true,
      index: true, // Quick checks to verify active user status during auth
    },
    isDelete: {
      type: Boolean,
      default: false,
      index: true, // Supports soft delete
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    inviteToken: {
      type: String,
      select: false,
      index: true,
    },
    inviteTokenExpiresAt: {
      type: Date,
    },
    inviteStatus: {
      type: String,
      enum: ["pending", "accepted"],
      default: "accepted", // Default to accepted for normal users (e.g., org admins on signup)
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Compound Unique Index: { organizationId: 1, email: 1 }
 * Why: Allows the same email address to hold separate accounts across different organizations.
 * Changed to a partial index that only applies when organizationId is not null.
 * This ensures MongoDB does not block multiple super admins (who have organizationId: null).
 * MongoDB BSON type comparison places ObjectIds above null, so $gt: null matches any valid ObjectId.
 * This keeps the platform/tenant boundary unambiguous at the data layer, not just the application layer.
 */
userSchema.index(
  { organizationId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { organizationId: { $gt: null } },
  }
);

/**
 * Partial Unique Index: { email: 1 } for Super Admins
 * Why: Ensures email uniqueness globally among platform-level super admin accounts.
 * Points to the super admin auth task/PR context.
 */
userSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { isSuperAdmin: true },
  }
);

// ==========================================
// Pre-validate Hooks
// ==========================================

// Ensure exclusivity: super admin must never simultaneously belong to a tenant organization
userSchema.pre("validate", function (next) {
  if (this.isSuperAdmin && this.organizationId) {
    return next(
      new Error(
        "Exclusivity Constraint Violation: A Super Admin cannot simultaneously be assigned to a tenant organization."
      )
    );
  }
  next();
});

// ==========================================
// Pre-save Hooks
// ==========================================

// Hash passwordHash before saving if it has been modified
userSchema.pre("save", async function (next) {
  if (!this.passwordHash || !this.isModified("passwordHash")) {
    return next();
  }
  try {
    // 10 rounds is an industry standard offering a good balance of safety and computational cost
    const salt = await bcrypt.genSalt(10);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    next();
  } catch (error) {
    next(error as Error);
  }
});

// ==========================================
// Pre-query Hooks (Soft Delete Filter)
// ==========================================
userSchema.pre(/^find|countDocuments/, function (this: any, next) {
  const filter = this.getFilter();
  if (filter.isDelete === undefined) {
    filter.isDelete = { $ne: true };
  }
  next();
});

// ==========================================
// Instance Methods
// ==========================================

/**
 * Compares candidate password against the user's stored password hash.
 */
userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  if (!this.isSelected("passwordHash")) {
    throw new Error(
      "Password hash not loaded. Please select passwordHash in your query explicitly."
    );
  }
  if (!this.passwordHash) {
    return false;
  }
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.passwordHash;
  delete ret.refreshTokens;
  delete ret.usedRefreshTokens;
  delete ret.inviteToken;
  delete ret.inviteTokenExpiresAt;
  delete ret.__v;
  return ret;
};

userSchema.set("toJSON", {
  transform: cleanTransform,
  virtuals: true,
});

userSchema.set("toObject", {
  transform: cleanTransform,
  virtuals: true,
});

const User = mongoose.model<IUser, UserModel, IUserMethods>("User", userSchema);

export default User;
export { User };
