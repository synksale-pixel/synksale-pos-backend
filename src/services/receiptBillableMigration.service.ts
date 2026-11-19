/**
 * Purpose: Backfills goods receipts' billableQuantityMilli (run by `npm run migrate`, safe to repeat).
 *
 * Receipts posted before the field existed have none, so `?billable=true` would skip them. This
 * recomputes the total from the line counters for every receipt, the same sum billableMilli()
 * gives per line. It is one pipeline update per document, atomic against a bill or return being
 * saved at the same moment, so it can also run on a live database.
 *
 * Goes through the raw collection: the model refuses every update except a counter `$inc`.
 */

import { GoodsReceipt } from "../models/goodsReceipt.model";

export async function backfillReceiptBillable(): Promise<{ updated: number }> {
  const result = await GoodsReceipt.collection.updateMany({}, [
    {
      $set: {
        billableQuantityMilli: {
          $sum: {
            $map: {
              input: "$lines",
              as: "line",
              in: {
                $subtract: [
                  "$$line.quantityMilli",
                  {
                    $add: [
                      { $ifNull: ["$$line.billedQuantityMilli", 0] },
                      { $ifNull: ["$$line.returnedUnbilledMilli", 0] },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
  ]);
  return { updated: result.modifiedCount };
}
