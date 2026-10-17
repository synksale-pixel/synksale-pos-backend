/**
 * Purpose: The browser preflight must allow the headers the API contract asks clients to send
 * (Idempotency-Key on stock adjustments and transfers) and expose the ones it sends back.
 * Supertest and Requestly skip preflight, so without this a missing header only breaks in a browser.
 */

import { describe, it, expect } from "vitest";
import { request } from "../helpers/testApp";

describe("CORS", () => {
  it("allows the Idempotency-Key request header in a preflight", async () => {
    const res = await request
      .options("/api/v1/stock-transfers")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,authorization,idempotency-key");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-headers"].toLowerCase()).toContain("idempotency-key");
  });

  it("exposes Idempotent-Replayed and X-Request-Id to the frontend", async () => {
    const res = await request.get("/api/v1/health").set("Origin", "https://app.example.com");
    const exposed = (res.headers["access-control-expose-headers"] ?? "").toLowerCase();
    expect(exposed).toContain("idempotent-replayed");
    expect(exposed).toContain("x-request-id");
  });
});
