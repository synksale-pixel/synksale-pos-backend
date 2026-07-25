/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Store model definition.
 * A Store represents a physical retail location or branch belonging to an Organization.
 * Enforces scoping via the tenantScopePlugin.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export interface IStore {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  code: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    country: string;
    postalCode: string;
  };
  timezone: string;
  isActive: boolean;
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type StoreDocument = Document<
  mongoose.Types.ObjectId,
  Record<string, never>,
  IStore
> &
  IStore;

export type StoreModel = mongoose.Model<IStore, Record<string, never>>;

const storeSchema = new Schema<IStore, StoreModel>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: [true, "Organization reference is required"],
      index: true,
    },
    name: {
      type: String,
      required: [true, "Store name is required"],
      trim: true,
    },
    code: {
      type: String,
      required: [true, "Store code is required"],
      trim: true,
      uppercase: true, // Auto-normalize code (e.g., "str-001" -> "STR-001")
    },
    address: {
      line1: {
        type: String,
        required: [true, "Address line 1 is required"],
        trim: true,
      },
      line2: { type: String, trim: true },
      city: { type: String, required: [true, "City is required"], trim: true },
      state: {
        type: String,
        required: [true, "State is required"],
        trim: true,
      },
      country: {
        type: String,
        required: [true, "Country is required"],
        trim: true,
      },
      postalCode: {
        type: String,
        required: [true, "Postal code is required"],
        trim: true,
      },
    },
    timezone: {
      type: String,
      required: [true, "Store timezone is required"],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true, // Quick checks to verify if the store is active
    },
    isDelete: {
      type: Boolean,
      default: false,
      index: true, // Supports soft delete
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Compound Unique Index: { organizationId: 1, code: 1 }
 * Why: A store code must be unique within an organization (e.g. Org A cannot have two "STR-001"),
 * but different organizations are allowed to have stores with the same code (e.g. Org A has "STR-001" and Org B has "STR-001").
 */
storeSchema.index({ organizationId: 1, code: 1 }, { unique: true });

// Apply the tenant scope plugin (Store is scoped at the organization level only, not store-level)
storeSchema.plugin(tenantScopePlugin, { scope: "organization" });

// ==========================================
// Schema Options & Transforms
// ==========================================
const cleanTransform = (_doc: any, ret: any) => {
  delete ret.__v;
  return ret;
};

storeSchema.set("toJSON", {
  transform: cleanTransform,
  virtuals: true,
});

storeSchema.set("toObject", {
  transform: cleanTransform,
  virtuals: true,
});

const Store = mongoose.model<IStore, StoreModel>("Store", storeSchema);

export default Store;
export { Store };
