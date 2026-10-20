/**
 * Purpose: Idempotent writes (`Idempotency-Key` header).
 * Runs a stock-changing request so that a retry with the same key replays the first response
 * instead of applying the change twice. See idempotencyKey.model.ts for the guarantees.
 */

import crypto from "node:crypto";
import mongoose from "mongoose";
import { IdempotencyKey } from "../models/idempotencyKey.model";
import { ApiError } from "../utils/ApiError";
import { runStockTransaction } from "./stockLedger.service";

export interface IdempotentRequest {
  organizationId: string;
  key: string;
  userId: string;
  method: string;
  /** The path including route params (e.g. /api/v1/stores/<id>/stock-adjustments), no query. */
  path: string;
  body: unknown;
}

export interface IdempotentResult {
  statusCode: number;
  body: unknown;
  replayed: boolean;
}

/** JSON with object keys sorted, so the same body always hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestFingerprint(request: Omit<IdempotentRequest, "organizationId" | "key">): string {
  return crypto
    .createHash("sha256")
    .update(`${request.userId}\n${request.method.toUpperCase()}\n${request.path}\n${canonicalJson(request.body)}`)
    .digest("hex");
}

function keyReused(): ApiError {
  return ApiError.coded(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "This Idempotency-Key was already used for a different request. Generate a new key for a new action."
  );
}

/**
 * Runs `work` in a transaction together with the idempotency record. `work` returns the response
 * body to send (and to replay later); it must do all its writes with the session it is given.
 */
export async function runIdempotent(
  request: IdempotentRequest,
  statusCode: number,
  work: (session: mongoose.ClientSession) => Promise<unknown>
): Promise<IdempotentResult> {
  const organizationId = new mongoose.Types.ObjectId(request.organizationId);
  const fingerprint = requestFingerprint(request);
  const replay = (stored: { fingerprint: string; statusCode: number; responseBody: unknown }): IdempotentResult => {
    if (stored.fingerprint !== fingerprint) throw keyReused();
    return { statusCode: stored.statusCode, body: stored.responseBody, replayed: true };
  };

  let outcome: { stored?: { fingerprint: string; statusCode: number; responseBody: unknown }; body?: unknown } = {};
  try {
    await runStockTransaction(async (session) => {
      outcome = {};
      const stored = await IdempotencyKey.findOne({ organizationId, key: request.key }).session(session);
      if (stored) {
        outcome.stored = stored;
        return;
      }
      // Stored as plain JSON so a replay is byte-for-byte what the first response sent.
      const body = JSON.parse(JSON.stringify(await work(session)));
      await IdempotencyKey.create([{ organizationId, key: request.key, fingerprint, statusCode, responseBody: body }], {
        session,
      });
      outcome.body = body;
    });
  } catch (error) {
    const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
    if (dup.code !== 11000 || dup.keyPattern?.key === undefined) throw error;
    // A concurrent request with this key committed first: replay it.
    const stored = await IdempotencyKey.findOne({ organizationId, key: request.key });
    if (!stored) {
      throw ApiError.coded(409, "IDEMPOTENCY_IN_PROGRESS", "A request with this Idempotency-Key is still being processed. Retry shortly.");
    }
    return replay(stored);
  }

  if (outcome.stored) return replay(outcome.stored);
  return { statusCode, body: outcome.body, replayed: false };
}
