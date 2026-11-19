/**
 * Purpose: Phase 4a-1 data migration (run by `npm run migrate`, safe to repeat).
 *
 * - Organizations created before 4a-1 get their country's fiscalYearStartMonth and payment methods
 *   stored (reads already fall back to them; storing them makes the data match what is shown).
 * - Indian stores get address.stateCode: from their own GSTIN, else by matching address.state to a
 *   GST state name (where the store is), else from the organization's GSTIN. Stores it cannot work out are reported;
 *   their next update asks for the code (400 on address.stateCode).
 */

import { Organization } from "../models/organization.model";
import { Store } from "../models/store.model";
import {
  CURRENCY_CODES,
  countrySalesDefaults,
} from "../config/currencies.config";
import { GST_STATES } from "../config/gstStates.config";

const stateByName = new Map(
  Object.entries(GST_STATES).map(([code, name]) => [name.toLowerCase(), code])
);

export interface Phase4a1MigrationResult {
  organizationsUpdated: number;
  storesUpdated: number;
  /** Indian stores still without a stateCode: { organizationId, storeId, code, state }. */
  unresolvedStores: {
    organizationId: string;
    storeId: string;
    code: string;
    state: string;
  }[];
}

export async function migratePhase4a1(): Promise<Phase4a1MigrationResult> {
  let organizationsUpdated = 0;
  for (const currency of CURRENCY_CODES) {
    const defaults = countrySalesDefaults(currency);
    const fiscal = await Organization.updateMany(
      {
        "settings.currency": currency,
        "settings.fiscalYearStartMonth": { $exists: false },
      },
      {
        $set: {
          "settings.fiscalYearStartMonth": defaults.fiscalYearStartMonth,
        },
      }
    );
    const methods = await Organization.updateMany(
      {
        "settings.currency": currency,
        "settings.sales.paymentMethods": { $exists: false },
      },
      { $set: { "settings.sales.paymentMethods": defaults.paymentMethods } }
    );
    organizationsUpdated += fiscal.modifiedCount + methods.modifiedCount;
  }

  const stores = await Store.find({
    countryCode: "IN",
    "address.stateCode": null,
    isDelete: { $in: [true, false] },
  });
  const orgGstins = new Map<string, string | null>();
  let storesUpdated = 0;
  const unresolvedStores: Phase4a1MigrationResult["unresolvedStores"] = [];
  for (const store of stores) {
    const orgId = store.organizationId.toString();
    if (!orgGstins.has(orgId)) {
      const org = await Organization.findById(orgId).select(
        "taxRegistrationNumber"
      );
      orgGstins.set(orgId, org?.taxRegistrationNumber ?? null);
    }
    const fromGstin = (gstin: string | null | undefined) =>
      gstin && GST_STATES[gstin.slice(0, 2)] ? gstin.slice(0, 2) : null;
    const stateCode =
      fromGstin(store.taxRegistrationNumber) ??
      stateByName.get(store.address.state.trim().toLowerCase()) ??
      fromGstin(orgGstins.get(orgId)) ??
      null;
    if (!stateCode) {
      unresolvedStores.push({
        organizationId: orgId,
        storeId: store._id.toString(),
        code: store.code,
        state: store.address.state,
      });
      continue;
    }
    await Store.updateOne(
      { _id: store._id },
      { $set: { "address.stateCode": stateCode } }
    );
    storesUpdated += 1;
  }

  return { organizationsUpdated, storesUpdated, unresolvedStores };
}
