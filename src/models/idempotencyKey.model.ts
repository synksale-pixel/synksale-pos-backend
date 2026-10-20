/**
 * Purpose: IdempotencyKey model definition.
 * Remembers the response to a successful request sent with an `Idempotency-Key` header, so a
 * client retry (flaky shop Wi-Fi) replays it instead of applying the change twice.
 *
 * - Unique per organization and key. The record is inserted in the SAME transaction as the
 *   change it guards: a crash rolls both back (no stale lock, no change without its record), and
 *   two concurrent requests with one key conflict on this row, so the loser retries and replays.
 * - `fingerprint` hashes the user, method, path and body; the same key with anything else is
 *   refused (IDEMPOTENCY_KEY_REUSED), so a key never hands one user another's response.
 * - Expires 24 hours after creation (TTL index; MongoDB removes expired rows within about a
 *   minute, so a replay slightly past 24 hours is possible and harmless).
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface IIdempotencyKey {
  organizationId: mongoose.Types.ObjectId;
  key: string;
  fingerprint: string;
  statusCode: number;
  responseBody: unknown;
  createdAt?: Date;
}

export type IdempotencyKeyDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IIdempotencyKey> &
  IIdempotencyKey;

export type IdempotencyKeyModel = mongoose.Model<IIdempotencyKey, Record<string, never>>;

const idempotencyKeySchema = new Schema<IIdempotencyKey, IdempotencyKeyModel>(
  {
    key: { type: String, required: true },
    fingerprint: { type: String, required: true },
    statusCode: { type: Number, required: true },
    responseBody: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

idempotencyKeySchema.index({ organizationId: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: IDEMPOTENCY_TTL_SECONDS });

idempotencyKeySchema.plugin(tenantScopePlugin, { scope: "organization", softDelete: false });

const IdempotencyKey = mongoose.model<IIdempotencyKey, IdempotencyKeyModel>("IdempotencyKey", idempotencyKeySchema);

export default IdempotencyKey;
export { IdempotencyKey };
