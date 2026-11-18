/**
 * Purpose: refuses request fields that a contract PR documents before they are implemented.
 *
 * A contract PR adds new fields to validators and Swagger so the frontend can review them, but the
 * models and services do not store them yet. Accepting and silently dropping them would look like
 * success, so they are refused with 400 VALIDATION_FAILED on the first one sent. Each phase's
 * implementation PR removes its call.
 */
import { ApiError } from "./ApiError";

/** Throws on the first field (path → value) that was sent. */
export function refuseUntilImplemented(phase: string, fields: Record<string, unknown>) {
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined) {
      const message = `Not available yet: arrives with the ${phase} implementation.`;
      throw ApiError.coded(400, "VALIDATION_FAILED", `Request Validation Failed: ${field}: ${message}`, [
        { field, code: "VALIDATION_FAILED", message },
      ]);
    }
  }
}
