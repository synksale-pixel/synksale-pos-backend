/**
 * Purpose: Till Validators (Phase 4a-2, contract).
 * The till reads the catalog through store-scoped endpoints that return what a cashier needs to
 * ring up an item (price, tax, stock at this store) and nothing they should not see (costs).
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

export const tillLookupQuerySchema = z.object({
  code: z.string().openapi({
    description:
      "A scanned barcode (UPC/EAN/ISBN, with or without hyphens) or a SKU (case-insensitive). Exact match, the same rules as `GET /products/lookup`.",
    example: "6291041500213",
  }),
});

export const tillItemsQuerySchema = z.object({
  search: z.string().optional().openapi({
    description: "Case-insensitive prefix match on the product name, the variant's SKU or its UPC/EAN/ISBN.",
    example: "crew",
  }),
  categoryId: z.string().optional().openapi({
    description: "Only items in this category, including its subcategories.",
    example: "665f1c2e8a4b3c0012ab3700",
  }),
  page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
  limit: z.number().int().optional().openapi({ description: "Page size (default 50, max 100).", example: 50 }),
});
