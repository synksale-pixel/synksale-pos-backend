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
import { Product } from "../models/product.model";
import { ApiError } from "../utils/ApiError";
import { logger } from "../config/logger.config";
import Decimal from "decimal.js";
import {
  COUNTRIES,
  SALE_PAYMENT_METHODS,
  SalePaymentMethod,
  countrySalesDefaults,
  getCountryForCurrency,
  getCurrency,
} from "../config/currencies.config";
import type { UpdateOrganizationInput } from "../validators/organization.validator";
import { taxIdProblem } from "../utils/taxId";
import { hasSaleNumbers } from "./documentNumber.service";

async function findOrganizationOrThrow(organizationId: string): Promise<OrganizationDocument> {
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    throw ApiError.coded(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
  }
  return organization as OrganizationDocument;
}

/**
 * The organization's sales settings with the country defaults filled in for organizations created
 * before Phase 4a-1 stored them. Every reader (profile, till, numbering) goes through this.
 */
export function salesSettings(organization: Pick<OrganizationDocument, "settings">) {
  const defaults = countrySalesDefaults(organization.settings.currency);
  const sales = organization.settings.sales;
  return {
    fiscalYearStartMonth: organization.settings.fiscalYearStartMonth ?? defaults.fiscalYearStartMonth,
    pricesIncludeTax: sales?.pricesIncludeTax ?? true,
    paymentMethods: sales?.paymentMethods?.length ? [...sales.paymentMethods] : defaults.paymentMethods,
    cashRounding: sales?.cashRounding ?? null,
    maxDiscountPercent: sales?.maxDiscountPercent ?? null,
  };
}

/** The response shape: the profile plus the currency details clients need to format money. */
function toProfile(organization: OrganizationDocument) {
  const currency = getCurrency(organization.settings.currency);
  const country = getCountryForCurrency(currency.code);
  const sales = salesSettings(organization);
  return {
    id: organization._id.toString(),
    name: organization.name,
    slug: organization.slug,
    legalName: organization.legalName ?? null,
    legalNameAr: organization.legalNameAr ?? null,
    taxRegistrationNumber: organization.taxRegistrationNumber ?? null,
    contactEmail: organization.contactEmail,
    contactPhone: organization.contactPhone,
    settings: {
      currency: organization.settings.currency,
      timezone: organization.settings.timezone,
      fiscalYearStartMonth: sales.fiscalYearStartMonth,
      inventory: {
        allowNegativeStock: organization.settings.inventory?.allowNegativeStock ?? false,
      },
      sales: {
        pricesIncludeTax: sales.pricesIncludeTax,
        paymentMethods: sales.paymentMethods,
        cashRounding: sales.cashRounding,
        maxDiscountPercent: sales.maxDiscountPercent,
      },
    },
    cashRoundingSteps: [...currency.cashRoundingSteps],
    currency: { code: currency.code, name: currency.name, decimals: currency.decimals },
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

/** The step from the currency's allow-list equal to `value` ("0.5" matches "0.50"), or null. */
function matchCashRoundingStep(currencyCode: string, value: string): string | null {
  return getCurrency(currencyCode).cashRoundingSteps.find((step) => new Decimal(step).equals(value)) ?? null;
}

/**
 * Indian stores that would print `gstin` while sitting in another state: they use the
 * organization's GSTIN (no own one) and their stateCode differs from its first two digits.
 */
async function storesOutsideGstinState(organizationId: string, gstin: string) {
  return Store.find({
    organizationId,
    countryCode: "IN",
    taxRegistrationNumber: null,
    "address.stateCode": { $nin: [null, gstin.slice(0, 2)] },
  }).select("code address.stateCode");
}

/**
 * Updates legal names, TRN and settings. Changing the currency is refused while any store sits
 * in a country that uses a different one, and once any product exists: prices are stored in the
 * currency's minor units, so a change would reinterpret every stored amount.
 */
export async function updateOrganization(
  organizationId: string,
  input: UpdateOrganizationInput,
  actorUserId: string
) {
  const organization = await findOrganizationOrThrow(organizationId);
  const settings = input.settings;
  const currencyCode = settings?.currency ?? organization.settings.currency;
  const currencyChanges = currencyCode !== organization.settings.currency;
  const country = getCountryForCurrency(currencyCode);

  // Checked first: a locked currency wins over every other problem in the request.
  if (currencyChanges) {
    if (await Product.exists({ organizationId })) {
      throw ApiError.coded(
        409,
        "CURRENCY_LOCKED",
        "The currency cannot be changed once products exist: their prices are recorded in the current currency.",
        [{ field: "settings.currency", code: "CURRENCY_LOCKED" }]
      );
    }
    const allowedCountries = Object.values(COUNTRIES)
      .filter((candidate) => candidate.currency === currencyCode)
      .map((candidate) => candidate.code);
    const mismatched = await Store.find({
      organizationId,
      countryCode: { $exists: true, $nin: allowedCountries },
    }).select("code countryCode");
    if (mismatched.length > 0) {
      throw ApiError.coded(
        409,
        "CURRENCY_STORE_MISMATCH",
        `The currency cannot be changed to ${currencyCode}: some stores are in a country that uses another currency.`,
        mismatched.map((store) => ({
          field: "settings.currency",
          code: "CURRENCY_STORE_MISMATCH",
          meta: { storeId: store._id.toString(), storeCode: store.code, countryCode: store.countryCode },
        }))
      );
    }
  }

  const $set: Record<string, unknown> = {};
  if (currencyChanges) $set["settings.currency"] = currencyCode;
  if (input.legalName !== undefined) $set.legalName = input.legalName;
  if (input.legalNameAr !== undefined) $set.legalNameAr = input.legalNameAr;

  // ---- Tax registration number: checked against the currency's country ----
  const trn = input.taxRegistrationNumber !== undefined ? input.taxRegistrationNumber : organization.taxRegistrationNumber;
  if (input.taxRegistrationNumber !== undefined) $set.taxRegistrationNumber = input.taxRegistrationNumber;
  if (trn && (input.taxRegistrationNumber !== undefined || currencyChanges)) {
    const problem = taxIdProblem(country?.code, trn);
    if (problem) {
      const hint = input.taxRegistrationNumber === undefined ? ` The stored number does not fit ${country?.name}: send a new one or null.` : "";
      throw ApiError.invalidField("taxRegistrationNumber", problem + hint);
    }
    if (country?.code === "IN") {
      const elsewhere = await storesOutsideGstinState(organizationId, trn);
      if (elsewhere.length > 0) {
        throw ApiError.invalidField(
          "taxRegistrationNumber",
          `This GSTIN is for state ${trn.slice(0, 2)}, but stores ${elsewhere.map((s) => `${s.code} (${s.address.stateCode})`).join(", ")} are in another state and have no GSTIN of their own. A GSTIN is per state: give those stores their own first.`
        );
      }
    }
  }

  // ---- Settings ----
  if (settings?.timezone !== undefined) $set["settings.timezone"] = settings.timezone;
  if (settings?.inventory?.allowNegativeStock !== undefined) {
    $set["settings.inventory.allowNegativeStock"] = settings.inventory.allowNegativeStock;
  }
  if (settings?.sales?.pricesIncludeTax !== undefined) {
    $set["settings.sales.pricesIncludeTax"] = settings.sales.pricesIncludeTax;
  }

  const current = salesSettings(organization);
  if (settings?.fiscalYearStartMonth !== undefined && settings.fiscalYearStartMonth !== current.fiscalYearStartMonth) {
    if (await hasSaleNumbers(organizationId)) {
      throw ApiError.coded(
        409,
        "FISCAL_YEAR_LOCKED",
        "The fiscal year start cannot change once a store has made a sale: invoice numbers restart on it.",
        [{ field: "settings.fiscalYearStartMonth", code: "FISCAL_YEAR_LOCKED" }]
      );
    }
    $set["settings.fiscalYearStartMonth"] = settings.fiscalYearStartMonth;
  } else if (currencyChanges && settings?.fiscalYearStartMonth === undefined) {
    // A new country brings its own fiscal year (no sales can exist: products lock the currency).
    $set["settings.fiscalYearStartMonth"] = country?.fiscalYearStartMonth ?? 1;
  }

  if (settings?.sales?.paymentMethods !== undefined) {
    const chosen = new Set<SalePaymentMethod>(settings.sales.paymentMethods);
    $set["settings.sales.paymentMethods"] = SALE_PAYMENT_METHODS.filter((method) => chosen.has(method));
  }
  if (settings?.sales?.cashRounding !== undefined) {
    if (settings.sales.cashRounding === null) {
      $set["settings.sales.cashRounding"] = null;
    } else {
      const step = matchCashRoundingStep(currencyCode, settings.sales.cashRounding);
      if (!step) {
        throw ApiError.invalidField(
          "settings.sales.cashRounding",
          `${currencyCode} cash can be rounded to: ${getCurrency(currencyCode).cashRoundingSteps.join(", ")}.`
        );
      }
      $set["settings.sales.cashRounding"] = step;
    }
  } else if (currencyChanges && current.cashRounding && !matchCashRoundingStep(currencyCode, current.cashRounding)) {
    $set["settings.sales.cashRounding"] = null;
  }
  if (settings?.sales?.maxDiscountPercent !== undefined) {
    $set["settings.sales.maxDiscountPercent"] = settings.sales.maxDiscountPercent;
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
