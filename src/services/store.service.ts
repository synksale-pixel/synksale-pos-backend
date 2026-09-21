/**
 * Purpose: Store Service.
 * Handles creating, listing, reading, updating and (de)activating stores.
 * Store is organization-scoped by the tenantScopePlugin for reads and updates, but the plugin
 * does not cover create(), so organizationId is always set explicitly here.
 */

import mongoose from "mongoose";
import { Store } from "../models/store.model";
import { IUser } from "../models/user.model";
import { hasOrganizationScopeRole } from "./permission.service";
import { ApiError } from "../utils/ApiError";
import { logger } from "../config/logger.config";
import type { CreateStoreInput, UpdateStoreInput } from "../validators/store.validator";

export interface ListStoresInput {
  page?: number;
  limit?: number;
  isActive?: boolean;
}

/**
 * Creates a store in the caller's organization. The organizationId always comes from the
 * authenticated context, never from the request body.
 */
export async function createStore(
  organizationId: string,
  input: CreateStoreInput,
  actorUserId: string
) {
  const code = input.code.trim().toUpperCase();

  const existing = await Store.findOne({ organizationId, code });
  if (existing) {
    throw new ApiError(409, `A store with code '${code}' already exists in your organization.`);
  }

  const store = await Store.create({
    organizationId: new mongoose.Types.ObjectId(organizationId),
    name: input.name,
    code,
    address: input.address,
    timezone: input.timezone,
  });

  logger.info(`Store created: ${store._id} (${code}) org=${organizationId} by user=${actorUserId}`);
  return store;
}

/**
 * Lists stores the caller can access: every store for organization-scoped roles (e.g. org_admin),
 * otherwise only the stores in the caller's storeAccess assignments.
 */
export async function listStores(
  organizationId: string,
  user: IUser,
  input: ListStoresInput
) {
  const page = input.page && input.page > 0 ? input.page : 1;
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20;

  const filter: Record<string, unknown> = { organizationId };
  if (input.isActive !== undefined) {
    filter.isActive = input.isActive;
  }
  if (!hasOrganizationScopeRole(user)) {
    filter._id = { $in: (user.storeAccess ?? []).map((access) => access.storeId) };
  }

  const [stores, total] = await Promise.all([
    Store.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Store.countDocuments(filter),
  ]);

  return {
    stores,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Fetches one store in the caller's organization. Access to the specific store is enforced
 * by the scopeToStore middleware before this runs.
 */
export async function getStore(organizationId: string, storeId: string) {
  const store = await Store.findOne({ _id: storeId, organizationId });
  if (!store) {
    throw new ApiError(404, "Store not found.");
  }
  return store;
}

/**
 * Updates name, address (partial) and/or timezone. `code` is immutable.
 */
export async function updateStore(
  organizationId: string,
  storeId: string,
  input: UpdateStoreInput,
  actorUserId: string
) {
  const $set: Record<string, unknown> = {};
  if (input.name !== undefined) $set.name = input.name;
  if (input.timezone !== undefined) $set.timezone = input.timezone;
  if (input.address) {
    for (const [key, value] of Object.entries(input.address)) {
      if (value !== undefined) $set[`address.${key}`] = value;
    }
  }

  const store = await Store.findOneAndUpdate(
    { _id: storeId, organizationId },
    { $set },
    { new: true, runValidators: true }
  );
  if (!store) {
    throw new ApiError(404, "Store not found.");
  }

  logger.info(`Store updated: ${storeId} org=${organizationId} by user=${actorUserId}`);
  return store;
}

/**
 * Activates or deactivates a store. Idempotent. User storeAccess assignments are left untouched
 * so reactivation restores access; scopeToStore blocks store-scoped requests while inactive.
 */
export async function setStoreActive(
  organizationId: string,
  storeId: string,
  isActive: boolean,
  actorUserId: string
) {
  const store = await Store.findOneAndUpdate(
    { _id: storeId, organizationId },
    { $set: { isActive } },
    { new: true }
  );
  if (!store) {
    throw new ApiError(404, "Store not found.");
  }

  logger.info(
    `Store ${isActive ? "activated" : "deactivated"}: ${storeId} org=${organizationId} by user=${actorUserId}`
  );
  return store;
}
