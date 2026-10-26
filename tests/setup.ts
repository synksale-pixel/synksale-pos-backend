/**
 * Purpose: Global Vitest setup, executed before every test file.
 * Provisions an in-memory MongoDB, connects Mongoose to it, and wipes all
 * collections after each test so no state leaks between tests.
 */

import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll } from "vitest";

/**
 * Starts the replica set, retrying a failed start. With several test files starting a mongod at
 * once on a busy machine, one occasionally times out waiting for a primary
 * ("WaitForPrimaryTimeoutError") and the whole file fails before any test runs. This runs at
 * module load, outside any hook, so hookTimeout does not cover it; a failed attempt's processes
 * are stopped before the next one so they don't add to the load.
 */
async function startReplSet(attempts = 3): Promise<MongoMemoryReplSet> {
  for (let attempt = 1; ; attempt++) {
    const replSet = new MongoMemoryReplSet({ replSet: { count: 1 } });
    try {
      await replSet.start();
      await replSet.waitUntilRunning();
      return replSet;
    } catch (error) {
      await replSet.stop({ doCleanup: true, force: true }).catch(() => undefined);
      if (attempt >= attempts) throw error;
      console.warn(
        `In-memory MongoDB failed to start (attempt ${attempt}/${attempts}): ${
          error instanceof Error ? error.message : String(error)
        }. Retrying.`
      );
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// An in-memory MongoDB means tests never touch (or pollute) a real dev/test
// database, and they run with zero external DB setup.
const mongod = await startReplSet();

// IMPORTANT: src/config/env.config.ts validates process.env at import time and
// dotenv never overrides variables that already exist. Setting MONGO_URI here,
// before any src/ module is imported, makes the app's own connectDB() use the
// in-memory instance without any change to src/.
process.env.MONGO_URI = mongod.getUri();

beforeAll(async () => {
  // Dynamic import so env.config.ts is first loaded AFTER MONGO_URI is set.
  const { connectDB } = await import("../src/config/db.config");
  await connectDB();
  // Mongoose builds indexes in the background after connecting. Wait for them, or a file's first
  // tests can run before a unique index exists (seen as six concurrent creates of one SKU all
  // succeeding). By now the test file has imported the app, so every model is registered.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});

// afterEach (rather than beforeEach) so the DB is left clean even if a test
// fails midway, and the next test always starts from an empty database.
// Isolation matters especially here: this codebase is built around tenant/data
// isolation, so the tests themselves must never bleed data across cases.
afterEach(async () => {
  const collections = Object.values(mongoose.connection.collections);
  await Promise.all(collections.map((c) => c.deleteMany({})));
});

afterAll(async () => {
  const { disconnectDB } = await import("../src/config/db.config");
  await disconnectDB();
  await mongod.stop();
});
