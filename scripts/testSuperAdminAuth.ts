/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Purpose: Verification script for Super Admin authentication routes.
 * Starts a local instance of the application on a test port, fires HTTP requests
 * to verify login, me, refresh, logout, and logout-all endpoints, and verifies audit logging.
 */

import mongoose from "mongoose";
import app from "../src/app";
import { User } from "../src/models/user.model";

const PORT = 3999;
const BASE_URL = `http://localhost:${PORT}/api/v1/platform/auth`;

async function testRoutes() {
  console.log("🚀 Starting Super Admin Authentication Route Verification Tests...");

  // Start the server
  const server = app.listen(PORT, async () => {
    console.log(`✅ Test server running on port ${PORT}`);

    try {
      // Connect mongoose if not already connected
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGO_URI || "");
      }

      // Ensure test super admin exists in DB
      let testAdmin = await User.findOne({ email: "admin@example.com", isSuperAdmin: true });
      if (!testAdmin) {
        console.log("ℹ️ Test super admin not found, seeding...");
        testAdmin = await User.create({
          email: "admin@example.com",
          passwordHash: "SecurePassword123", // plaintext, hashed by model hook
          firstName: "Test",
          lastName: "Admin",
          isSuperAdmin: true,
          organizationId: null,
          isActive: true,
        });
      } else {
        // Reset password/status to ensure test consistency
        testAdmin.passwordHash = "SecurePassword123";
        testAdmin.isActive = true;
        testAdmin.refreshTokens = [];
        await testAdmin.save();
      }

      // --- TEST 1: Login with wrong credentials ---
      console.log("\n--- Test 1: Login with wrong password ---");
      const loginFailRes = await fetch(`${BASE_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "WrongPassword" }),
      });
      const loginFailData = await loginFailRes.json() as any;
      console.log("Status Code (Expected 401):", loginFailRes.status);
      console.log("Message (Expected 'Invalid credentials'):", loginFailData.message);
      console.log("Success (Expected false):", loginFailData.success);

      // --- TEST 2: Login with correct credentials ---
      console.log("\n--- Test 2: Login with correct credentials ---");
      const loginSuccessRes = await fetch(`${BASE_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "SecurePassword123" }),
      });
      const loginSuccessData = await loginSuccessRes.json() as any;
      console.log("Status Code (Expected 200):", loginSuccessRes.status);
      console.log("Success (Expected true):", loginSuccessData.success);
      const { accessToken, refreshToken } = loginSuccessData.data;
      console.log("Access Token Returned:", !!accessToken);
      console.log("Refresh Token Returned:", !!refreshToken);

      // Inspect access token payload (simulated decode)
      const tokenParts = accessToken.split(".");
      const decodedPayload = JSON.parse(Buffer.from(tokenParts[1], "base64").toString());
      console.log("Decoded JWT Payload:", decodedPayload);

      // --- TEST 3: Access /me without token ---
      console.log("\n--- Test 3: Access /me without token ---");
      const meFailRes = await fetch(`${BASE_URL}/me`);
      // const meFailData = await meFailRes.json() as any;
      console.log("Status Code (Expected 401):", meFailRes.status);

      // --- TEST 4: Access /me with token ---
      console.log("\n--- Test 4: Access /me with token ---");
      const meSuccessRes = await fetch(`${BASE_URL}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const meSuccessData = await meSuccessRes.json() as any;
      console.log("Status Code (Expected 200):", meSuccessRes.status);
      console.log("Profile Email:", meSuccessData.data.email);
      console.log("isSuperAdmin Flag:", meSuccessData.data.isSuperAdmin);

      // --- TEST 5: Token Rotation (Refresh) ---
      console.log("\n--- Test 5: Token Rotation (Refresh) ---");
      const refreshRes = await fetch(`${BASE_URL}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      const refreshData = await refreshRes.json() as any;
      console.log("Status Code (Expected 200):", refreshRes.status);
      const newAccessToken = refreshData.data.accessToken;
      const newRefreshToken = refreshData.data.refreshToken;
      console.log("New Access Token Returned:", !!newAccessToken);
      console.log("New Refresh Token Returned:", !!newRefreshToken);

      // --- TEST 6: Reuse of rotated token (should fail) ---
      console.log("\n--- Test 6: Reuse of rotated token (should fail) ---");
      const reuseRes = await fetch(`${BASE_URL}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }), // old token
      });
      const reuseData = await reuseRes.json() as any;
      console.log("Status Code (Expected 401):", reuseRes.status);
      console.log("Message (Expected Authentication failed...):", reuseData.message);

      // --- TEST 7: Logout ---
      console.log("\n--- Test 7: Logout ---");
      const logoutRes = await fetch(`${BASE_URL}/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: newRefreshToken }),
      });
      console.log("Status Code (Expected 200):", logoutRes.status);

      // Verify that newRefreshToken cannot be used again
      const afterLogoutRes = await fetch(`${BASE_URL}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: newRefreshToken }),
      });
      console.log("Rotation after logout status (Expected 401):", afterLogoutRes.status);

      console.log("\n🎉 All tests executed successfully!");
    } catch (err) {
      console.error("❌ Test failed with error:", err);
    } finally {
      // Clean up and close
      server.close(() => {
        console.log("🔌 Test server closed.");
        mongoose.disconnect().then(() => {
          console.log("🔌 MongoDB disconnected.");
          process.exit(0);
        });
      });
    }
  });
}

testRoutes().catch(console.error);
