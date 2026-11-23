/**
 * Purpose: Store Service.
 * Handles creating, listing, reading, updating and (de)activating stores.
 * Store is organization-scoped by the tenantScopePlugin for reads and updates, but the plugin
 * does not cover create(), so organizationId is always set explicitly here.
 *
 * Every store response carries `effective` { legalName, legalNameAr, taxRegistrationNumber }:
 * what the till prints, the store's own value else the organization's (see storeView).
 */

import mongoose from "mongoose";
import { Store, StoreDocument } from "../models/store.model";
import { Organization } from "../models/organization.model";
import { IUser } from "../models/user.model";
import { hasOrganizationScopeRole } from "./permission.service";
import { assertCountryMatchesCurrency } from "./organization.service";
import { hasSaleNumbers } from "./documentNumber.service";
import { createDefaultRegister } from "./register.service";
import { ApiError } from "../utils/ApiError";
import { taxIdProblem } from "../utils/taxId";
import { logger } from "../config/logger.config";
import { getRequestContext, runWithStoreContext } from "../utils/requestContext";
import type { CreateStoreInput, UpdateStoreInput } from "../validators/store.validator";

export interface ListStoresInput {
  page?: number;
  limit?: number;
  isActive?: boolean;
}

/** The organization fields a store falls back to. */
interface OrgIdentity {
  name: string;
  legalName: string | null;
  legalNameAr: string | null;
  taxRegistrationNumber: string | null;
}

async function orgIdentity(organizationId: string): Promise<OrgIdentity> {
  const org = await Organization.findById(organizationId).select("name legalName legalNameAr taxRegistrationNumber");
  if (!org) {
    throw ApiError.coded(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
  }
  return {
    name: org.name,
    legalName: org.legalName ?? null,
    legalNameAr: org.legalNameAr ?? null,
    taxRegistrationNumber: org.taxRegistrationNumber ?? null,
  };
}

/**
 * The store response: every 4a-1 field present (null when unset, also on stores created before
 * them) plus `effective`. The legal name falls back to the organization's legal name, then its
 * name, so a receipt always has one; a null effective TRN means the store is not VAT/GST-registered.
 */
export function storeView(store: StoreDocument, org: OrgIdentity) {
  const json = store.toJSON() as Record<string, unknown> & { address: Record<string, unknown> };
  return {
    ...json,
    address: { ...json.address, stateCode: store.address?.stateCode ?? null },
    legalName: store.legalName ?? null,
    legalNameAr: store.legalNameAr ?? null,
    taxRegistrationNumber: store.taxRegistrationNumber ?? null,
    phone: store.phone ?? null,
    email: store.email ?? null,
    invoicePrefix: store.invoicePrefix ?? null,
    receipt: {
      headerText: store.receipt?.headerText ?? null,
      footerText: store.receipt?.footerText ?? null,
    },
    effective: {
      legalName: store.legalName ?? org.legalName ?? org.name,
      legalNameAr: store.legalNameAr ?? org.legalNameAr,
      taxRegistrationNumber: store.taxRegistrationNumber ?? org.taxRegistrationNumber,
    },
  };
}

/** A store's tax identity after a create or update, checked as a whole. */
interface TaxIdentity {
  countryCode: string | null;
  stateCode: string | null;
  taxRegistrationNumber: string | null;
}

/**
 * Country rules that need the stored store and the organization, not just the request body:
 * - a store in India needs its GST state code; other stores must not have one;
 * - the store's own TRN fits its country (an Indian GSTIN starts with the store's state code);
 * - an Indian store using the organization's GSTIN must be in that GSTIN's state.
 */
function assertTaxIdentity(identity: TaxIdentity, org: OrgIdentity) {
  const { countryCode, stateCode, taxRegistrationNumber: own } = identity;
  if (countryCode === "IN" && !stateCode) {
    throw ApiError.invalidField("address.stateCode", "A store in India needs its two-digit GST state code (e.g. 29 for Karnataka).");
  }
  if (countryCode !== "IN" && stateCode) {
    throw ApiError.invalidField("address.stateCode", "stateCode is only for stores in India.");
  }
  if (own) {
    const problem = taxIdProblem(countryCode, own);
    if (problem) throw ApiError.invalidField("taxRegistrationNumber", problem);
    if (countryCode === "IN" && own.slice(0, 2) !== stateCode) {
      throw ApiError.invalidField("taxRegistrationNumber", `GSTIN must start with the store's stateCode (${stateCode}).`);
    }
  } else if (countryCode === "IN" && org.taxRegistrationNumber && org.taxRegistrationNumber.slice(0, 2) !== stateCode) {
    throw ApiError.invalidField(
      "taxRegistrationNumber",
      `This store is in state ${stateCode}, but the organization's GSTIN is for state ${org.taxRegistrationNumber.slice(0, 2)}. A GSTIN is per state: set this store's own GSTIN.`
    );
  }
}

function prefixTaken(prefix: string): ApiError {
  return ApiError.coded(409, "INVOICE_PREFIX_TAKEN", `Another store already uses the invoice prefix '${prefix}'.`, [
    { field: "invoicePrefix", code: "INVOICE_PREFIX_TAKEN" },
  ]);
}

function isDuplicatePrefix(error: unknown): boolean {
  const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
  return dup.code === 11000 && Boolean(dup.keyPattern?.invoicePrefix);
}

async function assertPrefixFree(organizationId: string, prefix: string, storeId?: string) {
  const filter: Record<string, unknown> = { organizationId, invoicePrefix: prefix };
  if (storeId) filter._id = { $ne: storeId };
  if (await Store.exists(filter)) throw prefixTaken(prefix);
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

  await assertCountryMatchesCurrency(organizationId, input.countryCode);
  const org = await orgIdentity(organizationId);
  assertTaxIdentity(
    {
      countryCode: input.countryCode,
      stateCode: input.address.stateCode ?? null,
      taxRegistrationNumber: input.taxRegistrationNumber ?? null,
    },
    org
  );
  if (input.invoicePrefix) await assertPrefixFree(organizationId, input.invoicePrefix);

  // The store and its "Register 1" are created together, so the till works without set-up.
  let store!: StoreDocument;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      [store] = (await Store.create(
        [
          {
            organizationId: new mongoose.Types.ObjectId(organizationId),
            name: input.name,
            code,
            address: { ...input.address, stateCode: input.address.stateCode ?? null },
            countryCode: input.countryCode,
            timezone: input.timezone,
            legalName: input.legalName ?? null,
            legalNameAr: input.legalNameAr ?? null,
            taxRegistrationNumber: input.taxRegistrationNumber ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            invoicePrefix: input.invoicePrefix ?? null,
            receipt: {
              headerText: input.receipt?.headerText ?? null,
              footerText: input.receipt?.footerText ?? null,
            },
          },
        ],
        { session }
      )) as StoreDocument[];
      await createDefaultRegister(store.organizationId, store._id, session);
    });
  } catch (error) {
    if (isDuplicatePrefix(error)) throw prefixTaken(input.invoicePrefix!);
    throw error;
  } finally {
    await session.endSession();
  }

  logger.info(`Store created: ${store._id} (${code}) org=${organizationId} by user=${actorUserId}`);
  return storeView(store, org);
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

  const [stores, total, org] = await Promise.all([
    Store.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Store.countDocuments(filter),
    orgIdentity(organizationId),
  ]);

  return {
    stores: stores.map((store) => storeView(store as StoreDocument, org)),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Fetches one store in the caller's organization. Access to the specific store is enforced
 * by the scopeToStore middleware before this runs.
 */
export async function getStore(organizationId: string, storeId: string) {
  const [store, org] = await Promise.all([Store.findOne({ _id: storeId, organizationId }), orgIdentity(organizationId)]);
  if (!store) {
    throw new ApiError(404, "Store not found.");
  }
  return storeView(store as StoreDocument, org);
}

/**
 * Updates any field but `code` (immutable). Address and receipt are partial. The country, state
 * code and TRN are re-checked together whenever one of them changes.
 */
export async function updateStore(
  organizationId: string,
  storeId: string,
  input: UpdateStoreInput,
  actorUserId: string
) {
  const store = (await Store.findOne({ _id: storeId, organizationId })) as StoreDocument | null;
  if (!store) {
    throw new ApiError(404, "Store not found.");
  }
  const org = await orgIdentity(organizationId);

  const $set: Record<string, unknown> = {};
  if (input.name !== undefined) $set.name = input.name;
  if (input.timezone !== undefined) $set.timezone = input.timezone;
  if (input.countryCode !== undefined) {
    await assertCountryMatchesCurrency(organizationId, input.countryCode);
    $set.countryCode = input.countryCode;
  }
  if (input.address) {
    for (const [key, value] of Object.entries(input.address)) {
      if (value !== undefined) $set[`address.${key}`] = value;
    }
  }
  for (const field of ["legalName", "legalNameAr", "taxRegistrationNumber", "phone", "email"] as const) {
    if (input[field] !== undefined) $set[field] = input[field];
  }
  if (input.receipt) {
    for (const [key, value] of Object.entries(input.receipt)) {
      if (value !== undefined) $set[`receipt.${key}`] = value;
    }
  }

  // ---- Tax identity: country, state code and TRN as they will be after this update ----
  const countryCode = input.countryCode ?? store.countryCode ?? null;
  let stateCode = input.address?.stateCode !== undefined ? input.address.stateCode : (store.address?.stateCode ?? null);
  if (countryCode !== "IN" && stateCode && input.address?.stateCode === undefined) {
    // Moved out of India (only possible for a store created before countryCode existed).
    stateCode = null;
    $set["address.stateCode"] = null;
  }
  const touchesTaxIdentity =
    input.countryCode !== undefined || input.address?.stateCode !== undefined || input.taxRegistrationNumber !== undefined;
  if (touchesTaxIdentity || (countryCode === "IN" && !stateCode)) {
    assertTaxIdentity(
      {
        countryCode,
        stateCode,
        taxRegistrationNumber:
          input.taxRegistrationNumber !== undefined ? input.taxRegistrationNumber : (store.taxRegistrationNumber ?? null),
      },
      org
    );
  }

  // ---- Invoice prefix: unique, and fixed once the store has a sale ----
  if (input.invoicePrefix !== undefined && input.invoicePrefix !== store.invoicePrefix) {
    if (store.invoicePrefix && (await hasSaleNumbers(organizationId, storeId))) {
      throw ApiError.coded(
        409,
        "INVOICE_PREFIX_LOCKED",
        `The invoice prefix cannot change once the store has made a sale: its invoices are numbered ${store.invoicePrefix}-...`,
        [{ field: "invoicePrefix", code: "INVOICE_PREFIX_LOCKED" }]
      );
    }
    await assertPrefixFree(organizationId, input.invoicePrefix, storeId);
    $set.invoicePrefix = input.invoicePrefix;
  }

  let updated: StoreDocument | null;
  try {
    updated = (await Store.findOneAndUpdate(
      { _id: storeId, organizationId },
      { $set },
      { new: true, runValidators: true }
    )) as StoreDocument | null;
  } catch (error) {
    if (isDuplicatePrefix(error)) throw prefixTaken(input.invoicePrefix!);
    throw error;
  }
  if (!updated) {
    throw new ApiError(404, "Store not found.");
  }

  logger.info(`Store updated: ${storeId} org=${organizationId} by user=${actorUserId}`);
  return storeView(updated, org);
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
  return storeView(store as StoreDocument, await orgIdentity(organizationId));
}

/**
 * Runs `fn` scoped to another store of the caller's organization — the only sanctioned way for a
 * store-scoped request to touch a second store (e.g. the destination of an inventory transfer).
 * Verifies the store exists and is not deleted in the context organization before switching;
 * whether the caller may act on it (permissions, isActive) is still the calling service's call.
 */
export async function runInOrganizationStore<T>(
  storeId: string,
  fn: () => T | PromiseLike<T>
): Promise<T> {
  const organizationId = getRequestContext()?.organizationId;
  if (!organizationId) {
    throw new ApiError(500, "runInOrganizationStore requires an organization context.");
  }
  const exists =
    mongoose.Types.ObjectId.isValid(storeId) &&
    (await Store.exists({ _id: storeId, organizationId }));
  if (!exists) {
    throw new ApiError(404, "Store not found.");
  }
  return runWithStoreContext(storeId, fn);
}
