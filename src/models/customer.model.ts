/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Customer model (Phase 4a-2).
 * Organization-wide: any store can sell to a customer, found at the till by phone. A customer
 * with a tax registration number gets a full tax invoice (decision 5). No loyalty points or
 * wallet balance in v1 (frontend review decision E).
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export interface ICustomerAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export interface ICustomer {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  /** Lowercased, trimmed name; backs the word-prefix search. */
  nameKey: string;
  /** As entered. */
  phone: string;
  /**
   * The phone's national number in the organization's country (src/utils/phone.ts). Unique per
   * organization among non-deleted customers; backs the exact and starts-with lookups. Set by
   * the service, which knows the organization's country.
   */
  phoneKey: string;
  email: string | null;
  address: ICustomerAddress;
  /** Stored normalised (no spaces or hyphens, uppercase). */
  taxRegistrationNumber: string | null;
  /** India only: the GSTIN's first two digits. Set by the service. */
  stateCode: string | null;
  notes: string | null;
  isActive: boolean;
  /** Sales to this customer (incremented from 4c). Delete requires 0. */
  saleCount: number;
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CustomerDocument = Document<mongoose.Types.ObjectId, Record<string, never>, ICustomer> & ICustomer;

export type CustomerModel = mongoose.Model<ICustomer, Record<string, never>>;

const nullableText = { type: String, trim: true, default: null };

const addressSchema = new Schema<ICustomerAddress>(
  {
    line1: nullableText,
    line2: nullableText,
    city: nullableText,
    state: nullableText,
    postalCode: nullableText,
  },
  { _id: false }
);

const customerSchema = new Schema<ICustomer, CustomerModel>(
  {
    name: {
      type: String,
      required: [true, "Customer name is required"],
      trim: true,
      maxlength: [120, "Customer name must be at most 120 characters long"],
    },
    nameKey: { type: String, required: true },
    phone: { type: String, required: [true, "Customer phone is required"], trim: true },
    phoneKey: { type: String, required: true },
    email: { type: String, trim: true, lowercase: true, default: null },
    address: { type: addressSchema, default: () => ({}) },
    taxRegistrationNumber: nullableText,
    stateCode: { type: String, default: null },
    notes: nullableText,
    isActive: { type: Boolean, default: true },
    saleCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

customerSchema.pre("validate", function (next) {
  if (this.name) this.nameKey = this.name.trim().toLowerCase();
  next();
});

/**
 * Phone unique per organization among non-deleted customers (deactivated ones included), so a
 * deleted customer's number is free again. Also serves the anchored starts-with lookup.
 */
customerSchema.index({ organizationId: 1, phoneKey: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });
/** The list's default order (newest first). */
customerSchema.index({ organizationId: 1, createdAt: -1, _id: -1 });

customerSchema.plugin(tenantScopePlugin, { scope: "organization" });

const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  delete ret.nameKey;
  delete ret.phoneKey;
  return ret;
};

customerSchema.set("toJSON", { transform: cleanTransform, virtuals: true });
customerSchema.set("toObject", { transform: cleanTransform, virtuals: true });

const Customer = mongoose.model<ICustomer, CustomerModel>("Customer", customerSchema);

export default Customer;
export { Customer };
