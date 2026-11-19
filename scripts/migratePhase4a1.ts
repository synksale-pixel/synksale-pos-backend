/**
 * Purpose: CLI Migration Script for Phase 4a-1 (sales settings defaults, Indian store state codes).
 * See src/services/phase4a1Migration.service.ts. Part of `npm run migrate`; safe to run repeatedly.
 *
 * Usage:
 *   npm run migrate:phase4a1
 */

import { connectDB, disconnectDB } from "../src/config/db.config";
import { migratePhase4a1 } from "../src/services/phase4a1Migration.service";

async function run() {
  console.log("🚀 Phase 4a-1: storing sales settings defaults and Indian store state codes...");

  await connectDB();

  try {
    const { organizationsUpdated, storesUpdated, unresolvedStores } = await migratePhase4a1();
    console.log(`✅ Organizations updated: ${organizationsUpdated}. Indian stores given a state code: ${storesUpdated}.`);
    if (unresolvedStores.length > 0) {
      console.log("⚠️ These Indian stores need their GST state code set by hand (PATCH /stores/:id with address.stateCode):");
      for (const store of unresolvedStores) {
        console.log(`   - org ${store.organizationId} store ${store.code} (${store.storeId}), state "${store.state}"`);
      }
    }
  } finally {
    await disconnectDB();
  }
}

run().catch((error) => {
  console.error("❌ Phase 4a-1 migration failed:", error);
  process.exitCode = 1;
});
