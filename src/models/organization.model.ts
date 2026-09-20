/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Organization model definition.
 * Organization represents a tenant in our system. All other models (Store, User, Product, etc.)
 * are scoped under an Organization.
 */

import mongoose, { Schema, Document } from "mongoose";

export interface IOrganization {
  name: string;
  slug: string;
  contactEmail: string;
  contactPhone: string;
  applicantEmail?: string;
  isActive: boolean;
  isDelete: boolean;
  approvalStatus: "pending" | "approved" | "rejected";
  approvedBy: mongoose.Types.ObjectId | null;
  approvedAt: Date | null;
  rejectedBy: mongoose.Types.ObjectId | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  settings: {
    currency: string;
    timezone: string;
  };
  createdAt?: Date;
  updatedAt?: Date;
}

export type OrganizationDocument = Document<
  mongoose.Types.ObjectId,
  Record<string, never>,
  IOrganization
> &
  IOrganization;

export type OrganizationModel = mongoose.Model<
  IOrganization,
  Record<string, never>
>;

const organizationSchema = new Schema<IOrganization, OrganizationModel>(
  {
    name: {
      type: String,
      required: [true, "Organization name is required"],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, "Organization slug is required"],
      unique: true,
      lowercase: true,
      trim: true,
      index: true, // Crucial for quick tenant lookups by subdomain/URL slug
    },
    contactEmail: {
      type: String,
      required: [true, "Contact email is required"],
      trim: true,
      lowercase: true,
    },
    contactPhone: {
      type: String,
      required: [true, "Contact phone is required"],
      trim: true,
    },
    // Admin email used to apply; denormalized so the DB can enforce one pending
    // application per applicant (see partial unique index below).
    applicantEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true, // Quick checks to verify if a tenant is active/suspended
    },
    isDelete: {
      type: Boolean,
      default: false,
      index: true, // Supports soft delete
    },
    // ===== Sales-Assisted Onboarding Gate =====
    // Orthogonal to `isActive`: approvalStatus gates whether the tenant is allowed to
    // authenticate at all; isActive continues to represent post-approval suspension.
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    rejectedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      default: null,
    },
    settings: {
      currency: {
        type: String,
        default: "INR", // Can be customized per organization
      },
      timezone: {
        type: String,
        required: [true, "Default timezone is required"],
      },
    },
  },
  {
    timestamps: true, // Automatically manages createdAt and updatedAt fields
  }
);

// Serves the signup duplicate check, which must also match approved orgs (the partial
// unique index below covers pending only).
organizationSchema.index({ applicantEmail: 1, approvalStatus: 1 });

// One pending application per applicant email, enforced by MongoDB so concurrent
// signups cannot both slip past the read-then-write check in the signup service.
// The $type clause keeps legacy docs without applicantEmail out of the index.
organizationSchema.index(
  { applicantEmail: 1 },
  {
    unique: true,
    partialFilterExpression: {
      approvalStatus: "pending",
      applicantEmail: { $type: "string" },
    },
  }
);

// ==========================================
// Pre-query Hooks (Soft Delete Filter)
// ==========================================
organizationSchema.pre(/^find|countDocuments/, function (this: any, next) {
  const filter = this.getFilter();
  if (filter.isDelete === undefined) {
    filter.isDelete = { $ne: true };
  }
  next();
});

// TODO: Implement automatic slug generation from name if not provided.
// Since we don't have a shared slug helper yet, this will be handled in services/controllers for now.

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  return ret;
};

organizationSchema.set("toJSON", {
  transform: cleanTransform,
  virtuals: true,
});

organizationSchema.set("toObject", {
  transform: cleanTransform,
  virtuals: true,
});

const Organization = mongoose.model<IOrganization, OrganizationModel>(
  "Organization",
  organizationSchema
);

export default Organization;
export { Organization };
