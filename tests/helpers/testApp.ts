/**
 * Purpose: Supertest handle onto the Express app for integration tests.
 */

import supertest from "supertest";
import app from "../../src/app";

// Imports app.ts (not server.ts), so nothing listens on a real port. Every test
// file can `import { request } from "../helpers/testApp"` and call
// `request.post("/api/v1/...")` directly against the in-memory app.
export const request = supertest(app);
