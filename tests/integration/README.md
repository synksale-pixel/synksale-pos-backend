# Integration tests

Full-flow tests that hit real endpoints through the whole Express middleware chain.

## Running

- `npm test` — run everything once
- `npm run test:watch` — re-run on change
- `npm run test:coverage` — run with v8 coverage

## Pattern

1. `import { request } from "../helpers/testApp"` and call `request.post("/api/v1/...")`.
   It wraps `src/app.ts` with Supertest, so no real port is used.
2. `tests/setup.ts` runs automatically: it starts an in-memory MongoDB, connects the app
   to it, and clears every collection after each test. You never manage the DB yourself.
3. Create fixtures (orgs, users, roles) directly with the Mongoose models in
   `beforeEach`, not through the API — unless the API is the thing under test.
4. Tests must be independent: each `it` sets up what it needs, never relying on another `it`.

## Where files go

- `tests/integration/*.test.ts` — full-flow endpoint tests (here).
- `tests/unit/` — future home for isolated service/util tests (not created yet).
