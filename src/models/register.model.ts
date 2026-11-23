/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Register model (Phase 4a-2).
 * One till in a store. A shift opens on a register (4b) and every sale records the register it
 * was rung up on (4c). Every store starts with one ("Register 1"), created with the store.
 * Opening float, drawer limit and the current shift arrive with 4b.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

/** The name of the register every store is created with. */
export const DEFAULT_REGISTER_NAME = "Register 1";

export interface IRegister {
  organizationId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  name: string;
  /** Lowercased, trimmed name; backs the per-store uniqueness index and the sort. */
  nameKey: string;
  isActive: boolean;
  /**
   * Shifts opened on this register. 4b increments it on shift open (claimRegister) and delete
   * requires 0, both as writes to this register, so a shift can never open on a deleted one.
   */
  shiftCount: number;
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type RegisterDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IRegister> & IRegister;

export type RegisterModel = mongoose.Model<IRegister, Record<string, never>>;

export const registerNameKey = (name: string) => name.trim().toLowerCase();

const registerSchema = new Schema<IRegister, RegisterModel>(
  {
    name: {
      type: String,
      required: [true, "Register name is required"],
      trim: true,
      maxlength: [50, "Register name must be at most 50 characters long"],
    },
    nameKey: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    shiftCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

registerSchema.pre("validate", function (next) {
  if (this.name) this.nameKey = registerNameKey(this.name);
  next();
});

/** Name unique per store among non-deleted registers, so a deleted name can be reused. */
registerSchema.index({ storeId: 1, nameKey: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });

registerSchema.plugin(tenantScopePlugin, { scope: "organization+store" });

const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  delete ret.nameKey;
  delete ret.shiftCount;
  return ret;
};

registerSchema.set("toJSON", { transform: cleanTransform, virtuals: true });
registerSchema.set("toObject", { transform: cleanTransform, virtuals: true });

const Register = mongoose.model<IRegister, RegisterModel>("Register", registerSchema);

export default Register;
export { Register };
