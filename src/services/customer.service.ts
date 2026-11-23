/**
 * Purpose: Customer Service (Phase 4a-2).
 * Listing, the till's phone lookup, reading, creating, importing, updating and deleting an
 * organization's customers.
 *
 * Phone matching uses `phoneKey` (src/utils/phone.ts): the national number in the
 * organization's country, so "+973 3600 1234" and "36001234" are one customer. It is unique
 * per organization among non-deleted customers; a duplicate is 409 CUSTOMER_PHONE_EXISTS naming
 * the existing customer, so the till attaches them instead (and a retried create is safe).
 * Customer is organization-scoped by the tenantScopePlugin; organizationId is still passed
 * explicitly, as in every other service.
 */

import mongoose from "mongoose";
import { ZodError } from "zod";
import { Customer, CustomerDocument } from "../models/customer.model";
import { ApiError, ApiErrorDetail } from "../utils/ApiError";
import { buildPaginationMeta, resolvePaging } from "../utils/pagination";
import { phoneKey, PHONE_LOOKUP_MIN_DIGITS } from "../utils/phone";
import { taxIdProblem } from "../utils/taxId";
import { logger } from "../config/logger.config";
import { CountryDefinition, getCountryForCurrency } from "../config/currencies.config";
import { getOrganizationCurrency } from "./organization.service";
import { formatFieldPath } from "../middleware/errorHandler.middleware";
import {
  createCustomerSchema,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from "../validators/customer.validator";

export interface ListCustomersInput {
  search?: string;
  isActive?: boolean;
  hasTaxRegistrationNumber?: boolean;
  page?: number;
  limit?: number;
}

type PhoneCountry = Pick<CountryDefinition, "code" | "callingCode" | "nationalNumberLength" | "trunkZero">;

const ADDRESS_FIELDS = ["line1", "line2", "city", "state", "postalCode"] as const;

/** Suggestions the lookup returns besides the exact match. */
const LOOKUP_SUGGESTIONS = 4;

/** Used only if the organization's currency has no country (every supported one has): digits only. */
const NO_COUNTRY: PhoneCountry = { code: "", callingCode: "", nationalNumberLength: 0, trunkZero: false };

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ==========================================
// Errors
// ==========================================

function notFound(): ApiError {
  return ApiError.coded(404, "CUSTOMER_NOT_FOUND", "Customer not found.", [{ field: "customerId", code: "CUSTOMER_NOT_FOUND" }]);
}

/** Names the existing customer so the till can attach (or reactivate) them instead. */
function phoneExists(existing: Pick<CustomerDocument, "_id" | "isActive" | "name">): ApiError {
  const message = "A customer with this phone number already exists.";
  return ApiError.coded(409, "CUSTOMER_PHONE_EXISTS", message, [
    {
      field: "phone",
      code: "CUSTOMER_PHONE_EXISTS",
      message,
      meta: { customerId: existing._id.toString(), isActive: existing.isActive, name: existing.name },
    },
  ]);
}

function hasSales(saleCount: number): ApiError {
  return ApiError.coded(409, "CUSTOMER_HAS_SALES", "This customer has sales and cannot be deleted. Deactivate them instead.", [
    { code: "CUSTOMER_HAS_SALES", meta: { saleCount } },
  ]);
}

function isDuplicatePhone(error: unknown): boolean {
  const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
  return dup.code === 11000 && Boolean(dup.keyPattern?.phoneKey);
}

// ==========================================
// Helpers
// ==========================================

async function organizationCountry(organizationId: string): Promise<PhoneCountry> {
  return getCountryForCurrency(await getOrganizationCurrency(organizationId)) ?? NO_COUNTRY;
}

async function findCustomerOrThrow(organizationId: string, customerId: string) {
  const customer = await Customer.findOne({ _id: customerId, organizationId });
  if (!customer) throw notFound();
  return customer;
}

async function findByPhoneKey(organizationId: string, key: string, excludeId?: mongoose.Types.ObjectId) {
  const filter: Record<string, unknown> = { organizationId, phoneKey: key };
  if (excludeId) filter._id = { $ne: excludeId };
  return Customer.findOne(filter).select("_id isActive name");
}

/** Why a (normalised) tax number is not valid for the organization's country, or null. */
function trnProblem(country: PhoneCountry, trn: string | null | undefined): string | null {
  return trn ? taxIdProblem(country.code || null, trn) : null;
}

/** India only: the GST state code from the GSTIN's first two digits. */
function stateCodeFor(country: PhoneCountry, trn: string | null): string | null {
  return country.code === "IN" && trn ? trn.slice(0, 2) : null;
}

function toView(customer: CustomerDocument) {
  return {
    _id: customer._id,
    id: customer._id,
    organizationId: customer.organizationId,
    name: customer.name,
    phone: customer.phone,
    email: customer.email ?? null,
    address: Object.fromEntries(ADDRESS_FIELDS.map((field) => [field, customer.address?.[field] ?? null])),
    taxRegistrationNumber: customer.taxRegistrationNumber ?? null,
    stateCode: customer.stateCode ?? null,
    notes: customer.notes ?? null,
    isActive: customer.isActive,
    saleCount: customer.saleCount ?? 0,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

/** A new (unsaved) customer from validated create input. */
function buildCustomer(organizationId: string, country: PhoneCountry, input: CreateCustomerInput) {
  const taxRegistrationNumber = input.taxRegistrationNumber ?? null;
  return new Customer({
    organizationId: new mongoose.Types.ObjectId(organizationId),
    name: input.name,
    phone: input.phone,
    phoneKey: phoneKey(input.phone, country),
    email: input.email ?? null,
    address: Object.fromEntries(ADDRESS_FIELDS.map((field) => [field, input.address?.[field] ?? null])),
    taxRegistrationNumber,
    stateCode: stateCodeFor(country, taxRegistrationNumber),
    notes: input.notes ?? null,
    isActive: input.isActive ?? true,
  });
}

// ==========================================
// Reads
// ==========================================

/**
 * Paginated customers, newest first. `search` matches a case-insensitive prefix of any word of
 * the name, the start of the normalised phone (at least PHONE_LOOKUP_MIN_DIGITS digits), an
 * email prefix, or a tax number prefix.
 */
export async function listCustomers(organizationId: string, input: ListCustomersInput) {
  const { page, limit, skip } = resolvePaging(input);
  const filter: Record<string, unknown> = { organizationId };

  if (input.isActive !== undefined) filter.isActive = input.isActive;
  if (input.hasTaxRegistrationNumber !== undefined) {
    filter.taxRegistrationNumber = input.hasTaxRegistrationNumber ? { $ne: null } : null;
  }

  // A NUL byte makes MongoDB reject the regex (500); no customer text can contain one.
  const term = input.search?.replace(/\0/g, "").trim();
  if (term) {
    const lower = escapeRegex(term.toLowerCase());
    const or: Record<string, unknown>[] = [
      { nameKey: { $regex: `(^|\\s)${lower}` } },
      { email: { $regex: `^${lower}` } },
    ];
    const trn = term.replace(/[\s-]/g, "").toUpperCase();
    if (trn) or.push({ taxRegistrationNumber: { $regex: `^${escapeRegex(trn)}` } });
    if (term.replace(/\D/g, "").length >= PHONE_LOOKUP_MIN_DIGITS) {
      const key = phoneKey(term, await organizationCountry(organizationId));
      or.push({ phoneKey: { $regex: `^${escapeRegex(key)}` } });
    }
    filter.$or = or;
  }

  const [total, customers] = await Promise.all([
    Customer.countDocuments(filter),
    Customer.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
  ]);

  return {
    customers: customers.map(toView),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

/**
 * The till's phone lookup. `match` is the active customer whose phone key equals the input's;
 * `suggestions` are up to 4 other active customers whose key starts with it, shortest first.
 */
export async function lookupCustomer(organizationId: string, rawPhone: string | undefined) {
  const typed = rawPhone ?? "";
  const key = phoneKey(typed, await organizationCountry(organizationId));
  if (key.replace(/\D/g, "").length < PHONE_LOOKUP_MIN_DIGITS) {
    throw ApiError.invalidField("phone", `Type at least ${PHONE_LOOKUP_MIN_DIGITS} digits of the phone number.`);
  }

  const orgId = new mongoose.Types.ObjectId(organizationId);
  const [match, suggestionIds] = await Promise.all([
    Customer.findOne({ organizationId, phoneKey: key, isActive: true }),
    Customer.aggregate<{ _id: mongoose.Types.ObjectId }>([
      {
        $match: {
          organizationId: orgId,
          isActive: true,
          phoneKey: { $regex: `^${escapeRegex(key)}`, $ne: key },
        },
      },
      { $addFields: { keyLength: { $strLenCP: "$phoneKey" } } },
      { $sort: { keyLength: 1, phoneKey: 1, _id: 1 } },
      { $limit: LOOKUP_SUGGESTIONS },
      { $project: { _id: 1 } },
    ]),
  ]);

  const ids = suggestionIds.map((row) => row._id);
  const found = ids.length > 0 ? await Customer.find({ organizationId, _id: { $in: ids } }) : [];
  const byId = new Map(found.map((customer) => [customer._id.toString(), customer]));
  const suggestions = ids.flatMap((id) => {
    const customer = byId.get(id.toString());
    return customer ? [toView(customer)] : [];
  });

  return { match: match ? toView(match) : null, suggestions };
}

export async function getCustomer(organizationId: string, customerId: string) {
  return toView(await findCustomerOrThrow(organizationId, customerId));
}

// ==========================================
// Writes
// ==========================================

export async function createCustomer(organizationId: string, input: CreateCustomerInput, actorUserId: string) {
  const country = await organizationCountry(organizationId);
  const problem = trnProblem(country, input.taxRegistrationNumber);
  if (problem) throw ApiError.invalidField("taxRegistrationNumber", problem);

  const customer = buildCustomer(organizationId, country, input);
  const existing = await findByPhoneKey(organizationId, customer.phoneKey);
  if (existing) throw phoneExists(existing);

  try {
    await customer.save();
  } catch (error) {
    if (isDuplicatePhone(error)) {
      const winner = await findByPhoneKey(organizationId, customer.phoneKey);
      if (winner) throw phoneExists(winner);
    }
    throw error;
  }

  logger.info(`Customer created: ${customer._id} org=${organizationId} by user=${actorUserId}`);
  return toView(customer);
}

/**
 * Applies the sent fields; null clears an optional one and `address` merges field by field.
 * A changed phone is checked for duplicates like a create.
 */
export async function updateCustomer(organizationId: string, customerId: string, input: UpdateCustomerInput, actorUserId: string) {
  const customer = await findCustomerOrThrow(organizationId, customerId);
  const country = await organizationCountry(organizationId);

  const problem = trnProblem(country, input.taxRegistrationNumber);
  if (problem) throw ApiError.invalidField("taxRegistrationNumber", problem);

  if (input.phone !== undefined) {
    const key = phoneKey(input.phone, country);
    if (key !== customer.phoneKey) {
      const existing = await findByPhoneKey(organizationId, key, customer._id);
      if (existing) throw phoneExists(existing);
    }
    customer.phone = input.phone;
    customer.phoneKey = key;
  }

  const set = <T>(path: string, value: T | undefined) => {
    if (value !== undefined) customer.set(path, value);
  };
  set("name", input.name);
  set("email", input.email);
  set("notes", input.notes);
  set("isActive", input.isActive);
  if (input.taxRegistrationNumber !== undefined) {
    customer.taxRegistrationNumber = input.taxRegistrationNumber;
    customer.stateCode = stateCodeFor(country, input.taxRegistrationNumber);
  }
  if (input.address === null) {
    for (const field of ADDRESS_FIELDS) customer.set(`address.${field}`, null);
  } else if (input.address) {
    for (const field of ADDRESS_FIELDS) set(`address.${field}`, input.address[field]);
  }

  try {
    await customer.save();
  } catch (error) {
    if (isDuplicatePhone(error)) {
      const winner = await findByPhoneKey(organizationId, customer.phoneKey, customer._id);
      if (winner) throw phoneExists(winner);
    }
    throw error;
  }

  logger.info(`Customer updated: ${customerId} org=${organizationId} by user=${actorUserId}`);
  return toView(customer);
}

/**
 * Soft-deletes a customer with no sales; the phone number becomes free again. Conditional on
 * `saleCount` being 0 in the same write, so from 4c a sale incrementing it can't interleave.
 */
export async function deleteCustomer(organizationId: string, customerId: string, actorUserId: string) {
  const customer = await findCustomerOrThrow(organizationId, customerId);
  const deleted = await Customer.updateOne(
    { _id: customer._id, organizationId, saleCount: { $not: { $gt: 0 } } },
    { $set: { isDelete: true } }
  );
  if (deleted.matchedCount === 0) {
    const current = await Customer.findOne({ _id: customer._id, organizationId });
    if (!current) throw notFound();
    throw hasSales(current.saleCount);
  }
  logger.info(`Customer deleted: ${customerId} org=${organizationId} by user=${actorUserId}`);
}

// ==========================================
// Import
// ==========================================

type ImportStatus = "created" | "duplicate" | "invalid";

interface ImportResult {
  row: number;
  status: ImportStatus;
  customerId: string | null;
  errors: ApiErrorDetail[];
}

function zodErrors(error: ZodError): ApiErrorDetail[] {
  return error.issues.map((issue) => ({
    field: formatFieldPath(issue.path) || undefined,
    code: "VALIDATION_FAILED",
    message: issue.message,
  }));
}

/**
 * Imports customers row by row: each row is validated like a create, and partial success is
 * normal. A row whose phone belongs to an existing customer, or to an earlier row of this
 * import, is a `duplicate` naming that customer; existing customers are never changed, so the
 * same file can be sent again. New customers are written with one unordered insertMany; a row
 * beaten by a concurrent create (duplicate key) is reported as a duplicate of the winner.
 */
export async function importCustomers(organizationId: string, rows: Record<string, unknown>[], actorUserId: string) {
  const country = await organizationCountry(organizationId);
  const results: ImportResult[] = rows.map((_row, index) => ({ row: index + 1, status: "invalid", customerId: null, errors: [] }));

  // 1. Validate each row on its own.
  const valid: { index: number; doc: CustomerDocument }[] = [];
  rows.forEach((row, index) => {
    const parsed = createCustomerSchema.safeParse(row);
    if (!parsed.success) {
      results[index].errors = zodErrors(parsed.error);
      return;
    }
    const problem = trnProblem(country, parsed.data.taxRegistrationNumber);
    if (problem) {
      results[index].errors = [{ field: "taxRegistrationNumber", code: "VALIDATION_FAILED", message: problem }];
      return;
    }
    valid.push({ index, doc: buildCustomer(organizationId, country, parsed.data) });
  });

  // 2. Existing customers, in one query.
  const keys = [...new Set(valid.map(({ doc }) => doc.phoneKey))];
  const existing = keys.length
    ? await Customer.find({ organizationId, phoneKey: { $in: keys } }).select("_id phoneKey")
    : [];
  const ownerOfKey = new Map(existing.map((customer) => [customer.phoneKey, customer._id.toString()]));

  // 3. Duplicates of existing customers or of earlier rows; the rest are to be created.
  const toCreate: { index: number; doc: CustomerDocument }[] = [];
  for (const entry of valid) {
    const owner = ownerOfKey.get(entry.doc.phoneKey);
    if (owner) {
      results[entry.index] = { ...results[entry.index], status: "duplicate", customerId: owner };
      continue;
    }
    ownerOfKey.set(entry.doc.phoneKey, entry.doc._id.toString());
    results[entry.index] = { ...results[entry.index], status: "created", customerId: entry.doc._id.toString() };
    toCreate.push(entry);
  }

  // 4. Write. A duplicate key means a concurrent create took the number first.
  const lost = new Set<number>();
  if (toCreate.length > 0) {
    try {
      await Customer.insertMany(
        toCreate.map(({ doc }) => doc),
        { ordered: false }
      );
    } catch (error) {
      const writeErrors = (error as { writeErrors?: { index: number; code?: number; err?: { code?: number } }[] }).writeErrors;
      if (!writeErrors?.length) throw error;
      for (const writeError of writeErrors) {
        const code = writeError.code ?? writeError.err?.code;
        if (code !== 11000) throw error;
        lost.add(writeError.index);
      }
    }
  }

  if (lost.size > 0) {
    const lostKeys = [...lost].map((i) => toCreate[i].doc.phoneKey);
    const winners = await Customer.find({ organizationId, phoneKey: { $in: lostKeys } }).select("_id phoneKey");
    const winnerOfKey = new Map(winners.map((customer) => [customer.phoneKey, customer._id.toString()]));
    const remapped = new Map<string, string>();
    for (const i of lost) {
      const { index, doc } = toCreate[i];
      const winner = winnerOfKey.get(doc.phoneKey) ?? null;
      remapped.set(doc._id.toString(), winner ?? "");
      results[index] = { ...results[index], status: "duplicate", customerId: winner };
    }
    // Later rows that were duplicates of a lost row now point at the winner.
    for (const result of results) {
      if (result.status === "duplicate" && result.customerId && remapped.has(result.customerId)) {
        result.customerId = remapped.get(result.customerId) || null;
      }
    }
  }

  const count = (status: ImportStatus) => results.filter((result) => result.status === status).length;
  const summary = { received: rows.length, created: count("created"), duplicate: count("duplicate"), invalid: count("invalid") };

  logger.info(
    `Customers imported: org=${organizationId} by user=${actorUserId} received=${summary.received} created=${summary.created} duplicate=${summary.duplicate} invalid=${summary.invalid}`
  );
  return { summary, results };
}
