/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Vendor model definition.
 * An organization-wide supplier. Purchase orders, receipts, bills and returns (Phases 3b-3e)
 * reference it and keep their own copy of its details, so editing a vendor never rewrites a
 * posted document. Products may name one as their preferred vendor.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export const VAT_TREATMENTS = ["vat_registered", "not_registered", "overseas"] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

export interface IVendorAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

export interface IVendor {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  /** Lowercased, trimmed name; backs the per-organization uniqueness index, the sort and search. */
  nameKey: string;
  legalName: string | null;
  /** Stored normalised (no spaces or hyphens, uppercase), so a prefix search matches it directly. */
  taxRegistrationNumber: string | null;
  countryCode: string;
  vatTreatment: VatTreatment;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  /** The phone's digits only, for "17001234" finding "+973 1700 1234". */
  phoneKey: string | null;
  address: IVendorAddress;
  paymentTermsDays: number;
  notes: string | null;
  isActive: boolean;
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type VendorDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IVendor> & IVendor;

export type VendorModel = mongoose.Model<IVendor, Record<string, never>>;

const nullableText = { type: String, trim: true, default: null };

const addressSchema = new Schema<IVendorAddress>(
  {
    line1: nullableText,
    line2: nullableText,
    city: nullableText,
    state: nullableText,
    postalCode: nullableText,
  },
  { _id: false }
);

const vendorSchema = new Schema<IVendor, VendorModel>(
  {
    name: {
      type: String,
      required: [true, "Vendor name is required"],
      trim: true,
      maxlength: [120, "Vendor name must be at most 120 characters long"],
    },
    nameKey: {
      type: String,
      required: true,
    },
    legalName: nullableText,
    taxRegistrationNumber: nullableText,
    countryCode: {
      type: String,
      required: [true, "Vendor country is required"],
      uppercase: true,
    },
    vatTreatment: {
      type: String,
      enum: VAT_TREATMENTS,
      required: true,
    },
    contactName: nullableText,
    email: { type: String, trim: true, lowercase: true, default: null },
    phone: nullableText,
    phoneKey: { type: String, default: null },
    address: {
      type: addressSchema,
      default: () => ({}),
    },
    paymentTermsDays: {
      type: Number,
      default: 0,
      min: [0, "paymentTermsDays cannot be negative"],
      max: [365, "paymentTermsDays must be at most 365"],
    },
    notes: nullableText,
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

/** Keeps the search keys derived from their sources, whatever path saved the doc. */
vendorSchema.pre("validate", function (next) {
  if (this.name) {
    this.nameKey = this.name.trim().toLowerCase();
  }
  const digits = this.phone ? this.phone.replace(/\D/g, "") : "";
  this.phoneKey = digits || null;
  next();
});

/** Name unique per organization among non-deleted vendors, so a deleted name can be reused. */
vendorSchema.index({ organizationId: 1, nameKey: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });

vendorSchema.plugin(tenantScopePlugin, { scope: "organization" });

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  delete ret.nameKey;
  delete ret.phoneKey;
  return ret;
};

vendorSchema.set("toJSON", { transform: cleanTransform, virtuals: true });
vendorSchema.set("toObject", { transform: cleanTransform, virtuals: true });

const Vendor = mongoose.model<IVendor, VendorModel>("Vendor", vendorSchema);

export default Vendor;
export { Vendor };
