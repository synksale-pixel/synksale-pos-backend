/**
 * Purpose: Vendor Service.
 * Listing, reading, creating, updating and deleting an organization's vendors, plus the vendor
 * references products show for their preferred vendor.
 * Vendor is organization-scoped by the tenantScopePlugin; organizationId is still passed
 * explicitly, as in every other service.
 */

import mongoose from "mongoose";
import { Vendor, VendorDocument, VatTreatment } from "../models/vendor.model";
import { Product } from "../models/product.model";
import { ApiError } from "../utils/ApiError";
import { buildPaginationMeta, resolvePaging } from "../utils/pagination";
import { logger } from "../config/logger.config";
import { getCountryForCurrency } from "../config/currencies.config";
import { getOrganizationCurrency } from "./organization.service";
import type { CreateVendorInput, UpdateVendorInput } from "../validators/vendor.validator";

export interface ListVendorsInput {
  search?: string;
  isActive?: boolean;
  countryCode?: string;
  vatTreatment?: string;
  page?: number;
  limit?: number;
}

const ADDRESS_FIELDS = ["line1", "line2", "city", "state", "postalCode"] as const;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Phone search needs this many digits, so "+973" alone does not match every local vendor. */
const MIN_PHONE_SEARCH_DIGITS = 4;

function nameTaken(name: string): ApiError {
  return ApiError.coded(409, "VENDOR_NAME_TAKEN", `A vendor named '${name}' already exists.`, [
    { field: "name", code: "VENDOR_NAME_TAKEN" },
  ]);
}

function trnRequired(): ApiError {
  return ApiError.coded(400, "VALIDATION_FAILED", "A vat_registered vendor needs a taxRegistrationNumber.", [
    { field: "taxRegistrationNumber", code: "VALIDATION_FAILED" },
  ]);
}

function isDuplicateKey(error: unknown, field: string): boolean {
  const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
  return dup.code === 11000 && Boolean(dup.keyPattern?.[field]);
}

async function findVendorOrThrow(organizationId: string, vendorId: string) {
  const vendor = await Vendor.findOne({ _id: vendorId, organizationId });
  if (!vendor) {
    throw ApiError.coded(404, "VENDOR_NOT_FOUND", "Vendor not found.", [{ field: "vendorId", code: "VENDOR_NOT_FOUND" }]);
  }
  return vendor;
}

/** The organization's own country, from its currency (each supported currency has one). */
async function homeCountry(organizationId: string): Promise<string | null> {
  return getCountryForCurrency(await getOrganizationCurrency(organizationId))?.code ?? null;
}

/** The default when a vendor is created without one: TRN first, then foreign vs. local. */
function deriveVatTreatment(taxRegistrationNumber: string | null, countryCode: string, home: string | null): VatTreatment {
  if (taxRegistrationNumber) return "vat_registered";
  return home !== null && countryCode !== home ? "overseas" : "not_registered";
}

/** Products naming each vendor as their preferred vendor. One grouped read per page. */
async function productCounts(organizationId: string, vendorIds: mongoose.Types.ObjectId[]): Promise<Map<string, number>> {
  if (vendorIds.length === 0) return new Map();
  const rows = await Product.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    {
      $match: {
        organizationId: new mongoose.Types.ObjectId(organizationId),
        "purchase.preferredVendorId": { $in: vendorIds },
      },
    },
    { $group: { _id: "$purchase.preferredVendorId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
}

function toView(vendor: VendorDocument, counts: Map<string, number>) {
  return {
    _id: vendor._id,
    id: vendor._id,
    organizationId: vendor.organizationId,
    name: vendor.name,
    legalName: vendor.legalName ?? null,
    taxRegistrationNumber: vendor.taxRegistrationNumber ?? null,
    countryCode: vendor.countryCode,
    vatTreatment: vendor.vatTreatment,
    contactName: vendor.contactName ?? null,
    email: vendor.email ?? null,
    phone: vendor.phone ?? null,
    address: Object.fromEntries(ADDRESS_FIELDS.map((field) => [field, vendor.address?.[field] ?? null])),
    paymentTermsDays: vendor.paymentTermsDays,
    notes: vendor.notes ?? null,
    isActive: vendor.isActive,
    productCount: counts.get(vendor._id.toString()) ?? 0,
    createdAt: vendor.createdAt,
    updatedAt: vendor.updatedAt,
  };
}

async function toSingleView(organizationId: string, vendor: VendorDocument) {
  return toView(vendor, await productCounts(organizationId, [vendor._id]));
}

// ==========================================
// Reads
// ==========================================

/**
 * Paginated vendors by name. `search` matches a name or legal name prefix, a TRN prefix (the
 * term normalised like the field), an email prefix, or the term's digits anywhere in the phone.
 * Filters are lenient like the other list endpoints: an unknown country or VAT treatment simply
 * matches nothing.
 */
export async function listVendors(organizationId: string, input: ListVendorsInput) {
  const { page, limit, skip } = resolvePaging(input);
  const filter: Record<string, unknown> = { organizationId };

  if (input.isActive !== undefined) filter.isActive = input.isActive;
  if (input.countryCode) filter.countryCode = input.countryCode.trim().toUpperCase();
  if (input.vatTreatment) filter.vatTreatment = input.vatTreatment.trim();

  // A NUL byte makes MongoDB reject the regex (500); no vendor text can contain one.
  const term = input.search?.replace(/\0/g, "").trim();
  if (term) {
    const lower = escapeRegex(term.toLowerCase());
    const or: Record<string, unknown>[] = [
      { nameKey: { $regex: `^${lower}` } },
      { legalName: { $regex: `^${escapeRegex(term)}`, $options: "i" } },
      { email: { $regex: `^${lower}` } },
    ];
    const trn = term.replace(/[\s-]/g, "").toUpperCase();
    if (trn) or.push({ taxRegistrationNumber: { $regex: `^${escapeRegex(trn)}` } });
    const digits = term.replace(/\D/g, "");
    if (digits.length >= MIN_PHONE_SEARCH_DIGITS) or.push({ phoneKey: { $regex: digits } });
    filter.$or = or;
  }

  const [total, vendors] = await Promise.all([
    Vendor.countDocuments(filter),
    Vendor.find(filter).sort({ nameKey: 1, _id: 1 }).skip(skip).limit(limit),
  ]);
  const counts = await productCounts(
    organizationId,
    vendors.map((vendor) => vendor._id)
  );

  return {
    vendors: vendors.map((vendor) => toView(vendor, counts)),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

export async function getVendor(organizationId: string, vendorId: string) {
  return toSingleView(organizationId, await findVendorOrThrow(organizationId, vendorId));
}

export interface VendorRef {
  id: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
}

/** The {id, name, isActive} references products show, keyed by vendor id. Deleted vendors are absent. */
export async function vendorRefs(
  organizationId: string,
  vendorIds: mongoose.Types.ObjectId[]
): Promise<Map<string, VendorRef>> {
  if (vendorIds.length === 0) return new Map();
  const vendors = await Vendor.find({ organizationId, _id: { $in: vendorIds } }).select("name isActive");
  return new Map(vendors.map((vendor) => [vendor._id.toString(), { id: vendor._id, name: vendor.name, isActive: vendor.isActive }]));
}

/**
 * Confirms a vendor can be chosen as a product's preferred vendor. A missing or inactive one is
 * the caller's input error (400), not a missing resource of the request path.
 */
export async function assertVendorSelectable(organizationId: string, vendorId: string, field: string) {
  const vendor = await Vendor.findOne({ _id: vendorId, organizationId }).select("isActive");
  if (!vendor) {
    throw ApiError.coded(400, "VENDOR_NOT_FOUND", "Vendor not found.", [{ field, code: "VENDOR_NOT_FOUND" }]);
  }
  if (!vendor.isActive) {
    throw ApiError.coded(400, "VENDOR_INACTIVE", "This vendor is inactive. Activate it or choose another vendor.", [
      { field, code: "VENDOR_INACTIVE" },
    ]);
  }
}

// ==========================================
// Writes
// ==========================================

export async function createVendor(organizationId: string, input: CreateVendorInput, actorUserId: string) {
  const home = await homeCountry(organizationId);
  const countryCode = input.countryCode ?? home;
  if (!countryCode) {
    throw ApiError.coded(400, "VALIDATION_FAILED", "countryCode is required.", [{ field: "countryCode", code: "VALIDATION_FAILED" }]);
  }
  const taxRegistrationNumber = input.taxRegistrationNumber ?? null;

  const vendor = new Vendor({
    organizationId: new mongoose.Types.ObjectId(organizationId),
    name: input.name,
    legalName: input.legalName ?? null,
    taxRegistrationNumber,
    countryCode,
    vatTreatment: input.vatTreatment ?? deriveVatTreatment(taxRegistrationNumber, countryCode, home),
    contactName: input.contactName ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    address: Object.fromEntries(ADDRESS_FIELDS.map((field) => [field, input.address?.[field] ?? null])),
    paymentTermsDays: input.paymentTermsDays ?? 0,
    notes: input.notes ?? null,
    isActive: input.isActive ?? true,
  });

  if (await Vendor.exists({ organizationId, nameKey: input.name.trim().toLowerCase() })) {
    throw nameTaken(input.name);
  }
  try {
    await vendor.save();
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) throw nameTaken(input.name);
    throw error;
  }

  logger.info(`Vendor created: ${vendor._id} org=${organizationId} by user=${actorUserId}`);
  return toSingleView(organizationId, vendor);
}

/**
 * Applies the sent fields; null clears an optional one and `address` merges field by field.
 * vatTreatment is never re-derived: it changes only when sent.
 */
export async function updateVendor(organizationId: string, vendorId: string, input: UpdateVendorInput, actorUserId: string) {
  const vendor = await findVendorOrThrow(organizationId, vendorId);

  if (input.name !== undefined) {
    const nameKey = input.name.trim().toLowerCase();
    if (nameKey !== vendor.nameKey && (await Vendor.exists({ organizationId, nameKey }))) {
      throw nameTaken(input.name);
    }
  }

  const trn = input.taxRegistrationNumber !== undefined ? input.taxRegistrationNumber : vendor.taxRegistrationNumber;
  const treatment = input.vatTreatment ?? vendor.vatTreatment;
  if (treatment === "vat_registered" && !trn) {
    throw trnRequired();
  }

  const set = <T>(path: string, value: T | undefined) => {
    if (value !== undefined) vendor.set(path, value);
  };
  set("name", input.name);
  set("legalName", input.legalName);
  set("taxRegistrationNumber", input.taxRegistrationNumber);
  set("countryCode", input.countryCode);
  set("vatTreatment", input.vatTreatment);
  set("contactName", input.contactName);
  set("email", input.email);
  set("phone", input.phone);
  set("paymentTermsDays", input.paymentTermsDays);
  set("notes", input.notes);
  set("isActive", input.isActive);
  if (input.address === null) {
    for (const field of ADDRESS_FIELDS) vendor.set(`address.${field}`, null);
  } else if (input.address) {
    for (const field of ADDRESS_FIELDS) set(`address.${field}`, input.address[field]);
  }

  try {
    // save() (not findOneAndUpdate) so the pre-validate hook re-derives nameKey and phoneKey.
    await vendor.save();
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) throw nameTaken(input.name ?? vendor.name);
    throw error;
  }

  logger.info(`Vendor updated: ${vendorId} org=${organizationId} by user=${actorUserId}`);
  return toSingleView(organizationId, vendor);
}

/**
 * Soft-deletes a vendor and clears it from products' preferred vendor in the same transaction;
 * the name becomes reusable. A product saved with this vendor while the delete runs can keep a
 * dangling reference, which reads as null (accepted: it is only a hint). Phase 3b adds the
 * VENDOR_IN_USE refusal for vendors with purchase documents, claim-style so a document cannot
 * attach to a vendor being deleted.
 */
export async function deleteVendor(organizationId: string, vendorId: string, actorUserId: string) {
  const vendor = await findVendorOrThrow(organizationId, vendorId);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Vendor.updateOne({ _id: vendor._id, organizationId }, { $set: { isDelete: true } }, { session });
      await Product.updateMany(
        { organizationId, "purchase.preferredVendorId": vendor._id },
        { $set: { "purchase.preferredVendorId": null } },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  logger.info(`Vendor deleted: ${vendorId} org=${organizationId} by user=${actorUserId}`);
}
