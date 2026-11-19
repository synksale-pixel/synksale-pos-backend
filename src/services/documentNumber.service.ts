/**
 * Purpose: Document numbers.
 *
 * Every numbered document takes the next number from a DocumentCounter with an atomic `$inc`
 * inside the transaction that creates it, so two documents saved at the same moment never share a
 * number and an aborted transaction gives its number back.
 *
 * Purchasing documents count per organization. Sale invoices and credit notes (Phase 4c/4d) count
 * per store and fiscal year: `{invoicePrefix}-{YY}-000123` and `{invoicePrefix}-{YY}-R000045`.
 */

import mongoose from "mongoose";
import {
  DocumentCounter,
  CounterType,
  SALE_COUNTER_TYPES,
} from "../models/documentCounter.model";

const oid = (id: string | mongoose.Types.ObjectId) =>
  typeof id === "string" ? new mongoose.Types.ObjectId(id) : id;

export interface CounterKey {
  organizationId: string | mongoose.Types.ObjectId;
  type: CounterType;
  /** Set for per-store series (sales); null/absent for organization-wide ones. */
  storeId?: string | mongoose.Types.ObjectId | null;
  /** The fiscal year's start year for yearly series (sales); null/absent otherwise. */
  fiscalYear?: number | null;
}

/** Takes the next number of a series. Must run in the transaction that saves the document. */
export async function nextDocumentNumber(
  key: CounterKey,
  session: mongoose.ClientSession
): Promise<number> {
  const counter = await DocumentCounter.findOneAndUpdate(
    {
      organizationId: oid(key.organizationId),
      type: key.type,
      // null also matches counters created before these fields existed.
      storeId: key.storeId ? oid(key.storeId) : null,
      fiscalYear: key.fiscalYear ?? null,
    },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );
  return counter!.seq;
}

/**
 * Whether any sale invoice or credit note number has been given out in the organization (or in
 * one store). Settings that numbering depends on (invoicePrefix, fiscalYearStartMonth) are fixed
 * from then on. A counter only exists once a sale transaction committed, so this needs no sales
 * collection.
 */
export async function hasSaleNumbers(
  organizationId: string,
  storeId?: string
): Promise<boolean> {
  const filter: Record<string, unknown> = {
    organizationId: oid(organizationId),
    type: { $in: SALE_COUNTER_TYPES },
    seq: { $gt: 0 },
  };
  if (storeId) filter.storeId = oid(storeId);
  return Boolean(await DocumentCounter.exists(filter));
}

/** The calendar date (year, month 1-12) of `date` in `timeZone`. */
function localYearMonth(
  date: Date,
  timeZone: string
): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)!.value);
  return { year: value("year"), month: value("month") };
}

/**
 * The start year of the fiscal year `date` falls in, using the store's local date: with an April
 * start, 2027-03-31 belongs to fiscal year 2026 and 2027-04-01 to 2027.
 */
export function fiscalYearOf(
  date: Date,
  startMonth: number,
  timeZone: string
): number {
  const { year, month } = localYearMonth(date, timeZone);
  return month >= startMonth ? year : year - 1;
}

/** `SEEF-26-000123` for an invoice, `SEEF-26-R000045` for a credit note (at most 16 characters). */
export function formatSaleNumber(
  prefix: string,
  fiscalYear: number,
  seq: number,
  kind: "invoice" | "credit_note"
): string {
  const yy = String(fiscalYear % 100).padStart(2, "0");
  return `${prefix}-${yy}-${kind === "credit_note" ? "R" : ""}${String(seq).padStart(6, "0")}`;
}
