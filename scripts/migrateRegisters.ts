/**
 * Purpose: CLI Migration Script: gives every existing store its "Register 1" (Phase 4a-2).
 * See src/services/registerMigration.service.ts. Part of `npm run migrate`; safe to run repeatedly.
 *
 * Usage:
 *   npm run migrate:registers
 */

import { connectDB, disconnectDB } from "../src/config/db.config";
import { backfillDefaultRegisters } from "../src/services/registerMigration.service";

async function run() {
  console.log("🚀 Giving every store without a register its 'Register 1'...");

  await connectDB();

  try {
    const { created } = await backfillDefaultRegisters();
    console.log(created === 0 ? "✅ Every store already has a register." : `✅ Created ${created} register(s).`);
  } finally {
    await disconnectDB();
  }
}

run().catch((error) => {
  console.error("❌ Register backfill failed:", error);
  process.exitCode = 1;
});
