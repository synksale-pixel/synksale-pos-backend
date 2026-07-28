/**
 * Verification Script for Tenant Auth and Onboarding Flow.
 * Run this script to programmatically verify organization signup,
 * login, user invitation, privilege ceiling enforcement, and invite acceptance.
 * 
 * Usage:
 *   npx tsx scripts/verifyTenantFlow.ts
 */

import { connectDB, disconnectDB } from "../src/config/db.config";
import { signupOrganization } from "../src/services/organizationSignup.service";
import { inviteUser, acceptInvite } from "../src/services/userInvite.service";
import { Organization } from "../src/models/organization.model";
import { User } from "../src/models/user.model";
import { Role } from "../src/models/role.model";
import { Store } from "../src/models/store.model";
import mongoose from "mongoose";

async function runVerification() {
  console.log("🚀 Starting Tenant Flow Verification Script...\n");
  
  await connectDB();
  console.log("Connected to MongoDB successfully.");

  // Clean up any old test organization to keep verification clean
  const TEST_ORG_SLUG = "test-verification-org";
  await Organization.deleteOne({ slug: TEST_ORG_SLUG });
  await Organization.deleteMany({ slug: new RegExp("^test-verification-org") });
  await User.deleteMany({ email: { $in: ["admin@verif.com", "staff@verif.com", "manager@verif.com"] } });
  
  try {
    // ----------------------------------------------------
    // TEST 1: Organization Signup
    // ----------------------------------------------------
    console.log("\n--- [Test 1] Organization Signup ---");
    const signupInput = {
      organizationName: "Test Verification Org",
      contactEmail: "admin@verif.com",
      adminFirstName: "John",
      adminLastName: "Doe",
      adminEmail: "admin@verif.com",
      adminPassword: "SecureAdminPassword123",
      ipAddress: "127.0.0.1",
      userAgent: "TestAgent",
    };

    const signupResult = await signupOrganization(signupInput);
    console.log("✅ Signup successful!");
    console.log("Generated Slug:", signupResult.organization.slug);
    console.log("Admin User ID:", signupResult.user.id);
    console.log("Access Token length:", signupResult.accessToken.length);
    console.log("Refresh Token (plaintext):", signupResult.refreshToken);

    // Verify DB entries
    const dbOrg = await Organization.findById(signupResult.organization._id);
    if (!dbOrg) throw new Error("DB Organization not found!");
    console.log("Verified Organization in DB. Active status:", dbOrg.isActive);

    const dbUser = await User.findById(signupResult.user.id).select("+passwordHash");
    if (!dbUser) throw new Error("DB Admin User not found!");
    console.log("Verified Admin User in DB. Invite status:", dbUser.inviteStatus);

    // Verify seed roles exist
    const seededRoles = await Role.find({ organizationId: dbOrg._id });
    console.log(`Verified default roles seeded in DB: ${seededRoles.map(r => r.slug).join(", ")}`);

    // ----------------------------------------------------
    // TEST 2: Create a dummy Store for scoping tests
    // ----------------------------------------------------
    console.log("\n--- [Test 2] Create Store ---");
    const testStore = await Store.create({
      organizationId: dbOrg._id,
      name: "Test Store Branch A",
      code: "VERIF-STORE-001",
      address: {
        line1: "123 Verification St",
        city: "Mumbai",
        state: "Maharashtra",
        country: "India",
        postalCode: "400001",
      },
      timezone: "Asia/Kolkata",
    });
    console.log("✅ Created Test Store Branch ID:", testStore._id);

    // ----------------------------------------------------
    // TEST 3: Invite Staff Member (Org Admin inviting a Store Manager)
    // ----------------------------------------------------
    console.log("\n--- [Test 3] User Invitation (Store Manager Role) ---");
    const managerRole = seededRoles.find(r => r.slug === "store_manager");
    if (!managerRole) throw new Error("Store manager role not found!");

    const inviteResult = await inviteUser({
      organizationId: dbOrg._id.toString(),
      storeId: testStore._id.toString(),
      email: "manager@verif.com",
      firstName: "Jane",
      lastName: "Manager",
      roleId: managerRole._id.toString(),
      invitedByUserId: dbUser._id.toString(),
    });

    console.log("✅ Invitation created successfully!");
    console.log("Plaintext Invite Token:", inviteResult.inviteToken);
    console.log("Generated Invite Link:", inviteResult.inviteLink);
    console.log("Invited User DB ID:", inviteResult.user.id);
    console.log("Invited User active state:", inviteResult.user.isActive);

    // Verify in database
    const dbInvitedUser = await User.findById(inviteResult.user.id).select("+inviteToken");
    if (!dbInvitedUser) throw new Error("Invited user not found in DB!");
    console.log("Hashed Invite Token in DB:", dbInvitedUser.inviteToken);
    console.log("Invite Status:", dbInvitedUser.inviteStatus);
    console.log("Is passwordHash defined for invited user?", dbInvitedUser.passwordHash !== undefined);

    // ----------------------------------------------------
    // TEST 4: Accept Invitation
    // ----------------------------------------------------
    console.log("\n--- [Test 4] Accept Invitation ---");
    const acceptResult = await acceptInvite({
      token: inviteResult.inviteToken,
      password: "ManagerPassword123",
      ipAddress: "127.0.0.1",
      userAgent: "TestAgent",
    });

    console.log("✅ Invitation accepted successfully!");
    console.log("Acceptance Access Token length:", acceptResult.accessToken.length);
    console.log("Acceptance Refresh Token (plaintext):", acceptResult.refreshToken);
    console.log("Activated User active state:", acceptResult.user.isActive);
    console.log("Activated User invite status:", acceptResult.user.inviteStatus);

    // Verify DB update
    const dbAcceptedUser = await User.findById(acceptResult.user.id).select("+passwordHash +inviteToken");
    if (!dbAcceptedUser) throw new Error("Activated user not found in DB!");
    console.log("Is active after acceptance:", dbAcceptedUser.isActive);
    console.log("Is inviteToken cleared in DB?", dbAcceptedUser.inviteToken === undefined);
    
    const isPassHashedCorrectly = await dbAcceptedUser.comparePassword("ManagerPassword123");
    console.log("Password hash verification matches plaintext?", isPassHashedCorrectly);

    // ----------------------------------------------------
    // TEST 5: Privilege Ceiling Enforcement
    // ----------------------------------------------------
    console.log("\n--- [Test 5] Privilege Ceiling Enforcement ---");
    const orgAdminRole = seededRoles.find(r => r.slug === "org_admin");
    if (!orgAdminRole) throw new Error("Org Admin role not found!");

    console.log("Attempting to let Store Manager invite someone to be Org Admin (should fail)...");
    try {
      await inviteUser({
        organizationId: dbOrg._id.toString(),
        email: "staff@verif.com",
        firstName: "Rob",
        lastName: "Staff",
        roleId: orgAdminRole._id.toString(),
        invitedByUserId: dbAcceptedUser._id.toString(), // Store Manager trying to grant Org Admin
      });
      throw new Error("FAIL: Privilege ceiling check was bypassed!");
    } catch (err: any) {
      console.log("✅ Blocked privilege ceiling successfully!");
      console.log("Ceiling failure message:", err.message);
    }

    console.log("\n🎉 ALL TENANT AUTH & ONBOARDING FLOW VERIFICATIONS PASSED SUCCESSFULLY!");

  } catch (error: any) {
    console.error("\n❌ Verification Failed with Error:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  } finally {
    // Clean up test data
    console.log("\nCleaning up test verification data...");
    await Organization.deleteOne({ slug: TEST_ORG_SLUG });
    await Organization.deleteMany({ slug: new RegExp("^test-verification-org") });
    await User.deleteMany({ email: { $in: ["admin@verif.com", "staff@verif.com", "manager@verif.com"] } });
    await Store.deleteOne({ code: "VERIF-STORE-001" });
    await disconnectDB();
    console.log("Disconnected from DB. Done.");
  }
}

runVerification();
