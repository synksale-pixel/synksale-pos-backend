import mongoose from "mongoose";
import { env } from "../src/config/env.config";
import { Organization } from "../src/models/organization.model";
import { Store } from "../src/models/store.model";
import { Role } from "../src/models/role.model";
import { User } from "../src/models/user.model";
import { isValidPermission } from "../src/config/permissions.catalog";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
} from "../src/services/auth.service";
import {
  getEffectivePermissions,
  canGrantRole,
} from "../src/services/permission.service";
import { seedDefaultRolesForOrganization } from "../src/services/roleSeed.service";
import { requestContextStorage } from "../src/utils/requestContext";

async function runTests() {
  console.log("🚀 Starting RBAC and Data Foundation Verification tests...");

  // 1. Connect to DB using the configured MONGO_URI
  await mongoose.connect(env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const TEST_SLUG = `temp-test-org-${Date.now()}`;
  let testOrgId: mongoose.Types.ObjectId | null = null;

  try {
    // 2. Clear pre-existing test data (if any)
    await Organization.deleteMany({ slug: TEST_SLUG });

    // 3. Test Catalog Validation
    console.log("\n=== Test 1: Permission Catalog ===");
    console.log("isValidPermission('sale:create'):", isValidPermission("sale:create")); // should be true
    console.log("isValidPermission('invalid:perm'):", isValidPermission("invalid:perm")); // should be false

    // 4. Test Model Creations
    console.log("\n=== Test 2: Model Creations ===");
    const org = await Organization.create({
      name: "Test Org Entity",
      slug: TEST_SLUG,
      contactEmail: "test@example.com",
      contactPhone: "+919876543210",
      settings: {
        currency: "INR",
        timezone: "Asia/Kolkata",
      },
    });
    testOrgId = org._id as mongoose.Types.ObjectId;
    console.log("✅ Created Organization:", org.name, "ID:", testOrgId);

    const store = await Store.create({
      organizationId: testOrgId,
      name: "Test Store Location",
      code: "TST-001",
      address: {
        line1: "123 Test Lane",
        city: "Mumbai",
        state: "Maharashtra",
        country: "India",
        postalCode: "400001",
      },
      timezone: "Asia/Kolkata",
    });
    const testStoreId = store._id as mongoose.Types.ObjectId;
    console.log("✅ Created Store:", store.name, "ID:", testStoreId);

    // 5. Test Role Seeding
    console.log("\n=== Test 3: Role Seeding ===");
    const seededRoles = await seedDefaultRolesForOrganization(testOrgId);
    console.log("✅ Seeded default roles count:", seededRoles.length);
    seededRoles.forEach((r) => {
      console.log(` - Role: ${r.slug} (scope: ${r.scope}) with ${r.permissions.length} permissions`);
    });

    const orgAdminRole = seededRoles.find((r) => r.slug === "org_admin")!;
    const cashierRole = seededRoles.find((r) => r.slug === "cashier")!;

    // 6. Test User Hashing & Save
    console.log("\n=== Test 4: User creation and Password verification ===");
    const user = await User.create({
      organizationId: testOrgId,
      email: "user@example.com",
      passwordHash: "securePIN123", // plaintext passed in, hashes on save
      firstName: "John",
      lastName: "Doe",
      orgRoleId: orgAdminRole._id as mongoose.Types.ObjectId,
      storeAccess: [
        {
          storeId: testStoreId,
          roleId: cashierRole._id as mongoose.Types.ObjectId,
        },
      ],
    });
    console.log("✅ Created User:", user.email, "ID:", user._id);

    // Verify Password Hash (will be hidden on standard find queries, but select works)
    const userWithPassword = await User.findById(user._id).select("+passwordHash");
    const passMatch = await userWithPassword?.comparePassword("securePIN123");
    console.log("Password matches plaintext PIN:", passMatch);
    const passMatchFail = await userWithPassword?.comparePassword("wrongPIN");
    console.log("Password rejects incorrect PIN:", passMatchFail === false);

    // 7. Test JWT Service
    console.log("\n=== Test 5: JWT Token Operations ===");
    const tokenPayload = {
      userId: user._id.toString(),
      organizationId: testOrgId.toString(),
      isSuperAdmin: user.isSuperAdmin,
    };
    const accessToken = generateAccessToken(tokenPayload);
    console.log("✅ Generated Access Token length:", accessToken.length);

    const verified = verifyAccessToken(accessToken);
    console.log("Verified token payload matches original:", verified.userId === tokenPayload.userId);

    const refreshSession = generateRefreshToken();
    console.log("✅ Generated opaque Refresh Token:", refreshSession.token);
    console.log("Hashed Refresh Token length:", refreshSession.hashedToken.length);

    // 8. Test Tenant Scoping & Soft Delete Plugin
    console.log("\n=== Test 6: Tenant Scoping & Soft Delete Plugin ===");

    // Query Stores within the request context where organizationId is set
    await requestContextStorage.run(
      { requestId: "req-123", organizationId: testOrgId.toString() },
      async () => {
        const stores = await Store.find();
        console.log("Plugin injected organizationId in query! Found stores count:", stores.length);
        console.log("Store matches our org:", stores[0]?.organizationId.toString() === testOrgId?.toString());
      }
    );

    // Soft delete testing
    const storeToSoftDelete = await Store.create({
      organizationId: testOrgId,
      name: "Store to Soft Delete",
      code: "TST-DEL",
      address: {
        line1: "123 Delete Lane",
        city: "Mumbai",
        state: "Maharashtra",
        country: "India",
        postalCode: "400001",
      },
      timezone: "Asia/Kolkata",
    });

    console.log("Created Store for deletion. isDelete default:", storeToSoftDelete.isDelete);

    // Mark as soft deleted
    storeToSoftDelete.isDelete = true;
    await storeToSoftDelete.save();
    console.log("Marked store as isDelete = true");

    // Fetch normally (should not find it)
    const normalFetch = await Store.findOne({ code: "TST-DEL" });
    console.log("Normal query finds soft deleted store:", normalFetch !== null ? "Yes (FAIL)" : "No (PASS)");

    // Fetch with explicit isDelete query (should find it)
    const explicitFetch = await Store.findOne({ code: "TST-DEL", isDelete: true });
    console.log("Explicit query with isDelete: true finds soft deleted store:", explicitFetch !== null ? "Yes (PASS)" : "No (FAIL)");

    // 9. Test Permissions Resolution and Privilege Escalation
    console.log("\n=== Test 7: Permissions Resolution ===");
    const orgPerms = await getEffectivePermissions(user);
    console.log("✅ Resolved organization-wide permissions count:", orgPerms.length);
    console.log("Contains 'sale:refund' (org_admin perm):", orgPerms.includes("sale:refund"));

    const unionPerms = await getEffectivePermissions(user, testStoreId.toString());
    console.log("✅ Resolved union store-wide permissions count:", unionPerms.length);
    console.log("Contains 'sale:create' (cashier perm):", unionPerms.includes("sale:create"));

    const superAdminUser = {
      isSuperAdmin: true,
      orgRoleId: null,
      storeAccess: [],
    } as any;
    const superPerms = await getEffectivePermissions(superAdminUser);
    console.log("Super Admin gets wildcard permission:", superPerms[0] === "*");

    // Privilege escalation check
    console.log("\n=== Test 8: Privilege Escalation Checks ===");
    const targetRoleTemplate = {
      scope: "organization",
      permissions: ["sale:create", "sale:refund"],
    } as any;

    const canGrant = canGrantRole(orgPerms, "organization", targetRoleTemplate);
    console.log("Org admin can grant role with subset permissions:", canGrant); // true

    const targetRoleEscalated = {
      scope: "platform",
      permissions: ["sale:create"],
    } as any;

    const canGrantEscalatedScope = canGrantRole(orgPerms, "organization", targetRoleEscalated);
    console.log("Org admin blocked from granting platform-scoped role:", canGrantEscalatedScope === false); // true

    const cashierPerms = ["sale:create", "product:read"];
    const canCashierGrant = canGrantRole(cashierPerms, "store", orgAdminRole as any);
    console.log("Cashier blocked from granting org admin role:", canCashierGrant === false); // true

  } catch (error) {
    console.error("❌ Test execution failed with error:", error);
  } finally {
    // 10. Cleanup test documents
    console.log("\n=== Cleaning Up Test Documents ===");
    if (testOrgId) {
      const uRes = await User.deleteMany({ organizationId: testOrgId });
      const rRes = await Role.deleteMany({ organizationId: testOrgId });
      const sRes = await Store.deleteMany({ organizationId: testOrgId });
      const oRes = await Organization.deleteMany({ _id: testOrgId });
      console.log(`Deleted: ${uRes.deletedCount} users, ${rRes.deletedCount} roles, ${sRes.deletedCount} stores, ${oRes.deletedCount} organizations.`);
    }

    // 11. Disconnect
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

runTests().catch(console.error);
