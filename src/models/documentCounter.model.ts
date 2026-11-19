/**
 * Purpose: DocumentCounter model definition.
 * One counter per numbered series. Purchasing documents (purchase orders, goods receipts, vendor
 * bills, vendor payments, vendor returns and debit notes) have one series per organization. Sale
 * invoices and sale credit notes have one series per store and fiscal year. Numbers are taken
 * through nextDocumentNumber() (documentNumber.service) inside the transaction that creates the
 * document.
 */

import mongoose, { Schema, Document } from "mongoose";
import { tenantScopePlugin } from "./plugins/tenantScope.plugin";

export const SALE_COUNTER_TYPES = ["sale_invoice", "sale_credit_note"] as const;

export const COUNTER_TYPES = [
  "purchase_order",
  "goods_receipt",
  "bill",
  "vendor_payment",
  "vendor_return",
  "debit_note",
  ...SALE_COUNTER_TYPES,
] as const;
export type CounterType = (typeof COUNTER_TYPES)[number];

export interface IDocumentCounter {
  organizationId: mongoose.Types.ObjectId;
  type: CounterType;
  /** The store of a per-store series; null for organization-wide series. */
  storeId: mongoose.Types.ObjectId | null;
  /** The fiscal year's start year of a yearly series; null otherwise. */
  fiscalYear: number | null;
  /** The last number given out. */
  seq: number;
}

export type DocumentCounterDocument = Document<mongoose.Types.ObjectId, Record<string, never>, IDocumentCounter> &
  IDocumentCounter;

export type DocumentCounterModel = mongoose.Model<IDocumentCounter, Record<string, never>>;

const documentCounterSchema = new Schema<IDocumentCounter, DocumentCounterModel>({
  type: { type: String, enum: COUNTER_TYPES, required: true },
  storeId: { type: Schema.Types.ObjectId, ref: "Store", default: null },
  fiscalYear: { type: Number, default: null },
  seq: { type: Number, required: true, default: 0 },
});

// Not named `key`: idempotency.service reads a duplicate on a `key` index as an Idempotency-Key race.
// Counters created before storeId/fiscalYear existed index them as null, like organization-wide ones.
documentCounterSchema.index({ organizationId: 1, type: 1, storeId: 1, fiscalYear: 1 }, { unique: true });

documentCounterSchema.plugin(tenantScopePlugin, { scope: "organization", softDelete: false });

const DocumentCounter = mongoose.model<IDocumentCounter, DocumentCounterModel>("DocumentCounter", documentCounterSchema);

export default DocumentCounter;
export { DocumentCounter };
