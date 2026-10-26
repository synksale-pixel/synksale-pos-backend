/**
 * Purpose: CLI Migration Script for products' free-text preferred vendor names (Phase 3a).
 *
 * Copies each product's old `purchase.preferredVendorName` into its purchase description and
 * removes the field. Part of `npm run migrate`; safe to run repeatedly.
 *
 * Usage:
 *   npm run migrate:vendor-names
 */

import { connectDB, disconnectDB } from "../src/config/db.config";
import { migratePreferredVendorNames } from "../src/services/preferredVendorNameMigration.service";

async function run() {
  console.log("🚀 Moving products' free-text preferred vendor names into their purchase description...");

  await connectDB();

  try {
    const { migrated, cleared } = await migratePreferredVendorNames();
    if (migrated === 0 && cleared === 0) {
      console.log("✅ No product has an old preferred vendor name. Nothing changed.");
      return;
    }
    console.log(`✅ Moved ${migrated} name(s) into purchase descriptions; removed ${cleared} empty field(s).`);
  } finally {
    await disconnectDB();
  }
}

run().catch((error) => {
  console.error("❌ Preferred vendor name migration failed:", error);
  process.exitCode = 1;
});
