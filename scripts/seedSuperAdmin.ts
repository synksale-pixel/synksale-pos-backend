/**
 * Purpose: CLI Seed Script for Super Admin.
 * Seeds a Super Admin account directly into the database.
 * Usage:
 *   npm run seed:super-admin
 *   npm run seed:super-admin -- --email=admin@example.com --password=SecurePassword123
 */

import readline from "readline";
import { connectDB, disconnectDB } from "../src/config/db.config";
import { User } from "../src/models/user.model";
import { loginSchema } from "../src/validators/platformAuth.validator";
import { env } from "../src/config/env.config";

// Setup readline interface for interactive input
function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function seed() {
  console.log("🚀 Starting Super Admin Seeding Script...");

  // Connect to the database
  await connectDB();

  try {
    // 1. Parse CLI arguments
    const args = process.argv.slice(2);
    let email = "";
    let password = "";

    for (const arg of args) {
      if (arg.startsWith("--email=")) {
        email = arg.split("=")[1];
      } else if (arg.startsWith("--password=")) {
        password = arg.split("=")[1];
      }
    }

    // 2. Fallback to Env variables
    if (!email && env.SUPER_ADMIN_SEED_EMAIL) {
      console.log("ℹ️ Using SUPER_ADMIN_SEED_EMAIL from environment variables.");
      email = env.SUPER_ADMIN_SEED_EMAIL;
    }
    if (!password && env.SUPER_ADMIN_SEED_PASSWORD) {
      console.log("ℹ️ Using SUPER_ADMIN_SEED_PASSWORD from environment variables.");
      password = env.SUPER_ADMIN_SEED_PASSWORD;
    }

    // 3. Fallback to interactive prompts
    if (!email) {
      email = await askQuestion("Enter Super Admin Email: ");
    }
    if (!password) {
      password = await askQuestion("Enter Super Admin Password: ");
    }

    // 4. Validate credentials format using login Zod schema
    const validationResult = loginSchema.safeParse({ email, password });
    if (!validationResult.success) {
      const errors = validationResult.error.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join(", ");
      throw new Error(`Validation failed: ${errors}`);
    }

    // 5. Check if Super Admin already exists
    const existingSuperAdmin = await User.findOne({
      email: email.toLowerCase(),
      isSuperAdmin: true,
    });

    if (existingSuperAdmin) {
      console.log(`❌ Error: A Super Admin with email ${email} already exists.`);
      process.exitCode = 1;
      return;
    }

    // 6. Create Super Admin Document
    // We pass the plaintext password; the pre-save hook on the User model will hash it automatically.
    const superAdmin = new User({
      email: email.toLowerCase(),
      passwordHash: password,
      firstName: "Platform",
      lastName: "SuperAdmin",
      isSuperAdmin: true,
      organizationId: null,
      isActive: true,
    });

    await superAdmin.save();

    console.log(`\n==========================================`);
    console.log(`✅ Success: Super Admin created successfully!`);
    console.log(`📧 Email: ${superAdmin.email}`);
    console.log(`==========================================\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ Seeding failed with error:", message);
    process.exitCode = 1;
  } finally {
    // Disconnect DB connection cleanly
    await disconnectDB();
  }
}

seed().catch((err) => {
  console.error("❌ Uncaught script failure:", err);
  process.exit(1);
});
