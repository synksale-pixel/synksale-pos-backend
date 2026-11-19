/**
 * Purpose: CLI Migration Script: backfills goods receipts' billableQuantityMilli, which backs
 * `GET /goods-receipts?billable=true`. See src/services/receiptBillableMigration.service.ts.
 * Part of `npm run migrate`; safe to run repeatedly.
 *
 * Usage:
 *   npm run migrate:receipt-billable
 */

import { connectDB, disconnectDB } from "../src/config/db.config";
import { backfillReceiptBillable } from "../src/services/receiptBillableMigration.service";

async function run() {
  console.log("🚀 Working out what is left to bill on every goods receipt...");

  await connectDB();

  try {
    const { updated } = await backfillReceiptBillable();
    console.log(
      updated === 0
        ? "✅ Every receipt was already up to date."
        : `✅ Updated ${updated} receipt(s).`
    );
  } finally {
    await disconnectDB();
  }
}

run().catch((error) => {
  console.error("❌ Receipt billable backfill failed:", error);
  process.exitCode = 1;
});
