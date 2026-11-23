/**
 * Purpose: Gives every existing store its "Register 1" (Phase 4a-2; run by `npm run migrate`,
 * safe to repeat).
 *
 * Stores created before 4a-2 have no register, and the till needs one. A store that has (or ever
 * had) any register is left alone, so a re-run never re-creates one a store deliberately
 * deleted. Deleted stores are skipped. Runs outside any request context, so it is unscoped.
 */

import mongoose from "mongoose";
import { Store } from "../models/store.model";
import { Register, DEFAULT_REGISTER_NAME } from "../models/register.model";

export async function backfillDefaultRegisters(): Promise<{ created: number }> {
  const storesWithRegisters: mongoose.Types.ObjectId[] = await Register.collection.distinct("storeId");
  const stores = await Store.find({ _id: { $nin: storesWithRegisters } }).select("_id organizationId");

  let created = 0;
  for (const store of stores) {
    try {
      await Register.create({ organizationId: store.organizationId, storeId: store._id, name: DEFAULT_REGISTER_NAME });
      created += 1;
    } catch (error) {
      // A store created (with its register) while this ran.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  return { created };
}
