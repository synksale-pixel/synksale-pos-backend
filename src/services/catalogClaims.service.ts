/**
 * Purpose: claims on catalog documents, so a delete and a write that adds a reference to the
 * same category, tax rate or variant cannot both succeed.
 *
 * MongoDB transactions run on snapshots and only detect a conflict between two transactions that
 * write the same document. A delete that checks "nothing references this" and a save that adds a
 * reference would otherwise both commit (write skew). So every write that adds a reference also
 * writes the referenced document (a hidden counter, `$inc`), inside its own transaction, and every
 * delete writes the document it deletes after re-checking its references in the same transaction.
 * Whichever transaction is second conflicts and is retried; its retry sees the other's result:
 * the delete is refused as in use, or the claim finds the document gone.
 *
 * A claim matches only documents that are not deleted (tenantScope hides soft-deleted ones), so a
 * claim that matches nothing means the document is gone and the caller reports it as not found.
 */
import mongoose from "mongoose";
import { Category } from "../models/category.model";
import { TaxRate } from "../models/taxRate.model";
import { ProductVariant } from "../models/productVariant.model";

type ObjectId = mongoose.Types.ObjectId;
const oid = (id: ObjectId | string) => (typeof id === "string" ? new mongoose.Types.ObjectId(id) : id);

/** Claims a category a product is about to reference. False when it no longer exists. */
export async function claimCategory(organizationId: string, categoryId: ObjectId | string, session: mongoose.ClientSession) {
  // treeVersion is also what subcategory writes claim (category.service claimParent).
  const result = await Category.updateOne(
    { _id: oid(categoryId), organizationId },
    { $inc: { treeVersion: 1 } },
    { session, timestamps: false }
  );
  return result.matchedCount === 1;
}

/** Claims a tax rate a product is about to reference. False when it no longer exists. */
export async function claimTaxRate(organizationId: string, taxRateId: ObjectId | string, session: mongoose.ClientSession) {
  const result = await TaxRate.updateOne(
    { _id: oid(taxRateId), organizationId },
    { $inc: { claimVersion: 1 } },
    { session, timestamps: false }
  );
  return result.matchedCount === 1;
}

/**
 * Claims the variants a purchase document or a first stock movement is about to reference.
 * Returns the ids that no longer exist (empty when every variant was claimed).
 */
export async function claimVariants(
  organizationId: string | ObjectId,
  variantIds: (ObjectId | string)[],
  session: mongoose.ClientSession
): Promise<ObjectId[]> {
  const ids = [...new Map(variantIds.map((id) => [id.toString().toLowerCase(), oid(id)])).values()];
  if (ids.length === 0) return [];
  const result = await ProductVariant.updateMany(
    { organizationId, _id: { $in: ids } },
    { $inc: { claimVersion: 1 } },
    { session, timestamps: false }
  );
  if (result.matchedCount === ids.length) return [];
  const present = await ProductVariant.find({ organizationId, _id: { $in: ids } }).select("_id").session(session);
  const found = new Set(present.map((variant) => variant._id.toString()));
  return ids.filter((id) => !found.has(id.toString()));
}
