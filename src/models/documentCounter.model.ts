/**
 * Purpose: DocumentCounter model definition.
 * One counter per organization and document type (purchase orders now; receipts and debit
 * notes later). Numbers are taken with an atomic `$inc` inside the transaction that creates the
 * document, so two documents saved at the same moment never share a number, and a document whose
 * transaction aborts gives its number back.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export const COUNTER_TYPES = ["purchase_order"] as const;
export type CounterType = (typeof COUNTER_TYPES)[number];

export interface IDocumentCounter {
  organizationId: mongoose.Types.ObjectId;
  type: CounterType;
  /** The last number given out. */
  seq: number;
}

export type DocumentCounterDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IDocumentCounter> &
  IDocumentCounter;

export type DocumentCounterModel = mongoose.Model<IDocumentCounter, Record<string, never>>;

const documentCounterSchema = new Schema<IDocumentCounter, DocumentCounterModel>({
  type: { type: String, enum: COUNTER_TYPES, required: true },
  seq: { type: Number, required: true, default: 0 },
});

// Not named `key`: idempotency.service reads a duplicate on a `key` index as an Idempotency-Key race.
documentCounterSchema.index({ organizationId: 1, type: 1 }, { unique: true });

documentCounterSchema.plugin(tenantScopePlugin, { scope: "organization", softDelete: false });

const DocumentCounter = mongoose.model<IDocumentCounter, DocumentCounterModel>("DocumentCounter", documentCounterSchema);

export default DocumentCounter;
export { DocumentCounter };
