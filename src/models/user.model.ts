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

export interface IStoreAccess {
  storeId: mongoose.Types.ObjectId;
  roleId: mongoose.Types.ObjectId;
}

export interface IUser {
  organizationId: mongoose.Types.ObjectId;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  isSuperAdmin: boolean;
  orgRoleId: mongoose.Types.ObjectId | null;
  storeAccess: IStoreAccess[];
  refreshTokens: IRefreshToken[];
  isActive: boolean;
  isDelete: boolean;
  lastLoginAt: Date | null;
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
      required: [true, "Organization reference is required"],
      index: true, // Speeds up scoping users by organization
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: [true, "Password hash is required"],
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
  },
  {
    timestamps: true,
  }
);

/**
 * Compound Unique Index: { organizationId: 1, email: 1 }
 * Why: Allows the same email address to hold separate accounts across different organizations
 * (a judgment call to support multi-tenant structure). If global uniqueness is required instead,
 * this would be a global index. Within a single organization, email addresses must be unique.
 */
userSchema.index({ organizationId: 1, email: 1 }, { unique: true });

// ==========================================
// Pre-save Hooks
// ==========================================

// Hash passwordHash before saving if it has been modified
userSchema.pre("save", async function (next) {
  if (!this.isModified("passwordHash")) {
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
  if (!this.passwordHash) {
    throw new Error(
      "Password hash not loaded. Please select passwordHash in your query explicitly."
    );
  }
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.passwordHash;
  delete ret.refreshTokens;
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
