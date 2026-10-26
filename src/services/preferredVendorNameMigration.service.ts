/**
 * Purpose: One-off data migration for Phase 3a.
 * Products used to carry a free-text `purchase.preferredVendorName`. Vendors replaced it with
 * `purchase.preferredVendorId`, and the schema no longer has the old field. Names cannot be
 * matched to vendors reliably, so instead of dropping them this appends each one to the
 * product's purchase description ("Preferred vendor: …") and unsets the old field.
 *
 * Uses the raw collection: the schema no longer knows the field, and this runs across every
 * organization outside any request context. Idempotent: a migrated product has no old field.
 */

import { Product } from "../models/product.model";

const PREFIX = "Preferred vendor: ";
/** The purchase description's limit in the product validator. */
const MAX_DESCRIPTION = 1000;

export function mergedDescription(description: string | null | undefined, vendorName: string): string {
  const line = `${PREFIX}${vendorName}`;
  if (!description) return line.slice(0, MAX_DESCRIPTION);
  // Trim the existing description, not the vendor line: the name is what must not be lost.
  const room = MAX_DESCRIPTION - line.length - 1;
  if (room <= 0) return line.slice(0, MAX_DESCRIPTION);
  return `${description.slice(0, room).trimEnd()}\n${line}`;
}

export async function migratePreferredVendorNames(): Promise<{ migrated: number; cleared: number }> {
  const collection = Product.collection;
  let migrated = 0;

  const cursor = collection.find(
    { "purchase.preferredVendorName": { $type: "string", $regex: "\\S" } },
    { projection: { "purchase.description": 1, "purchase.preferredVendorName": 1 } }
  );
  for await (const product of cursor) {
    const purchase = (product.purchase ?? {}) as { description?: string | null; preferredVendorName: string };
    await collection.updateOne(
      { _id: product._id },
      {
        $set: { "purchase.description": mergedDescription(purchase.description, purchase.preferredVendorName.trim()) },
        $unset: { "purchase.preferredVendorName": "" },
      }
    );
    migrated += 1;
  }

  // Nulls and empty strings carry nothing worth keeping.
  const { modifiedCount } = await collection.updateMany(
    { "purchase.preferredVendorName": { $exists: true } },
    { $unset: { "purchase.preferredVendorName": "" } }
  );

  return { migrated, cleared: modifiedCount };
}
