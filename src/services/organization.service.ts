/**
 * Purpose: Organization Service (tenant side).
 * Reading the caller's organization profile and updating its tax identity and settings.
 * Platform-side approval lives in platformOrganization.service.ts.
 *
 * Organization is not tenant-scoped by the plugin (it IS the tenant), so every query here
 * looks the organization up by the caller's own ID.
 */

import { Organization, OrganizationDocument } from "../models/organization.model";
import { Store } from "../models/store.model";
import { ApiError } from "../utils/ApiError";
import { logger } from "../config/logger.config";
import { COUNTRIES, getCountryForCurrency, getCurrency } from "../config/currencies.config";
import type { UpdateOrganizationInput } from "../validators/organization.validator";

async function findOrganizationOrThrow(organizationId: string): Promise<OrganizationDocument> {
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    throw ApiError.coded(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
  }
  return organization as OrganizationDocument;
}

/** The response shape: the profile plus the currency details clients need to format money. */
function toProfile(organization: OrganizationDocument) {
  const currency = getCurrency(organization.settings.currency);
  const country = getCountryForCurrency(currency.code);
  return {
    id: organization._id.toString(),
    name: organization.name,
    slug: organization.slug,
    legalName: organization.legalName ?? null,
    taxRegistrationNumber: organization.taxRegistrationNumber ?? null,
    contactEmail: organization.contactEmail,
    contactPhone: organization.contactPhone,
    settings: {
      currency: organization.settings.currency,
      timezone: organization.settings.timezone,
      inventory: {
        allowNegativeStock: organization.settings.inventory?.allowNegativeStock ?? false,
      },
    },
    currency,
    country: country ? { code: country.code, name: country.name } : null,
  };
}

export async function getOrganizationProfile(organizationId: string) {
  return toProfile(await findOrganizationOrThrow(organizationId));
}

/** Returns the organization's currency code. */
export async function getOrganizationCurrency(organizationId: string): Promise<string> {
  return (await findOrganizationOrThrow(organizationId)).settings.currency;
}

/**
 * Rejects a store country whose currency differs from the organization's: an organization
 * trades in a single currency, so a store elsewhere would need currency conversion.
 */
export async function assertCountryMatchesCurrency(organizationId: string, countryCode: string) {
  const currency = await getOrganizationCurrency(organizationId);
  const country = COUNTRIES[countryCode];
  if (!country || country.currency !== currency) {
    throw ApiError.coded(
      400,
      "STORE_COUNTRY_CURRENCY_MISMATCH",
      `Stores of this organization must be in a country that uses ${currency}.`,
      [
        {
          field: "countryCode",
          code: "STORE_COUNTRY_CURRENCY_MISMATCH",
          meta: { countryCode, organizationCurrency: currency },
        },
      ]
    );
  }
}

/**
 * Updates legal name, TRN and settings. Changing the currency is refused while any store sits
 * in a country that uses a different one.
 *
 * NOTE: once priced documents exist (products in Phase 1 onwards), changing the currency would
 * reinterpret every stored amount, so it must also be refused then.
 */
export async function updateOrganization(
  organizationId: string,
  input: UpdateOrganizationInput,
  actorUserId: string
) {
  const organization = await findOrganizationOrThrow(organizationId);

  const $set: Record<string, unknown> = {};
  if (input.legalName !== undefined) $set.legalName = input.legalName;
  if (input.taxRegistrationNumber !== undefined) {
    $set.taxRegistrationNumber = input.taxRegistrationNumber;
  }

  const settings = input.settings;
  if (settings?.timezone !== undefined) $set["settings.timezone"] = settings.timezone;
  if (settings?.inventory?.allowNegativeStock !== undefined) {
    $set["settings.inventory.allowNegativeStock"] = settings.inventory.allowNegativeStock;
  }
  if (settings?.currency !== undefined && settings.currency !== organization.settings.currency) {
    const allowedCountries = Object.values(COUNTRIES)
      .filter((country) => country.currency === settings.currency)
      .map((country) => country.code);
    const mismatched = await Store.find({
      organizationId,
      countryCode: { $exists: true, $nin: allowedCountries },
    }).select("code countryCode");
    if (mismatched.length > 0) {
      throw ApiError.coded(
        409,
        "CURRENCY_STORE_MISMATCH",
        `The currency cannot be changed to ${settings.currency}: some stores are in a country that uses another currency.`,
        mismatched.map((store) => ({
          field: "settings.currency",
          code: "CURRENCY_STORE_MISMATCH",
          meta: { storeId: store._id.toString(), storeCode: store.code, countryCode: store.countryCode },
        }))
      );
    }
    $set["settings.currency"] = settings.currency;
  }

  const updated = await Organization.findByIdAndUpdate(
    organizationId,
    { $set },
    { new: true, runValidators: true }
  );
  if (!updated) {
    throw ApiError.coded(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
  }

  logger.info(`Organization updated: ${organizationId} by user=${actorUserId}`);
  return toProfile(updated as OrganizationDocument);
}
