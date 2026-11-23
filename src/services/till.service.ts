/**
 * Purpose: Till catalog reads (Phase 4a-2).
 * What a cashier needs to ring up an item at one store: the variant's display name, codes,
 * organization-wide selling price, tax and stock at THIS store. Never a cost (nothing
 * cost-related is read), so these are safe for cashiers.
 * - lookup: one scanned barcode or typed SKU (the matching of GET /products/lookup); a
 *   deactivated variant or product is 409 PRODUCT_INACTIVE, so the till can say "not for sale".
 * - items: active variants of active products, one row per variant, for the grid and search.
 */

import mongoose from "mongoose";
import { Organization } from "../models/organization.model";
import { Product } from "../models/product.model";
import { ProductVariant, variantDisplayName } from "../models/productVariant.model";
import { TaxRate } from "../models/taxRate.model";
import { StockLevel } from "../models/stockLevel.model";
import { ApiError } from "../utils/ApiError";
import { formatMoney } from "../utils/money";
import { fromMilli } from "../utils/quantity";
import { buildPaginationMeta, resolvePaging } from "../utils/pagination";
import { getCurrency } from "../config/currencies.config";
import { salesSettings } from "./organization.service";
import { categoryRefs, categoryWithDescendants } from "./category.service";
import { findByCode } from "./product.service";

type ObjectId = mongoose.Types.ObjectId;

/** Till pages are bigger than other lists: the item grid shows many tiles. */
const TILL_PAGE_LIMIT = 50;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The product fields a till item needs (no purchase or cost fields). */
interface TillProduct {
  _id: ObjectId;
  name: string;
  nameAr?: string | null;
  type: "goods" | "service";
  unit: string;
  hsnOrSac?: string | null;
  categoryId?: ObjectId | null;
  imageUrl?: string | null;
  taxPreference: "standard" | "zero_rated" | "exempt" | "out_of_scope";
  taxRateId?: ObjectId | null;
  attributes?: { name: string }[];
  inventory: { trackInventory: boolean };
}

/** The variant fields a till item needs (no costPriceMinor or lastPurchase). */
interface TillVariant {
  _id: ObjectId;
  sku?: string | null;
  barcodes?: { upc?: string | null; ean?: string | null; isbn?: string | null } | null;
  attributeValues?: Map<string, string> | Record<string, string> | null;
  sellingPriceMinor: number;
}

const PRODUCT_FIELDS = {
  name: 1,
  nameAr: 1,
  type: 1,
  unit: 1,
  hsnOrSac: 1,
  categoryId: 1,
  imageUrl: 1,
  taxPreference: 1,
  taxRateId: 1,
  attributes: 1,
  "inventory.trackInventory": 1,
};

interface Rows {
  variant: TillVariant;
  product: TillProduct;
}

/** Loads the per-page context (prices, tax rates, categories, this store's stock) and builds the views. */
async function toTillItems(organizationId: string, storeId: string, rows: Rows[]) {
  const organization = await Organization.findById(organizationId).select("settings");
  if (!organization) throw new ApiError(404, "Organization not found.");
  const decimals = getCurrency(organization.settings.currency).decimals;
  const { pricesIncludeTax } = salesSettings(organization);

  const taxRateIds = [
    ...new Set(
      rows
        .filter(({ product }) => product.taxPreference === "standard" && product.taxRateId)
        .map(({ product }) => product.taxRateId!.toString())
    ),
  ];
  const categoryIds = [
    ...new Map(
      rows.filter(({ product }) => product.categoryId).map(({ product }) => [product.categoryId!.toString(), product.categoryId!])
    ).values(),
  ];
  const trackedVariantIds = rows.filter(({ product }) => product.inventory.trackInventory).map(({ variant }) => variant._id);

  const [taxRates, categories, levels] = await Promise.all([
    taxRateIds.length ? TaxRate.find({ organizationId, _id: { $in: taxRateIds } }).select("name rate components") : [],
    categoryRefs(organizationId, categoryIds),
    trackedVariantIds.length
      ? StockLevel.find({ organizationId, storeId, variantId: { $in: trackedVariantIds } }).select("variantId quantityMilli")
      : [],
  ]);
  const taxRateById = new Map(taxRates.map((rate) => [rate._id.toString(), rate]));
  const stockByVariant = new Map(levels.map((level) => [level.variantId.toString(), level.quantityMilli]));

  return rows.map(({ variant, product }) => {
    const taxRate =
      product.taxPreference === "standard" && product.taxRateId ? taxRateById.get(product.taxRateId.toString()) : undefined;
    const category = product.categoryId ? categories.get(product.categoryId.toString()) : undefined;
    return {
      variantId: variant._id,
      productId: product._id,
      name: variantDisplayName(product, variant.attributeValues),
      nameAr: product.nameAr ?? null,
      sku: variant.sku ?? null,
      barcodes: {
        upc: variant.barcodes?.upc ?? null,
        ean: variant.barcodes?.ean ?? null,
        isbn: variant.barcodes?.isbn ?? null,
      },
      type: product.type,
      unit: product.unit,
      hsnOrSac: product.hsnOrSac ?? null,
      category: category ? { id: category.id, name: category.name } : null,
      imageUrl: product.imageUrl ?? null,
      sellingPrice: formatMoney(variant.sellingPriceMinor, decimals),
      pricesIncludeTax,
      taxPreference: product.taxPreference,
      taxRate: taxRate
        ? {
            id: taxRate._id,
            name: taxRate.name,
            rate: taxRate.rate,
            components: taxRate.components.map((component) => ({ name: component.name, rate: component.rate })),
          }
        : null,
      trackInventory: product.inventory.trackInventory,
      stockOnHand: product.inventory.trackInventory ? fromMilli(stockByVariant.get(variant._id.toString()) ?? 0) : null,
    };
  });
}

/** One scanned or typed code at the till. */
export async function tillLookup(organizationId: string, storeId: string, code: string) {
  const { product, variant, matchedOn } = await findByCode(organizationId, code);
  if (!variant.isActive || !product.isActive) {
    const name = variantDisplayName(product, variant.attributeValues);
    throw ApiError.coded(409, "PRODUCT_INACTIVE", `'${name}' is deactivated and cannot be sold.`, [
      {
        code: "PRODUCT_INACTIVE",
        meta: { productId: product._id.toString(), variantId: variant._id.toString(), name },
      },
    ]);
  }
  const [item] = await toTillItems(organizationId, storeId, [
    { variant: variant as unknown as TillVariant, product: product as unknown as TillProduct },
  ]);
  return { item, matchedOn };
}

export interface TillItemsInput {
  search?: string;
  categoryId?: string;
  page?: number;
  limit?: number;
}

/**
 * Active variants of active products, one row per variant, sorted by product name (then the
 * variants in the order they were added), paginated (default 50). `search` is a case-insensitive
 * prefix of the product name, or of this variant's SKU or a barcode. `categoryId` includes
 * subcategories; a malformed one matches nothing, like an unknown one.
 */
export async function listTillItems(organizationId: string, storeId: string, input: TillItemsInput) {
  const { page, limit, skip } = resolvePaging({ page: input.page, limit: input.limit ?? TILL_PAGE_LIMIT });
  const orgId = new mongoose.Types.ObjectId(organizationId);

  const productMatch: Record<string, unknown> = { isActive: true, isDelete: { $ne: true } };
  if (input.categoryId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(input.categoryId)) {
      return { items: [], pagination: buildPaginationMeta(page, limit, 0) };
    }
    productMatch.categoryId = {
      $in: await categoryWithDescendants(organizationId, new mongoose.Types.ObjectId(input.categoryId)),
    };
  }

  // MongoDB rejects a regex containing a NUL byte (500), so drop any from the term.
  const term = input.search?.replace(/\0/g, "").trim();
  const searchStage: mongoose.PipelineStage[] = term
    ? [
        {
          $match: {
            $or: [
              { "product.nameKey": { $regex: `^${escapeRegex(term.toLowerCase())}` } },
              { skuKey: { $regex: `^${escapeRegex(term.toLowerCase())}` } },
              { scanCodes: { $regex: `^${escapeRegex(term.replace(/-/g, "").toUpperCase())}` } },
            ],
          },
        },
      ]
    : [];

  const [result] = await ProductVariant.aggregate<{ total: { count: number }[]; rows: (TillVariant & { product: TillProduct })[] }>([
    { $match: { organizationId: orgId, isActive: true } },
    {
      // The tenant plugin does not reach inside $lookup, so the join scopes itself.
      $lookup: {
        from: Product.collection.name,
        let: { productId: "$productId" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$productId"] }, organizationId: orgId, ...productMatch } },
          { $project: { ...PRODUCT_FIELDS, nameKey: 1 } },
        ],
        as: "product",
      },
    },
    { $unwind: "$product" },
    ...searchStage,
    { $sort: { "product.nameKey": 1, "product._id": 1, _id: 1 } },
    {
      $facet: {
        total: [{ $count: "count" }],
        rows: [
          { $skip: skip },
          { $limit: limit },
          { $project: { sku: 1, barcodes: 1, attributeValues: 1, sellingPriceMinor: 1, product: 1 } },
        ],
      },
    },
  ]);

  const total = result?.total[0]?.count ?? 0;
  const rows = (result?.rows ?? []).map(({ product, ...variant }) => ({ variant, product }));
  return {
    items: await toTillItems(organizationId, storeId, rows),
    pagination: buildPaginationMeta(page, limit, total),
  };
}
