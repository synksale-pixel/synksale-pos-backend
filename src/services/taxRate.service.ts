/**
 * Purpose: Tax Rate Service.
 * Creating, listing, updating, (de)activating, defaulting and deleting an organization's tax
 * rates, plus seeding the country's standard VAT rate when an organization signs up.
 * TaxRate is organization-scoped by the tenantScopePlugin; organizationId is still passed
 * explicitly, as in every other service.
 */

import mongoose from "mongoose";
import { TaxRate } from "../models/taxRate.model";
import { ApiError } from "../utils/ApiError";
import { logger } from "../config/logger.config";
import { getCountryForCurrency } from "../config/currencies.config";
import type { CreateTaxRateInput, UpdateTaxRateInput } from "../validators/taxRate.validator";

export interface ListTaxRatesInput {
  isActive?: boolean;
}

function nameTaken(name: string): ApiError {
  return ApiError.coded(409, "TAX_RATE_NAME_TAKEN", `A tax rate named '${name}' already exists.`, [
    { field: "name", code: "TAX_RATE_NAME_TAKEN" },
  ]);
}

function isDuplicateKey(error: unknown, field: string): boolean {
  const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
  return dup.code === 11000 && Boolean(dup.keyPattern?.[field]);
}

async function findTaxRateOrThrow(organizationId: string, taxRateId: string) {
  const taxRate = await TaxRate.findOne({ _id: taxRateId, organizationId });
  if (!taxRate) {
    throw ApiError.coded(404, "TAX_RATE_NOT_FOUND", "Tax rate not found.");
  }
  return taxRate;
}

/** Clears the current default (if any) and makes `taxRateId` the default, atomically. */
async function makeDefault(
  organizationId: string,
  taxRateId: mongoose.Types.ObjectId,
  session: mongoose.ClientSession
) {
  await TaxRate.updateMany(
    { organizationId, isDefault: true, _id: { $ne: taxRateId } },
    { $set: { isDefault: false } },
    { session }
  );
  await TaxRate.updateOne({ _id: taxRateId, organizationId }, { $set: { isDefault: true } }, { session });
}

/**
 * Seeds the standard VAT rate of the organization's country as its default rate. Countries
 * without VAT (Kuwait, Qatar) get nothing. Idempotent: skipped when the org already has rates.
 */
export async function seedDefaultTaxRates(
  organizationId: mongoose.Types.ObjectId,
  currency: string,
  options?: { session?: mongoose.ClientSession }
) {
  const standard = getCountryForCurrency(currency)?.standardTaxRate;
  if (!standard) {
    return [];
  }

  const existing = await TaxRate.exists({ organizationId }).session(options?.session ?? null);
  if (existing) {
    return [];
  }

  return TaxRate.create(
    [
      {
        organizationId,
        name: `${standard.name} ${standard.rate}%`,
        components: [{ name: standard.name, rate: standard.rate }],
        isDefault: true,
      },
    ],
    { session: options?.session }
  );
}

/** Lists every rate in the organization (there are only ever a handful), default first. */
export async function listTaxRates(organizationId: string, input: ListTaxRatesInput) {
  const filter: Record<string, unknown> = { organizationId };
  if (input.isActive !== undefined) {
    filter.isActive = input.isActive;
  }
  const taxRates = await TaxRate.find(filter).sort({ isDefault: -1, rate: 1, name: 1 });
  return { taxRates };
}

export async function getTaxRate(organizationId: string, taxRateId: string) {
  return findTaxRateOrThrow(organizationId, taxRateId);
}

export async function createTaxRate(
  organizationId: string,
  input: CreateTaxRateInput,
  actorUserId: string
) {
  const nameKey = input.name.trim().toLowerCase();
  if (await TaxRate.exists({ organizationId, nameKey })) {
    throw nameTaken(input.name);
  }

  const session = await mongoose.startSession();
  try {
    let taxRateId!: mongoose.Types.ObjectId;
    await session.withTransaction(async () => {
      const [taxRate] = await TaxRate.create(
        [
          {
            organizationId: new mongoose.Types.ObjectId(organizationId),
            name: input.name,
            components: input.components,
          },
        ],
        { session }
      );
      taxRateId = taxRate._id;
      if (input.isDefault) {
        await makeDefault(organizationId, taxRate._id, session);
      }
    });

    logger.info(`Tax rate created: ${taxRateId} org=${organizationId} by user=${actorUserId}`);
    return findTaxRateOrThrow(organizationId, taxRateId.toString());
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) {
      throw nameTaken(input.name);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

/**
 * Renames a rate and/or replaces its components. Documents already issued keep the rate they
 * copied at the time, so changing a rate only affects documents created afterwards.
 */
export async function updateTaxRate(
  organizationId: string,
  taxRateId: string,
  input: UpdateTaxRateInput,
  actorUserId: string
) {
  const taxRate = await findTaxRateOrThrow(organizationId, taxRateId);

  if (input.name !== undefined) {
    const nameKey = input.name.trim().toLowerCase();
    if (nameKey !== taxRate.nameKey && (await TaxRate.exists({ organizationId, nameKey }))) {
      throw nameTaken(input.name);
    }
    taxRate.name = input.name;
  }
  if (input.components !== undefined) {
    taxRate.components = input.components;
  }

  try {
    // save() (not findOneAndUpdate) so the pre-validate hook re-derives nameKey and rate.
    await taxRate.save();
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) {
      throw nameTaken(input.name ?? taxRate.name);
    }
    throw error;
  }

  logger.info(`Tax rate updated: ${taxRateId} org=${organizationId} by user=${actorUserId}`);
  return taxRate;
}

/** Makes an active rate the organization's default. Idempotent. */
export async function setDefaultTaxRate(
  organizationId: string,
  taxRateId: string,
  actorUserId: string
) {
  const taxRate = await findTaxRateOrThrow(organizationId, taxRateId);
  if (!taxRate.isActive) {
    throw ApiError.coded(409, "TAX_RATE_INACTIVE", "An inactive tax rate cannot be the default. Activate it first.");
  }

  if (!taxRate.isDefault) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => makeDefault(organizationId, taxRate._id, session));
    } finally {
      await session.endSession();
    }
    logger.info(`Tax rate set as default: ${taxRateId} org=${organizationId} by user=${actorUserId}`);
  }

  return findTaxRateOrThrow(organizationId, taxRateId);
}

/**
 * Activates or deactivates a rate. An inactive rate stays on the products and documents that
 * already use it but cannot be picked for new ones. The default rate cannot be deactivated.
 */
export async function setTaxRateActive(
  organizationId: string,
  taxRateId: string,
  isActive: boolean,
  actorUserId: string
) {
  const taxRate = await findTaxRateOrThrow(organizationId, taxRateId);
  if (!isActive && taxRate.isDefault) {
    throw ApiError.coded(
      409,
      "TAX_RATE_IS_DEFAULT",
      "The default tax rate cannot be deactivated. Make another rate the default first."
    );
  }

  taxRate.isActive = isActive;
  await taxRate.save();

  logger.info(
    `Tax rate ${isActive ? "activated" : "deactivated"}: ${taxRateId} org=${organizationId} by user=${actorUserId}`
  );
  return taxRate;
}

/**
 * Soft-deletes a rate. The default rate cannot be deleted.
 * NOTE: once products reference tax rates (Phase 1), deleting a rate in use must be refused;
 * deactivate it instead.
 */
export async function deleteTaxRate(organizationId: string, taxRateId: string, actorUserId: string) {
  const taxRate = await findTaxRateOrThrow(organizationId, taxRateId);
  if (taxRate.isDefault) {
    throw ApiError.coded(
      409,
      "TAX_RATE_IS_DEFAULT",
      "The default tax rate cannot be deleted. Make another rate the default first."
    );
  }

  taxRate.isDelete = true;
  await taxRate.save();

  logger.info(`Tax rate deleted: ${taxRateId} org=${organizationId} by user=${actorUserId}`);
}
