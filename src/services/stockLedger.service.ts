/**
 * Purpose: Stock Ledger Engine.
 * The only code that changes stock. Every change appends a StockMovement and updates the
 * matching StockLevel in the same transaction, so the level is always the sum of its movements.
 *
 * Costing is weighted average per store (VAT-exclusive, minor units):
 * - Adding stock values it at the given unit cost (or an exact total, for transfers) and
 *   recalculates the average. When the store held 0 or less before, the average restarts at the
 *   new cost.
 * - Removing stock uses the current average, which does not change. Emptying the stock exactly
 *   removes the remaining value, so rounding never leaves a stray fil behind.
 * - At 0 or below, the level is worth 0; the last average is kept for stock removed meanwhile.
 *
 * Concurrency: callers run inside a transaction and read the level with the session. Two
 * transactions changing the same level both write it, so MongoDB aborts one with a transient
 * write conflict and mongoose retries it with fresh reads: no lost updates, no oversold stock.
 */

import mongoose from "mongoose";
import Decimal from "decimal.js";
import { StockLevel } from "../models/stockLevel.model";
import { StockMovement, IMovementSource, MovementType, StockMovementDocument } from "../models/stockMovement.model";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const MILLI = 1000;

const round = (value: Decimal) => {
  const result = value.toDecimalPlaces(0).toNumber();
  return result === 0 ? 0 : result;
};

export interface LevelState {
  quantityMilli: number;
  valueMinor: number;
  avgCostMinor: number | null;
}

export const EMPTY_LEVEL: LevelState = { quantityMilli: 0, valueMinor: 0, avgCostMinor: null };

export interface MovementMath {
  after: LevelState;
  unitCostMinor: number;
  valueChangeMinor: number;
}

/**
 * Adds `quantityMilli` (> 0) at `unitCostMinor` per unit. `totalValueMinor` overrides
 * quantity × cost when the exact value is known (a transfer carries what left the source).
 */
export function computeAddition(
  before: LevelState,
  quantityMilli: number,
  unitCostMinor: number,
  totalValueMinor?: number
): MovementMath {
  const added = totalValueMinor ?? round(new D(unitCostMinor).times(quantityMilli).dividedBy(MILLI));
  const afterQuantity = before.quantityMilli + quantityMilli;

  let valueMinor: number;
  if (before.quantityMilli > 0) {
    valueMinor = before.valueMinor + added;
  } else {
    // Restart from the new cost; only the part that brings the stock above zero has value.
    valueMinor = afterQuantity > 0 ? round(new D(added).times(afterQuantity).dividedBy(quantityMilli)) : 0;
  }
  const avgCostMinor =
    afterQuantity > 0 ? round(new D(valueMinor).times(MILLI).dividedBy(afterQuantity)) : unitCostMinor;

  return {
    after: { quantityMilli: afterQuantity, valueMinor, avgCostMinor },
    unitCostMinor,
    valueChangeMinor: added,
  };
}

/** Removes `quantityMilli` (> 0) at the current average cost. */
export function computeRemoval(before: LevelState, quantityMilli: number): MovementMath {
  const afterQuantity = before.quantityMilli - quantityMilli;
  const exactCost =
    before.quantityMilli > 0
      ? new D(before.valueMinor).times(MILLI).dividedBy(before.quantityMilli)
      : new D(before.avgCostMinor ?? 0);

  const valueChangeMinor =
    before.quantityMilli > 0 && afterQuantity === 0
      ? -before.valueMinor
      : -round(exactCost.times(quantityMilli).dividedBy(MILLI));

  const valueMinor = afterQuantity > 0 ? Math.max(0, before.valueMinor + valueChangeMinor) : 0;
  return {
    after: { quantityMilli: afterQuantity, valueMinor, avgCostMinor: before.avgCostMinor ?? round(exactCost) },
    unitCostMinor: round(exactCost),
    valueChangeMinor: valueChangeMinor === 0 ? 0 : valueChangeMinor,
  };
}

/** Reads a level inside the transaction; a missing row is an empty level. */
export async function readLevel(
  session: mongoose.ClientSession,
  organizationId: mongoose.Types.ObjectId,
  storeId: mongoose.Types.ObjectId,
  variantId: mongoose.Types.ObjectId
): Promise<LevelState> {
  const level = await StockLevel.findOne({ organizationId, storeId, variantId }).session(session);
  return level
    ? { quantityMilli: level.quantityMilli, valueMinor: level.valueMinor, avgCostMinor: level.avgCostMinor }
    : { ...EMPTY_LEVEL };
}

export interface ApplyMovementInput {
  organizationId: mongoose.Types.ObjectId;
  storeId: mongoose.Types.ObjectId;
  variantId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  type: MovementType;
  /** The level as read in this transaction. */
  before: LevelState;
  /** Signed and non-zero: positive adds stock. */
  quantityMilli: number;
  /** Required when adding stock. */
  unitCostMinor?: number;
  totalValueMinor?: number;
  source: IMovementSource;
  reason?: string | null;
  note?: string | null;
  createdBy: mongoose.Types.ObjectId | null;
  at: Date;
}

export interface AppliedMovement extends MovementMath {
  before: LevelState;
  movement: StockMovementDocument;
}

/**
 * Appends one movement and writes the level it produces. The caller has already decided the
 * change is allowed (negative-stock rules) and supplies the level it read in this transaction.
 */
export async function applyMovement(session: mongoose.ClientSession, input: ApplyMovementInput): Promise<AppliedMovement> {
  if (!Number.isSafeInteger(input.quantityMilli) || input.quantityMilli === 0) {
    throw new Error("applyMovement needs a non-zero whole number of milli units.");
  }
  const math =
    input.quantityMilli > 0
      ? computeAddition(input.before, input.quantityMilli, input.unitCostMinor ?? 0, input.totalValueMinor)
      : computeRemoval(input.before, -input.quantityMilli);

  await StockLevel.updateOne(
    { organizationId: input.organizationId, storeId: input.storeId, variantId: input.variantId },
    {
      $set: {
        quantityMilli: math.after.quantityMilli,
        valueMinor: math.after.valueMinor,
        avgCostMinor: math.after.avgCostMinor,
        lastMovementAt: input.at,
      },
      $setOnInsert: { productId: input.productId },
    },
    { upsert: true, session }
  );

  const [movement] = await StockMovement.create(
    [
      {
        organizationId: input.organizationId,
        storeId: input.storeId,
        variantId: input.variantId,
        productId: input.productId,
        type: input.type,
        quantityMilli: input.quantityMilli,
        quantityAfterMilli: math.after.quantityMilli,
        unitCostMinor: math.unitCostMinor,
        valueChangeMinor: math.valueChangeMinor,
        source: input.source,
        reason: input.reason ?? null,
        note: input.note ?? null,
        createdBy: input.createdBy,
        createdAt: input.at,
      },
    ],
    { session }
  );

  return { ...math, before: input.before, movement };
}

/**
 * Runs `work` in a transaction. Two first-ever movements of one variant in one store can race to
 * insert its level row; the loser fails on the unique index (not always as a retryable conflict),
 * so that case is retried here a few times with a fresh transaction.
 */
export async function runStockTransaction<T>(work: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      let result!: T;
      await mongoose.connection.transaction(async (session) => {
        result = await work(session);
      });
      return result;
    } catch (error) {
      const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
      const levelRace = dup.code === 11000 && dup.keyPattern?.storeId !== undefined && dup.keyPattern?.variantId !== undefined;
      if (!levelRace || attempt >= 3) throw error;
    }
  }
}
