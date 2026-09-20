/**
 * Purpose: Global Vitest setup, executed before every test file.
 * Provisions an in-memory MongoDB, connects Mongoose to it, and wipes all
 * collections after each test so no state leaks between tests.
 */

import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll } from "vitest";

// An in-memory MongoDB means tests never touch (or pollute) a real dev/test
// database, and they run with zero external DB setup.
const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });

// IMPORTANT: src/config/env.config.ts validates process.env at import time and
// dotenv never overrides variables that already exist. Setting MONGO_URI here,
// before any src/ module is imported, makes the app's own connectDB() use the
// in-memory instance without any change to src/.
process.env.MONGO_URI = mongod.getUri();

beforeAll(async () => {
  // Dynamic import so env.config.ts is first loaded AFTER MONGO_URI is set.
  const { connectDB } = await import("../src/config/db.config");
  await connectDB();
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
