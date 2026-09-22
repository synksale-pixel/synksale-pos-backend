/**
 * Purpose: Audit Service.
 * Thin write-side helper over the AuditLog model.
 *
 * DESIGN DECISION (never fail the request):
 * An audit write must not turn a successful mutation into a 500. Failures are logged at error
 * level and swallowed. The trade-off is accepted deliberately: losing an audit row is bad, but
 * rolling back a completed role change because the audit insert failed is worse, and would make
 * the audit log a single point of failure for every administrative endpoint.
 */

import mongoose from "mongoose";
import { AuditLog, AuditAction } from "../models/auditLog.model";
import { getRequestContext } from "../utils/requestContext";
import { logger } from "../config/logger.config";

export interface RecordAuditInput {
  organizationId: mongoose.Types.ObjectId | string;
  actorUserId: mongoose.Types.ObjectId | string;
  action: AuditAction;
  targetType: "user" | "store" | "role" | "organization";
  targetId: mongoose.Types.ObjectId | string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

const toObjectId = (
  value: mongoose.Types.ObjectId | string
): mongoose.Types.ObjectId =>
  typeof value === "string" ? new mongoose.Types.ObjectId(value) : value;

/**
 * Appends one audit entry. Call it from the service AFTER the mutation has been persisted,
 * so an audited action is always one that actually happened.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await AuditLog.create({
      organizationId: toObjectId(input.organizationId),
      actorUserId: toObjectId(input.actorUserId),
      action: input.action,
      targetType: input.targetType,
      targetId: toObjectId(input.targetId),
      before: input.before,
      after: input.after,
      requestId: getRequestContext()?.requestId,
    });
  } catch (error) {
    logger.error(
      `[AUDIT] Failed to record '${input.action}' on ${input.targetType} ${String(
        input.targetId
      )}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
