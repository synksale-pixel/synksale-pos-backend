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
  isActive: boolean;
  isDelete: boolean;
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
