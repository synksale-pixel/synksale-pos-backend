/**
 * Purpose: Audit Log model definition.
 * An append-only record of privileged mutations (who changed what, when).
 *
 * SCOPE (deliberately narrow):
 * Only privileged administrative actions are recorded — role assignments, store access grants,
 * account activation/deactivation, invite revocation, store lifecycle and organization approval.
 * Reads are not audited, and sales will not be either: a sale is its own ledger.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export const AUDIT_ACTIONS = [
  "user.invited",
  "user.invite_resent",
  "user.invite_revoked",
  "user.org_role_changed",
  "user.store_access_granted",
  "user.store_access_changed",
  "user.store_access_revoked",
  "user.activated",
  "user.deactivated",
  "store.created",
  "store.updated",
  "store.activated",
  "store.deactivated",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface IAuditLog {
  organizationId: mongoose.Types.ObjectId;
  actorUserId: mongoose.Types.ObjectId;
  action: AuditAction;
  targetType: "user" | "store" | "role" | "organization";
  targetId: mongoose.Types.ObjectId;
  /** Minimal before/after snapshot of only the fields the action changed. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** Correlates the entry with the request log (X-Request-Id). */
  requestId?: string;
  isDelete: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type AuditLogDocument = Document<
  mongoose.Types.ObjectId,
  Record<string, never>,
  IAuditLog
> &
  IAuditLog;

export type AuditLogModel = mongoose.Model<IAuditLog, Record<string, never>>;

const auditLogSchema = new Schema<IAuditLog, AuditLogModel>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    actorUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: AUDIT_ACTIONS,
      required: true,
    },
    targetType: {
      type: String,
      enum: ["user", "store", "role", "organization"],
      required: true,
    },
    targetId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    requestId: { type: String },
    isDelete: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

/** Supports "what happened to this user/store, newest first". */
auditLogSchema.index({ organizationId: 1, targetId: 1, createdAt: -1 });

/** Supports "what did this administrator do, newest first". */
auditLogSchema.index({ organizationId: 1, actorUserId: 1, createdAt: -1 });

auditLogSchema.plugin(tenantScopePlugin, { scope: "organization" });

const AuditLog = mongoose.model<IAuditLog, AuditLogModel>(
  "AuditLog",
  auditLogSchema
);

export default AuditLog;
export { AuditLog };
