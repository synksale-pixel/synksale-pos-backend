/**
 * Purpose: CLI Migration Script for System Role Permissions.
 *
 * seedDefaultRolesForOrganization is idempotent *by slug*: if a role with that slug already
 * exists it is skipped entirely, permissions untouched. So adding a key to the permission
 * catalog never reaches organizations that were seeded before the change, and their org_admin
 * silently 403s on any endpoint guarding the new key.
 *
 * Run this after every change to PERMISSION_CATALOG or DEFAULT_ROLE_TEMPLATES.
 * The sync is additive (it never removes a permission) and safe to run repeatedly.
 *
 * Usage:
 *   npm run sync:system-roles
 *   npm run sync:system-roles -- --org=665f1c2e8a4b3c0012ab3300
 */

import { connectDB, disconnectDB } from "../src/config/db.config";
import { syncSystemRolePermissions } from "../src/services/roleSeed.service";

async function run() {
  console.log("🚀 Syncing system role permissions against the catalog...");

  await connectDB();

  try {
    const orgArg = process.argv.slice(2).find((arg) => arg.startsWith("--org="));
    const organizationId = orgArg ? orgArg.split("=")[1] : undefined;

    if (organizationId) {
      console.log(`ℹ️ Restricting sync to organization ${organizationId}.`);
    }

    const results = await syncSystemRolePermissions(organizationId);

    if (results.length === 0) {
      console.log("✅ All system roles are already up to date. Nothing changed.");
      return;
    }

    console.log(`✅ Updated ${results.length} role(s):`);
    for (const result of results) {
      console.log(`   - ${result.slug} (${result.roleId}): +${result.added.join(", ")}`);
    }
  } finally {
    await disconnectDB();
  }
}

run().catch((error) => {
  console.error("❌ System role sync failed:", error);
  process.exitCode = 1;
});
