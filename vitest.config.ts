/**
 * Purpose: Vitest configuration for the SynkSale backend test suite.
 * Runs tests in a Node environment with a shared setup file that provisions
 * an in-memory MongoDB and isolates state between tests.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests exercise the full middleware chain against a real
    // (in-memory) MongoDB, and the first run may spin up the mongod binary,
    // so Vitest's 5s default is too tight.
    testTimeout: 15000,
    hookTimeout: 60000, // first-run mongod binary download/startup happens in hooks
    // Every test file starts its own in-memory replica set (tests/setup.ts). With one worker per
    // core, a dozen mongod processes start at once and some time out waiting for a primary
    // ("WaitForPrimaryTimeoutError"), failing whole files. Four at a time is reliable.
    maxWorkers: 4,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});
