import mongoose, { Schema, Document } from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env.config";

/**
 * Enumeration representing the user roles within the POS system.
 * Enforcing role types at the compiler level ensures security and type safety.
 */
export enum UserRole {
  SUPER_ADMIN = "SUPER_ADMIN",
  STORE_ADMIN = "STORE_ADMIN",
  MANAGER = "MANAGER",
  CASHIER = "CASHIER",
  INVENTORY_MANAGER = "INVENTORY_MANAGER",
  ACCOUNTANT = "ACCOUNTANT",
}

/**
 * Interface representing the structure of a User document in MongoDB.
 */
export interface IUser {
  username: string;
  email: string;
  password?: string;
  role: UserRole;
  isActive: boolean;
  store: mongoose.Types.ObjectId | null;
  lastLogin: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Interface representing the custom instance methods of a User document.
 * This guarantees type safety when invoking custom helper methods on a User instance.
 */
export interface IUserMethods {
  comparePassword(candidatePassword: string): Promise<boolean>;
  generateAccessToken(): string;
  generateRefreshToken(): string;
}

/**
 * Type representing a fully qualified Mongoose User Document, combining base fields and custom methods.
 */
export type UserDocument = Document<
  mongoose.Types.ObjectId,
  Record<string, never>,
  IUser
> &
  IUser &
  IUserMethods;

/**
 * Type representing the Mongoose User Model.
 */
export type UserModel = mongoose.Model<
  IUser,
  Record<string, never>,
  IUserMethods
>;

const userSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    username: {
      type: String,
      required: [true, "Username is required"],
      unique: true,
      trim: true,
      lowercase: true, // Force lowercase to avoid duplicate usernames (e.g. 'Admin' vs 'admin')
      minlength: [3, "Username must be at least 3 characters"],
      maxlength: [30, "Username cannot exceed 30 characters"],
      index: true, // Speeds up search queries and login checks
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
      index: true, // Speeds up search queries and login checks
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [4, "Password must be at least 4 characters"],
      select: false, // Prevents leakage by omitting password from queries by default
      validate: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        validator: function (this: any, value: string): boolean {
          // Verify that password contains only numbers for SUPER_ADMIN and STORE_ADMIN (PIN format)
          // For other roles, alphanumeric passwords are valid.
          const role = this ? this.role : null;
          if (role === UserRole.SUPER_ADMIN || role === UserRole.STORE_ADMIN) {
            return /^\d+$/.test(value);
          }
          return true;
        },
        message:
          "Super admin and store admin passwords must contain only numbers (PIN format)",
      },
    },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.CASHIER,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true, // Speeds up filtering for active users in middleware checks
    },
    store: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
      index: true, // Crucial for multi-tenant POS filtering (scoping users by store)
    },
    lastLogin: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true, // Automatically populates and updates createdAt & updatedAt
  }
);

// ==========================================
// Pre-save Hooks
// ==========================================

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) {
    return next();
  }
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error as Error);
  }
});

// ==========================================
// Instance Methods
// ==========================================

/**
 * Compares a candidate password against the user's hashed password.
 * Catches case where password field is unselected (select: false).
 */
userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  if (!this.password) {
    throw new Error(
      "Password field not loaded. Please select password in query."
    );
  }
  return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Generates a signed JWT Access Token for the user.
 */
userSchema.methods.generateAccessToken = function (): string {
  const payload: {
    id: mongoose.Types.ObjectId;
    email: string;
    role: UserRole;
    storeId?: string;
  } = {
    id: this._id as mongoose.Types.ObjectId,
    email: this.email,
    role: this.role,
  };

  // Add storeId for tenant contexts (non-super-admins)
  if (this.role !== UserRole.SUPER_ADMIN && this.store) {
    payload.storeId = this.store.toString();
  }

  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  });
};

/**
 * Generates a signed JWT Refresh Token for the user.
 */
userSchema.methods.generateRefreshToken = function (): string {
  return jwt.sign(
    {
      id: this._id,
    },
    env.JWT_REFRESH_SECRET,
    {
      expiresIn: env.JWT_REFRESH_EXPIRY as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  );
};

// ==========================================
// Schema Options & Transforms
// ==========================================

// Configure output formatting to remove sensitive information during JSON serialization
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.password;
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

const User = mongoose.model<IUser, UserModel>("User", userSchema);

export default User;
