/**
 * Purpose: CLI Migration Script for MongoDB Indexes.
 *
 * Mongoose's autoIndex only ever CREATES indexes, and only outside production (see
 * db.config.ts). It never replaces an index whose options changed: if a schema index gains a
 * partialFilterExpression, MongoDB rejects the new definition because an index with the same
 * name already exists, Mongoose swallows the error, and the stale index stays in force.
 * That is how roles kept a non-partial { organizationId, slug } index, so a soft-deleted
 * role's slug was never released.
 *
 * This script makes each collection's indexes match its schema: indexes that are stale or no
 * longer declared are dropped, and missing ones are created. Documents are never modified.
 *
 * Run it after any change to a schema index, and as part of every production deploy (where
 * autoIndex is off, so nothing else creates indexes).
 *
 * Dry run by default: prints the plan and changes nothing. Pass --apply to execute it.
 *
 * Usage:
 *   npm run sync:indexes
 *   npm run sync:indexes -- --apply
 */

import mongoose from "mongoose";
import { env } from "../src/config/env.config";
import { Organization } from "../src/models/organization.model";
import { User } from "../src/models/user.model";
import { Role } from "../src/models/role.model";
import { Store } from "../src/models/store.model";
import { AuditLog } from "../src/models/auditLog.model";

const MODELS: mongoose.Model<any>[] = [Organization, User, Role, Store, AuditLog]; // eslint-disable-line @typescript-eslint/no-explicit-any

async function run() {
  const apply = process.argv.slice(2).includes("--apply");

  console.log(
    apply
      ? "🚀 Syncing indexes with the schemas..."
      : "🔍 Dry run: showing index changes (pass --apply to execute)..."
  );

  // Connected directly rather than through connectDB(): autoIndex must be off here, or Mongoose
  // would start building indexes on connect and race the sync below.
  await mongoose.connect(env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 5000 });

  try {
    let changes = 0;

    for (const model of MODELS) {
      const { toDrop, toCreate } = await model.diffIndexes();
      if (toDrop.length === 0 && toCreate.length === 0) {
        console.log(`   ✅ ${model.collection.name}: up to date`);
        continue;
      }

      changes += toDrop.length + toCreate.length;
      console.log(`   ⚠️ ${model.collection.name}:`);
      for (const name of toDrop) console.log(`      - drop   ${name}`);
      for (const spec of toCreate) console.log(`      + create ${JSON.stringify(spec)}`);

      if (apply) {
        await model.syncIndexes();
        console.log(`      ✅ synced`);
      }
    }

    if (changes === 0) {
      console.log("✅ All indexes already match the schemas. Nothing to do.");
    } else if (!apply) {
      console.log(`ℹ️ ${changes} change(s) pending. Re-run with --apply to execute them.`);
    } else {
      console.log("✅ Index sync complete.");
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error("❌ Index sync failed:", error);
  process.exitCode = 1;
});
