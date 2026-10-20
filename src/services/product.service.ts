/**
 * Purpose: Product Service.
 * The organization's catalog: products and their variants. Every product has at least one
 * variant; a `single` item has exactly one hidden default variant whose SKU, barcodes, prices and
 * reorder point the API exposes at the product's top level, as the frontend form groups them.
 *
 * - Money arrives as decimal strings and is stored as integer minor units of the organization's
 *   currency (parseMoney rejects more decimals than the currency has).
 * - SKU and scannable barcode uniqueness is checked up front so the 409 can name the product
 *   that already has the value; the unique indexes remain the final word under races.
 * - Rules that the model hooks enforce on save() only (service never tracks inventory, no tax
 *   rate unless standard-rated) are applied here before every write.
 * - Product and ProductVariant are organization-scoped by the tenantScopePlugin; organizationId
 *   is still passed explicitly, as in every other service.
 */

import mongoose from "mongoose";
import { Product, ProductDocument, IProductAttribute, TaxPreference } from "../models/product.model";
import {
  ProductVariant,
  ProductVariantDocument,
  deriveScanCodes,
  variantDisplayName,
} from "../models/productVariant.model";
import { TaxRate } from "../models/taxRate.model";
import { ApiError, ApiErrorDetail } from "../utils/ApiError";
import { parseMoney, formatMoney } from "../utils/money";
import { resolvePaging, buildPaginationMeta } from "../utils/pagination";
import { logger } from "../config/logger.config";
import { getCurrency } from "../config/currencies.config";
import { unitAllowsDecimal } from "../config/units.config";
import { getOrganizationCurrency } from "./organization.service";
import { assertCategoryExists, categoryRefs, categoryWithDescendants, CategoryRef } from "./category.service";
import { recordAudit } from "./audit.service";
import {
  prepareOpeningStock,
  recordOpeningStock,
  hasStockMovements,
  hasStockOnHand,
  stockOnHandByVariant,
  PreparedOpeningLine,
} from "./stock.service";
import { fromMilli } from "../utils/quantity";
import type {
  CreateProductInput,
  UpdateProductInput,
  VariantInput,
  UpdateVariantInput,
} from "../validators/product.validator";

export interface ListProductsInput {
  search?: string;
  /** A category id, or "none" for uncategorised products. */
  categoryId?: string;
  /** With categoryId: also match products in its subcategories (default true). */
  includeSubcategories?: boolean;
  type?: "goods" | "service";
  isActive?: boolean;
  tag?: string;
  page?: number;
  limit?: number;
}

const BARCODE_KINDS = ["upc", "ean", "isbn", "mpn"] as const;
const SCANNABLE_KINDS = ["upc", "ean", "isbn"] as const;
type BarcodeKind = (typeof BARCODE_KINDS)[number];
type BarcodesInput = Partial<Record<BarcodeKind, string | null>>;

/** The per-variant fields, wherever the request carries them. */
interface VariantFields {
  sku?: string | null;
  barcodes?: BarcodesInput;
  sellingPrice?: string;
  costPrice?: string | null;
  reorderPoint?: number | null;
}

/** Where each variant field sits in the request body, for error `field` paths. */
interface FieldPaths {
  sku: string;
  barcodes: string;
  sellingPrice: string;
  costPrice: string;
  reorderPoint: string;
}

/** A single item's default variant: the fields sit in the form's groups. */
const SINGLE_PATHS: FieldPaths = {
  sku: "sku",
  barcodes: "barcodes",
  sellingPrice: "sales.sellingPrice",
  costPrice: "purchase.costPrice",
  reorderPoint: "inventory.reorderPoint",
};

const variantPaths = (prefix: string): FieldPaths => ({
  sku: `${prefix}sku`,
  barcodes: `${prefix}barcodes`,
  sellingPrice: `${prefix}sellingPrice`,
  costPrice: `${prefix}costPrice`,
  reorderPoint: `${prefix}reorderPoint`,
});

// ==========================================
// Errors
// ==========================================

function validationError(field: string, message: string): ApiError {
  return ApiError.coded(400, "VALIDATION_FAILED", `Request Validation Failed: ${field}: ${message}`, [
    { field, code: "VALIDATION_FAILED", message },
  ]);
}

function productNotFound(): ApiError {
  return ApiError.coded(404, "PRODUCT_NOT_FOUND", "Product not found.");
}

function variantNotFound(): ApiError {
  return ApiError.coded(404, "VARIANT_NOT_FOUND", "Variant not found.");
}

function notVariantItem(): ApiError {
  return ApiError.coded(
    400,
    "PRODUCT_NOT_VARIANT_ITEM",
    "This product is a single item and has no separately managed variants."
  );
}

function lastActiveVariant(): ApiError {
  return ApiError.coded(
    409,
    "LAST_ACTIVE_VARIANT",
    "A product must keep at least one active variant. Deactivate the product instead."
  );
}

/**
 * Maps a unique-index violation that slipped past the up-front checks (a concurrent write) to the
 * same codes, without the product details the up-front check would have named.
 */
function mapDuplicateKey(error: unknown): unknown {
  const dup = error as { code?: number; keyPattern?: Record<string, unknown> };
  if (dup.code !== 11000) return error;
  if (dup.keyPattern?.skuKey) {
    return ApiError.coded(409, "SKU_TAKEN", "This SKU is already used by another variant.");
  }
  if (dup.keyPattern?.scanCodes) {
    return ApiError.coded(409, "BARCODE_TAKEN", "This barcode is already used by another variant.");
  }
  if (dup.keyPattern?.comboKey) {
    return ApiError.coded(409, "VARIANT_COMBINATION_TAKEN", "A variant with these attribute values already exists.");
  }
  return error;
}

// ==========================================
// Lookups
// ==========================================

async function currencyDecimals(organizationId: string): Promise<number> {
  return getCurrency(await getOrganizationCurrency(organizationId)).decimals;
}

async function findProductOrThrow(organizationId: string, productId: string) {
  const product = await Product.findOne({ _id: productId, organizationId });
  if (!product) {
    throw productNotFound();
  }
  return product;
}

async function findVariantOrThrow(organizationId: string, productId: string, variantId: string) {
  const variant = await ProductVariant.findOne({ _id: variantId, organizationId, productId });
  if (!variant) {
    throw variantNotFound();
  }
  return variant;
}

async function findDefaultVariant(organizationId: string, product: ProductDocument) {
  const variant = await ProductVariant.findOne({ organizationId, productId: product._id, isDefault: true });
  if (!variant) {
    // Every single item is created with one; its absence is a data bug, not a client error.
    throw new ApiError(500, "The product has no default variant.");
  }
  return variant;
}

/**
 * Resolves the tax rate a product will reference. A standard-rated product uses the given rate
 * (which must exist and be active) or else the organization's default; any other preference
 * carries no rate.
 */
async function resolveTaxRateId(
  organizationId: string,
  taxPreference: TaxPreference,
  taxRateId: string | null | undefined
): Promise<mongoose.Types.ObjectId | null> {
  if (taxPreference !== "standard") {
    if (taxRateId) {
      throw validationError("taxRateId", `A ${taxPreference} product must not have a tax rate.`);
    }
    return null;
  }

  if (taxRateId) {
    const rate = await TaxRate.findOne({ _id: taxRateId, organizationId });
    if (!rate) {
      throw ApiError.coded(400, "TAX_RATE_NOT_FOUND", "Tax rate not found.", [
        { field: "taxRateId", code: "TAX_RATE_NOT_FOUND" },
      ]);
    }
    if (!rate.isActive) {
      throw ApiError.coded(400, "TAX_RATE_INACTIVE", `Tax rate '${rate.name}' is inactive.`, [
        { field: "taxRateId", code: "TAX_RATE_INACTIVE" },
      ]);
    }
    return rate._id;
  }

  const fallback = await TaxRate.findOne({ organizationId, isDefault: true, isActive: true });
  if (!fallback) {
    throw ApiError.coded(
      400,
      "TAX_RATE_REQUIRED",
      "A standard-rated product needs a tax rate, and the organization has no default rate. Send taxRateId or choose another tax preference.",
      [{ field: "taxRateId", code: "TAX_RATE_REQUIRED" }]
    );
  }
  return fallback._id;
}

// ==========================================
// Variant field handling
// ==========================================

function assertQuantityFitsUnit(value: number | null | undefined, unit: string, field: string) {
  if (value !== null && value !== undefined && !unitAllowsDecimal(unit) && !Number.isInteger(value)) {
    throw validationError(field, `Unit '${unit}' only allows whole quantities.`);
  }
}

const key = (value: string) => value.trim().toLowerCase();

/**
 * Checks attribute values against the product's attributes (names and options case-insensitive)
 * and returns them in canonical spelling with the combination key.
 */
function canonicalCombination(
  attributes: IProductAttribute[],
  attributeValues: Record<string, string>,
  field: string
): { values: Map<string, string>; comboKey: string } {
  const entries = Object.entries(attributeValues);
  const values = new Map<string, string>();

  for (const attribute of attributes) {
    const match = entries.find(([name]) => key(name) === key(attribute.name));
    if (!match) {
      throw validationError(field, `Each variant needs exactly one value for: ${attributes.map((a) => a.name).join(", ")}.`);
    }
    const option = attribute.options.find((candidate) => key(candidate) === key(match[1]));
    if (!option) {
      throw validationError(`${field}.${attribute.name}`, `'${match[1]}' is not an option of ${attribute.name}.`);
    }
    values.set(attribute.name, option);
  }
  if (entries.length !== attributes.length) {
    throw validationError(field, `Each variant needs exactly one value for: ${attributes.map((a) => a.name).join(", ")}.`);
  }

  const comboKey = attributes.map((attribute) => key(values.get(attribute.name)!)).join("\u0000");
  return { values, comboKey };
}

function newVariant(
  organizationId: string,
  product: ProductDocument,
  fields: VariantFields,
  decimals: number,
  paths: FieldPaths,
  identity: { attributeValues?: Map<string, string>; comboKey?: string; isDefault?: boolean }
): ProductVariantDocument {
  assertQuantityFitsUnit(fields.reorderPoint, product.unit, paths.reorderPoint);
  return new ProductVariant({
    organizationId: new mongoose.Types.ObjectId(organizationId),
    productId: product._id,
    attributeValues: identity.attributeValues ?? new Map(),
    comboKey: identity.comboKey ?? "",
    isDefault: identity.isDefault ?? false,
    sku: fields.sku ?? null,
    barcodes: {
      upc: fields.barcodes?.upc ?? null,
      ean: fields.barcodes?.ean ?? null,
      isbn: fields.barcodes?.isbn ?? null,
      mpn: fields.barcodes?.mpn ?? null,
    },
    sellingPriceMinor: parseMoney(fields.sellingPrice!, decimals, paths.sellingPrice),
    costPriceMinor:
      fields.costPrice === null || fields.costPrice === undefined
        ? null
        : parseMoney(fields.costPrice, decimals, paths.costPrice),
    reorderPoint: fields.reorderPoint ?? null,
  });
}

interface PriceChange {
  variantId: mongoose.Types.ObjectId;
  before: { sellingPriceMinor: number; costPriceMinor: number | null };
  after: { sellingPriceMinor: number; costPriceMinor: number | null };
}

/**
 * Applies an update's variant fields to a loaded variant (not yet saved). Returns the price
 * change, if any, for the audit log, and whether the SKU or barcodes changed.
 */
function applyVariantFields(
  variant: ProductVariantDocument,
  fields: VariantFields,
  decimals: number,
  paths: FieldPaths,
  unit: string
): { priceChange: PriceChange | null; codesChanged: boolean } {
  const before = { sellingPriceMinor: variant.sellingPriceMinor, costPriceMinor: variant.costPriceMinor };
  let codesChanged = false;

  if (fields.sku !== undefined) {
    variant.sku = fields.sku;
    variant.skuKey = fields.sku ? key(fields.sku) : null;
    codesChanged = true;
  }
  if (fields.barcodes !== undefined) {
    for (const kind of BARCODE_KINDS) {
      const value = fields.barcodes[kind];
      if (value !== undefined) {
        variant.set(`barcodes.${kind}`, value);
      }
    }
    variant.scanCodes = deriveScanCodes(variant.barcodes);
    codesChanged = true;
  }
  if (fields.sellingPrice !== undefined) {
    variant.sellingPriceMinor = parseMoney(fields.sellingPrice, decimals, paths.sellingPrice);
  }
  if (fields.costPrice !== undefined) {
    variant.costPriceMinor = fields.costPrice === null ? null : parseMoney(fields.costPrice, decimals, paths.costPrice);
  }
  if (fields.reorderPoint !== undefined) {
    assertQuantityFitsUnit(fields.reorderPoint, unit, paths.reorderPoint);
    variant.reorderPoint = fields.reorderPoint;
  }

  const after = { sellingPriceMinor: variant.sellingPriceMinor, costPriceMinor: variant.costPriceMinor };
  const changed =
    before.sellingPriceMinor !== after.sellingPriceMinor || before.costPriceMinor !== after.costPriceMinor;
  return { priceChange: changed ? { variantId: variant._id, before, after } : null, codesChanged };
}

/**
 * Refuses SKUs and scannable barcodes already used by another variant in the organization, naming
 * every conflict and the product that has the value.
 */
async function assertCodesAvailable(
  organizationId: string,
  candidates: { variant: ProductVariantDocument; paths: FieldPaths }[],
  excludeVariantIds: mongoose.Types.ObjectId[] = []
) {
  const skuKeys = candidates.map(({ variant }) => (variant.sku ? key(variant.sku) : null)).filter(Boolean);
  const scanCodes = candidates.flatMap(({ variant }) => deriveScanCodes(variant.barcodes));
  if (skuKeys.length === 0 && scanCodes.length === 0) return;

  const conflicts = await ProductVariant.find({
    organizationId,
    _id: { $nin: excludeVariantIds },
    $or: [{ skuKey: { $in: skuKeys } }, { scanCodes: { $in: scanCodes } }],
  }).select("productId skuKey scanCodes");
  if (conflicts.length === 0) return;

  const products = await Product.find({
    organizationId,
    _id: { $in: conflicts.map((conflict) => conflict.productId) },
  }).select("name");
  const productName = new Map(products.map((product) => [product._id.toString(), product.name]));
  const owner = (conflict: ProductVariantDocument) => ({
    productId: conflict.productId.toString(),
    productName: productName.get(conflict.productId.toString()) ?? null,
  });

  const errors: ApiErrorDetail[] = [];
  for (const { variant, paths } of candidates) {
    if (variant.sku) {
      const conflict = conflicts.find((c) => c.skuKey === key(variant.sku!));
      if (conflict) {
        errors.push({ field: paths.sku, code: "SKU_TAKEN", meta: { value: variant.sku, ...owner(conflict) } });
      }
    }
    for (const kind of SCANNABLE_KINDS) {
      const code = variant.barcodes?.[kind];
      const conflict = code ? conflicts.find((c) => c.scanCodes.includes(code)) : undefined;
      if (code && conflict) {
        errors.push({ field: `${paths.barcodes}.${kind}`, code: "BARCODE_TAKEN", meta: { value: code, ...owner(conflict) } });
      }
    }
  }
  if (errors.length === 0) return;

  const first = errors[0];
  const label = first.code === "SKU_TAKEN" ? "SKU" : "Barcode";
  const by = first.meta?.productName ? ` by '${first.meta.productName}'` : "";
  throw ApiError.coded(409, first.code!, `${label} '${first.meta?.value}' is already used${by}.`, errors);
}

async function auditPriceChanges(
  organizationId: string,
  productId: mongoose.Types.ObjectId,
  changes: PriceChange[],
  decimals: number,
  actorUserId: string
) {
  const format = (prices: PriceChange["before"]) => ({
    sellingPrice: formatMoney(prices.sellingPriceMinor, decimals),
    costPrice: prices.costPriceMinor === null ? null : formatMoney(prices.costPriceMinor, decimals),
  });
  for (const change of changes) {
    await recordAudit({
      organizationId,
      actorUserId,
      action: "product.price_changed",
      targetType: "product",
      targetId: productId,
      before: { variantId: change.variantId.toString(), ...format(change.before) },
      after: { variantId: change.variantId.toString(), ...format(change.after) },
    });
  }
}

/**
 * Runs `work` in a transaction, translating unique-index violations to the API's codes.
 *
 * connection.transaction() rather than session.withTransaction(): the documents saved here are
 * built before the transaction starts, and on a transient-error retry withTransaction would
 * re-run the callback with documents already marked as saved (isNew false), turning the insert
 * into an update of a row the aborted attempt never committed. Mongoose's wrapper resets that
 * document state between attempts.
 */
async function inTransaction(work: (session: mongoose.ClientSession) => Promise<void>) {
  try {
    await mongoose.connection.transaction(work);
  } catch (error) {
    throw mapDuplicateKey(error);
  }
}

// ==========================================
// Response shapes
// ==========================================

type TaxRateRef = { id: mongoose.Types.ObjectId; name: string; rate: number } | null;

/** What a response may show the caller. */
export interface ViewOptions {
  /** Cost prices; false for callers without inventory:read or a product write permission. */
  showCost: boolean;
}

const FULL_VIEW: ViewOptions = { showCost: true };

/** Quantity on hand across active stores, or null when the product does not track inventory. */
function onHand(product: ProductDocument, variantId: mongoose.Types.ObjectId, stock: Map<string, number>): number | null {
  return product.inventory.trackInventory ? fromMilli(stock.get(variantId.toString()) ?? 0) : null;
}

function toVariantView(
  product: ProductDocument,
  variant: ProductVariantDocument,
  decimals: number,
  stock: Map<string, number>,
  options: ViewOptions
) {
  const values = variant.attributeValues ?? new Map<string, string>();
  return {
    id: variant._id,
    attributeValues: Object.fromEntries(values),
    name: variantDisplayName(product, values),
    sku: variant.sku ?? null,
    barcodes: {
      upc: variant.barcodes?.upc ?? null,
      ean: variant.barcodes?.ean ?? null,
      isbn: variant.barcodes?.isbn ?? null,
      mpn: variant.barcodes?.mpn ?? null,
    },
    sellingPrice: formatMoney(variant.sellingPriceMinor, decimals),
    costPrice:
      !options.showCost || variant.costPriceMinor === null ? null : formatMoney(variant.costPriceMinor, decimals),
    reorderPoint: variant.reorderPoint ?? null,
    stockOnHand: onHand(product, variant._id, stock),
    isDefault: variant.isDefault,
    isActive: variant.isActive,
  };
}

function priceRange(variants: ProductVariantDocument[], decimals: number) {
  const prices = variants.filter((variant) => variant.isActive).map((variant) => variant.sellingPriceMinor);
  if (prices.length === 0) return null;
  return { min: formatMoney(Math.min(...prices), decimals), max: formatMoney(Math.max(...prices), decimals) };
}

function productCore(
  product: ProductDocument,
  variants: ProductVariantDocument[],
  category: CategoryRef | null,
  decimals: number
) {
  return {
    _id: product._id,
    id: product._id,
    name: product.name,
    type: product.type,
    itemType: product.itemType,
    category,
    unit: product.unit,
    imageUrl: product.imageUrl ?? null,
    taxPreference: product.taxPreference,
    isActive: product.isActive,
    priceRange: priceRange(variants, decimals),
  };
}

function toProductView(
  product: ProductDocument,
  variants: ProductVariantDocument[],
  category: CategoryRef | null,
  taxRate: TaxRateRef,
  decimals: number,
  stock: Map<string, number>,
  options: ViewOptions
) {
  return {
    ...productCore(product, variants, category, decimals),
    organizationId: product.organizationId,
    brand: product.brand ?? null,
    manufacturer: product.manufacturer ?? null,
    taxRate,
    dimensions: product.dimensions
      ? {
          length: product.dimensions.length,
          width: product.dimensions.width,
          height: product.dimensions.height,
          unit: product.dimensions.unit,
        }
      : null,
    weight: product.weight ? { value: product.weight.value, unit: product.weight.unit } : null,
    reportingTags: [...product.reportingTags],
    sales: { description: product.sales?.description ?? null },
    purchase: {
      description: product.purchase?.description ?? null,
      preferredVendorName: product.purchase?.preferredVendorName ?? null,
    },
    inventory: {
      trackInventory: product.inventory.trackInventory,
      returnable: product.inventory.returnable,
      valuationMethod: product.inventory.valuationMethod,
    },
    attributes: product.attributes.map((attribute) => ({ name: attribute.name, options: [...attribute.options] })),
    variants: variants.map((variant) => toVariantView(product, variant, decimals, stock, options)),
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

/** Loads everything the full product response needs. */
async function buildProductView(
  organizationId: string,
  product: ProductDocument,
  decimals?: number,
  options: ViewOptions = FULL_VIEW
) {
  const [variants, categories, taxRate, resolvedDecimals] = await Promise.all([
    ProductVariant.find({ organizationId, productId: product._id }).sort({ _id: 1 }),
    categoryRefs(organizationId, product.categoryId ? [product.categoryId] : []),
    product.taxRateId ? TaxRate.findOne({ _id: product.taxRateId, organizationId }).select("name rate") : null,
    decimals ?? currencyDecimals(organizationId),
  ]);
  const stock = product.inventory.trackInventory
    ? await stockOnHandByVariant(organizationId, variants.map((variant) => variant._id))
    : new Map<string, number>();
  return toProductView(
    product,
    variants,
    product.categoryId ? (categories.get(product.categoryId.toString()) ?? null) : null,
    taxRate ? { id: taxRate._id, name: taxRate.name, rate: taxRate.rate } : null,
    resolvedDecimals,
    stock,
    options
  );
}

// ==========================================
// Reads
// ==========================================

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Paginated product summaries. Newest first, or by name when searching. `search` is a
 * case-insensitive prefix match on the product name, a variant SKU or a scannable barcode.
 */
export async function listProducts(organizationId: string, input: ListProductsInput) {
  const { page, limit, skip } = resolvePaging(input);
  const filter: Record<string, unknown> = { organizationId };

  if (input.categoryId !== undefined) {
    if (input.categoryId === "none") {
      filter.categoryId = null;
    } else if (mongoose.Types.ObjectId.isValid(input.categoryId)) {
      const categoryId = new mongoose.Types.ObjectId(input.categoryId);
      filter.categoryId =
        input.includeSubcategories === false
          ? categoryId
          : { $in: await categoryWithDescendants(organizationId, categoryId) };
    } else {
      // A malformed id matches nothing, as an unknown one would.
      return { products: [], pagination: buildPaginationMeta(page, limit, 0) };
    }
  }
  if (input.type) filter.type = input.type;
  if (input.isActive !== undefined) filter.isActive = input.isActive;
  if (input.tag) filter.reportingTags = input.tag;

  const term = input.search?.trim();
  if (term) {
    const matchingVariantProducts = await ProductVariant.distinct("productId", {
      organizationId,
      $or: [
        { skuKey: { $regex: `^${escapeRegex(key(term))}` } },
        { scanCodes: { $regex: `^${escapeRegex(term.toUpperCase())}` } },
      ],
    });
    filter.$or = [
      { nameKey: { $regex: `^${escapeRegex(key(term))}` } },
      { _id: { $in: matchingVariantProducts } },
    ];
  }

  const sort: Record<string, 1 | -1> = term ? { nameKey: 1, _id: 1 } : { createdAt: -1, _id: -1 };
  const [total, products, decimals] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter).sort(sort).skip(skip).limit(limit),
    currencyDecimals(organizationId),
  ]);

  const productIds = products.map((product) => product._id);
  const categoryIds = products
    .map((product) => product.categoryId)
    .filter((id): id is mongoose.Types.ObjectId => Boolean(id));
  const [variants, categoryById] = await Promise.all([
    ProductVariant.find({ organizationId, productId: { $in: productIds } }).sort({ _id: 1 }),
    categoryRefs(organizationId, categoryIds),
  ]);
  // One grouped read for the page; stockOnHand is never sorted or filtered on.
  const stock = await stockOnHandByVariant(
    organizationId,
    variants.filter((variant) => variant.isActive).map((variant) => variant._id)
  );

  const variantsByProduct = new Map<string, ProductVariantDocument[]>();
  for (const variant of variants) {
    const id = variant.productId.toString();
    variantsByProduct.set(id, [...(variantsByProduct.get(id) ?? []), variant]);
  }

  return {
    products: products.map((product) => {
      const own = variantsByProduct.get(product._id.toString()) ?? [];
      const category = product.categoryId ? (categoryById.get(product.categoryId.toString()) ?? null) : null;
      return {
        ...productCore(product, own, category, decimals),
        sku: product.itemType === "single" ? (own.find((variant) => variant.isDefault)?.sku ?? null) : null,
        variantCount: own.filter((variant) => variant.isActive).length,
        stockOnHand: product.inventory.trackInventory
          ? fromMilli(
              own
                .filter((variant) => variant.isActive)
                .reduce((total, variant) => total + (stock.get(variant._id.toString()) ?? 0), 0)
            )
          : null,
        updatedAt: product.updatedAt,
      };
    }),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

export async function getProduct(organizationId: string, productId: string, options: ViewOptions = FULL_VIEW) {
  const product = await findProductOrThrow(organizationId, productId);
  return buildProductView(organizationId, product, undefined, options);
}

/**
 * Exact match on a scanned barcode (UPC/EAN/ISBN) or a SKU (case-insensitive). A barcode match
 * wins over a SKU that happens to have the same characters. Inactive products and variants are
 * still returned so the POS can explain why they cannot be sold.
 */
export async function lookupProduct(organizationId: string, code: string, options: ViewOptions = FULL_VIEW) {
  const text = code.trim();
  if (!text) {
    throw validationError("code", "Required");
  }

  const scanCandidates = [...new Set([text, text.replace(/-/g, "").toUpperCase()])];
  let variant = await ProductVariant.findOne({ organizationId, scanCodes: { $in: scanCandidates } });
  let matchedOn: "sku" | "upc" | "ean" | "isbn" = "sku";
  if (variant) {
    matchedOn = SCANNABLE_KINDS.find((kind) => {
      const value = variant!.barcodes?.[kind];
      return value !== null && value !== undefined && scanCandidates.includes(value);
    })!;
  } else {
    variant = await ProductVariant.findOne({ organizationId, skuKey: key(text) });
  }

  const product = variant ? await Product.findOne({ _id: variant.productId, organizationId }) : null;
  if (!variant || !product) {
    throw ApiError.coded(404, "PRODUCT_NOT_FOUND", `No product matches '${text}'.`);
  }

  return { product: await buildProductView(organizationId, product, undefined, options), variantId: variant._id, matchedOn };
}

// ==========================================
// Create
// ==========================================

export async function createProduct(organizationId: string, input: CreateProductInput, actorUserId: string) {
  const decimals = await currencyDecimals(organizationId);
  if (input.categoryId) {
    await assertCategoryExists(organizationId, input.categoryId);
  }
  const taxRateId = await resolveTaxRateId(organizationId, input.taxPreference, input.taxRateId);
  const isService = input.type === "service";

  const product = new Product({
    organizationId: new mongoose.Types.ObjectId(organizationId),
    name: input.name,
    type: input.type,
    itemType: input.itemType,
    categoryId: input.categoryId ?? null,
    unit: input.unit,
    brand: input.brand ?? null,
    manufacturer: input.manufacturer ?? null,
    taxPreference: input.taxPreference,
    taxRateId,
    imageUrl: input.imageUrl ?? null,
    dimensions: input.dimensions ?? null,
    weight: input.weight ?? null,
    reportingTags: input.reportingTags ?? [],
    sales: { description: input.sales?.description ?? null },
    purchase: {
      description: input.purchase?.description ?? null,
      preferredVendorName: input.purchase?.preferredVendorName ?? null,
    },
    inventory: {
      trackInventory: isService ? false : (input.inventory?.trackInventory ?? true),
      returnable: input.inventory?.returnable ?? true,
    },
    attributes: input.itemType === "variant" ? input.attributes : [],
    isActive: input.isActive ?? true,
  });

  let candidates: {
    variant: ProductVariantDocument;
    paths: FieldPaths;
    opening?: { lines: NonNullable<VariantInput["openingStock"]>; field: string };
  }[];
  if (input.itemType === "single") {
    const fields: VariantFields = {
      sku: input.sku,
      barcodes: input.barcodes,
      sellingPrice: input.sales?.sellingPrice,
      costPrice: input.purchase?.costPrice,
      reorderPoint: input.inventory?.reorderPoint,
    };
    const lines = input.inventory?.openingStock;
    candidates = [
      {
        variant: newVariant(organizationId, product, fields, decimals, SINGLE_PATHS, { isDefault: true }),
        paths: SINGLE_PATHS,
        opening: lines ? { lines, field: "inventory.openingStock" } : undefined,
      },
    ];
  } else {
    candidates = (input.variants ?? []).map((variantInput, index) => {
      const paths = variantPaths(`variants[${index}].`);
      const { values, comboKey } = canonicalCombination(
        product.attributes,
        variantInput.attributeValues,
        `variants[${index}].attributeValues`
      );
      return {
        variant: newVariant(organizationId, product, variantInput, decimals, paths, { attributeValues: values, comboKey }),
        paths,
        opening: variantInput.openingStock
          ? { lines: variantInput.openingStock, field: `variants[${index}].openingStock` }
          : undefined,
      };
    });
  }

  await assertCodesAvailable(organizationId, candidates);
  const withOpening = candidates.filter((candidate) => candidate.opening);
  const openingLines = await prepareOpeningStock(
    organizationId,
    withOpening.map(({ variant, opening }) => ({
      lines: opening!.lines,
      unit: product.unit,
      defaultCostMinor: variant.costPriceMinor,
      field: opening!.field,
    })),
    decimals
  );

  await inTransaction(async (session) => {
    await product.save({ session });
    for (const { variant } of candidates) {
      await variant.save({ session });
    }
    for (const [index, { variant }] of withOpening.entries()) {
      await recordOpeningStock(session, {
        organizationId,
        productId: product._id,
        variantId: variant._id,
        lines: openingLines[index],
        actorUserId,
      });
    }
  });

  logger.info(`Product created: ${product._id} org=${organizationId} by user=${actorUserId}`);
  return buildProductView(organizationId, product, decimals);
}

// ==========================================
// Update
// ==========================================

/**
 * Replaces a variant item's attribute list. Attributes cannot be added or removed (every variant
 * would need a value for them), and an option a variant uses cannot be dropped. Names keep their
 * original spelling and order, since variants are keyed by them.
 */
async function replaceAttributes(
  organizationId: string,
  product: ProductDocument,
  incoming: IProductAttribute[]
): Promise<IProductAttribute[]> {
  const current = product.attributes;
  const sameNames =
    incoming.length === current.length &&
    current.every((attribute) => incoming.some((candidate) => key(candidate.name) === key(attribute.name)));
  if (!sameNames) {
    throw ApiError.coded(
      409,
      "ATTRIBUTES_LOCKED",
      `Attributes cannot be added or removed. Keep exactly: ${current.map((a) => a.name).join(", ")}.`,
      [{ field: "attributes", code: "ATTRIBUTES_LOCKED" }]
    );
  }

  const variants = await ProductVariant.find({ organizationId, productId: product._id }).select("attributeValues");
  const errors: ApiErrorDetail[] = [];
  const next = current.map((attribute) => {
    const replacement = incoming.find((candidate) => key(candidate.name) === key(attribute.name))!;
    const kept = new Set(replacement.options.map(key));
    const used = new Set(
      variants.map((variant) => variant.attributeValues.get(attribute.name)).filter((v): v is string => Boolean(v))
    );
    for (const option of used) {
      if (!kept.has(key(option))) {
        errors.push({
          field: "attributes",
          code: "ATTRIBUTE_OPTION_IN_USE",
          message: `Option '${option}' of ${attribute.name} is used by a variant and cannot be removed.`,
          meta: { attribute: attribute.name, option },
        });
      }
    }
    return { name: attribute.name, options: replacement.options };
  });

  if (errors.length > 0) {
    throw ApiError.coded(409, "ATTRIBUTE_OPTION_IN_USE", errors[0].message!, errors);
  }
  return next;
}

export async function updateProduct(
  organizationId: string,
  productId: string,
  input: UpdateProductInput,
  actorUserId: string
) {
  const product = await findProductOrThrow(organizationId, productId);
  const decimals = await currencyDecimals(organizationId);
  const isSingle = product.itemType === "single";
  const isService = product.type === "service";

  // Fields of the default variant, which only a single item exposes at the top level.
  const variantFields: VariantFields = {
    sku: input.sku,
    barcodes: input.barcodes,
    sellingPrice: input.sales?.sellingPrice,
    costPrice: input.purchase?.costPrice,
    reorderPoint: input.inventory?.reorderPoint,
  };
  const touchesVariant = Object.values(variantFields).some((value) => value !== undefined);
  if (!isSingle && touchesVariant) {
    throw ApiError.coded(
      400,
      "PRODUCT_IS_VARIANT_ITEM",
      "This is a variant item: set SKU, barcodes, prices and reorder point on each variant instead."
    );
  }
  if (isSingle && input.attributes !== undefined) {
    throw validationError("attributes", "Only variant items have attributes.");
  }
  if (isService) {
    if (input.brand) throw validationError("brand", "Services have no brand.");
    if (input.manufacturer) throw validationError("manufacturer", "Services have no manufacturer.");
    if (input.inventory?.trackInventory) throw validationError("inventory.trackInventory", "Services cannot track inventory.");
    if (input.inventory?.reorderPoint !== undefined && input.inventory.reorderPoint !== null) {
      throw validationError("inventory.reorderPoint", "Services have no stock to reorder.");
    }
  }

  if (input.categoryId) {
    await assertCategoryExists(organizationId, input.categoryId);
  }

  // Tax: a non-standard product never carries a rate; becoming standard (or clearing the rate)
  // falls back to the organization's default.
  const taxPreference = input.taxPreference ?? product.taxPreference;
  let taxRateId = product.taxRateId;
  if (taxPreference !== "standard") {
    if (input.taxRateId) {
      throw validationError("taxRateId", `A ${taxPreference} product must not have a tax rate.`);
    }
    taxRateId = null;
  } else if (input.taxRateId !== undefined || product.taxPreference !== "standard" || !product.taxRateId) {
    taxRateId = await resolveTaxRateId(organizationId, "standard", input.taxRateId);
  }

  // Stored stock quantities are in the product's unit, so the unit is fixed once stock has moved,
  // and tracking cannot be switched off while stock is on hand.
  const productVariantIds = async () =>
    (await ProductVariant.find({ organizationId, productId: product._id, isDelete: { $in: [true, false] } }).select("_id")).map(
      (variant) => variant._id
    );
  if (input.unit !== undefined && input.unit !== product.unit && (await hasStockMovements(organizationId, await productVariantIds()))) {
    throw ApiError.coded(
      409,
      "UNIT_LOCKED",
      `The unit cannot change once stock has moved (it is '${product.unit}'); create a new product instead.`,
      [{ field: "unit", code: "UNIT_LOCKED" }]
    );
  }
  if (
    input.inventory?.trackInventory === false &&
    product.inventory.trackInventory &&
    (await hasStockOnHand(organizationId, await productVariantIds()))
  ) {
    throw ApiError.coded(
      409,
      "STOCK_ON_HAND",
      "Inventory tracking cannot be turned off while a store holds stock of this product. Adjust it to zero, or transfer it out of a deactivated store, first.",
      [{ field: "inventory.trackInventory", code: "STOCK_ON_HAND" }]
    );
  }

  // A unit that only allows whole quantities must fit every existing reorder point.
  const unit = input.unit ?? product.unit;
  if (input.unit !== undefined && !unitAllowsDecimal(unit)) {
    // A single item's reorder point sent in this same request replaces the stored one (and is
    // checked against the new unit when applied).
    const replacesDefault = isSingle && variantFields.reorderPoint !== undefined;
    const withPoint = await ProductVariant.find({
      organizationId,
      productId: product._id,
      reorderPoint: { $ne: null },
    }).select("reorderPoint isDefault");
    const fractional = withPoint.some(
      (variant) => !Number.isInteger(variant.reorderPoint) && !(replacesDefault && variant.isDefault)
    );
    if (fractional) {
      throw validationError("unit", `Unit '${unit}' only allows whole quantities, and a variant has a fractional reorder point.`);
    }
  }

  const attributes =
    input.attributes !== undefined ? await replaceAttributes(organizationId, product, input.attributes) : undefined;

  // ---- Apply product fields ----
  const set = <T>(path: string, value: T | undefined) => {
    if (value !== undefined) product.set(path, value);
  };
  set("name", input.name);
  set("categoryId", input.categoryId);
  set("unit", input.unit);
  set("brand", input.brand);
  set("manufacturer", input.manufacturer);
  set("imageUrl", input.imageUrl);
  set("dimensions", input.dimensions);
  set("weight", input.weight);
  set("reportingTags", input.reportingTags);
  set("isActive", input.isActive);
  set("sales.description", input.sales?.description);
  set("purchase.description", input.purchase?.description);
  set("purchase.preferredVendorName", input.purchase?.preferredVendorName);
  set("inventory.returnable", input.inventory?.returnable);
  if (!isService) set("inventory.trackInventory", input.inventory?.trackInventory);
  set("attributes", attributes);
  product.taxPreference = taxPreference;
  product.taxRateId = taxRateId;

  // ---- Apply default-variant fields (single items) ----
  let defaultVariant: ProductVariantDocument | null = null;
  let priceChange: PriceChange | null = null;
  if (isSingle && touchesVariant) {
    defaultVariant = await findDefaultVariant(organizationId, product);
    const applied = applyVariantFields(defaultVariant, variantFields, decimals, SINGLE_PATHS, unit);
    priceChange = applied.priceChange;
    if (applied.codesChanged) {
      await assertCodesAvailable(organizationId, [{ variant: defaultVariant, paths: SINGLE_PATHS }], [defaultVariant._id]);
    }
  }

  await inTransaction(async (session) => {
    await product.save({ session });
    if (defaultVariant) await defaultVariant.save({ session });
  });

  if (priceChange) {
    await auditPriceChanges(organizationId, product._id, [priceChange], decimals, actorUserId);
  }
  logger.info(`Product updated: ${productId} org=${organizationId} by user=${actorUserId}`);
  return buildProductView(organizationId, product, decimals);
}

/** Activates or deactivates a product. Idempotent. */
export async function setProductActive(
  organizationId: string,
  productId: string,
  isActive: boolean,
  actorUserId: string
) {
  const product = await findProductOrThrow(organizationId, productId);
  if (product.isActive !== isActive) {
    product.isActive = isActive;
    await product.save();
    logger.info(
      `Product ${isActive ? "activated" : "deactivated"}: ${productId} org=${organizationId} by user=${actorUserId}`
    );
  }
  return buildProductView(organizationId, product);
}

/**
 * Soft-deletes a product and its variants, releasing their SKUs and barcodes. A product whose
 * variants have stock history is refused (PRODUCT_IN_USE): deactivate it instead.
 */
export async function deleteProduct(organizationId: string, productId: string, actorUserId: string) {
  const product = await findProductOrThrow(organizationId, productId);
  const variantIds = (
    await ProductVariant.find({ organizationId, productId: product._id, isDelete: { $in: [true, false] } }).select("_id")
  ).map((variant) => variant._id);
  if (await hasStockMovements(organizationId, variantIds)) {
    throw ApiError.coded(409, "PRODUCT_IN_USE", "This product has stock history and can only be deactivated.");
  }

  await inTransaction(async (session) => {
    product.isDelete = true;
    await product.save({ session });
    await ProductVariant.updateMany(
      { organizationId, productId: product._id },
      { $set: { isDelete: true } },
      { session }
    );
  });

  logger.info(`Product deleted: ${productId} org=${organizationId} by user=${actorUserId}`);
}

// ==========================================
// Variants
// ==========================================

async function findVariantItemOrThrow(organizationId: string, productId: string) {
  const product = await findProductOrThrow(organizationId, productId);
  if (product.itemType !== "variant") {
    throw notVariantItem();
  }
  return product;
}

/** Adds a variant to a variant item, using the product's existing attribute options. */
export async function addVariant(organizationId: string, productId: string, input: VariantInput, actorUserId: string) {
  const product = await findVariantItemOrThrow(organizationId, productId);
  if (input.openingStock && !product.inventory.trackInventory) {
    throw validationError("openingStock", "Opening stock needs a goods item that tracks inventory.");
  }
  const decimals = await currencyDecimals(organizationId);
  const paths = variantPaths("");

  const { values, comboKey } = canonicalCombination(product.attributes, input.attributeValues, "attributeValues");
  if (await ProductVariant.exists({ organizationId, productId: product._id, comboKey })) {
    const description = [...values].map(([name, value]) => `${name}: ${value}`).join(", ");
    throw ApiError.coded(409, "VARIANT_COMBINATION_TAKEN", `A variant with ${description} already exists.`, [
      { field: "attributeValues", code: "VARIANT_COMBINATION_TAKEN" },
    ]);
  }

  const variant = newVariant(organizationId, product, input, decimals, paths, { attributeValues: values, comboKey });
  await assertCodesAvailable(organizationId, [{ variant, paths }]);
  let openingLines: PreparedOpeningLine[] = [];
  if (input.openingStock) {
    [openingLines] = await prepareOpeningStock(
      organizationId,
      [{ lines: input.openingStock, unit: product.unit, defaultCostMinor: variant.costPriceMinor, field: "openingStock" }],
      decimals
    );
  }

  await inTransaction(async (session) => {
    await variant.save({ session });
    if (openingLines.length > 0) {
      await recordOpeningStock(session, { organizationId, productId: product._id, variantId: variant._id, lines: openingLines, actorUserId });
    }
  });

  logger.info(`Variant added: ${variant._id} product=${productId} org=${organizationId} by user=${actorUserId}`);
  return buildProductView(organizationId, product, decimals);
}

/** Updates a variant's SKU, barcodes, prices or reorder point (any product, incl. the default variant). */
export async function updateVariant(
  organizationId: string,
  productId: string,
  variantId: string,
  input: UpdateVariantInput,
  actorUserId: string
) {
  const product = await findProductOrThrow(organizationId, productId);
  const variant = await findVariantOrThrow(organizationId, productId, variantId);
  const decimals = await currencyDecimals(organizationId);
  const paths = variantPaths("");

  if (product.type === "service" && input.reorderPoint !== undefined && input.reorderPoint !== null) {
    throw validationError("reorderPoint", "Services have no stock to reorder.");
  }

  const { priceChange, codesChanged } = applyVariantFields(variant, input, decimals, paths, product.unit);
  if (codesChanged) {
    await assertCodesAvailable(organizationId, [{ variant, paths }], [variant._id]);
  }

  try {
    await variant.save();
  } catch (error) {
    throw mapDuplicateKey(error);
  }

  if (priceChange) {
    await auditPriceChanges(organizationId, product._id, [priceChange], decimals, actorUserId);
  }
  logger.info(`Variant updated: ${variantId} product=${productId} org=${organizationId} by user=${actorUserId}`);
  return buildProductView(organizationId, product, decimals);
}

async function otherActiveVariants(organizationId: string, product: ProductDocument, variantId: mongoose.Types.ObjectId) {
  return ProductVariant.countDocuments({
    organizationId,
    productId: product._id,
    isActive: true,
    _id: { $ne: variantId },
  });
}

/** Activates or deactivates a variant of a variant item. Idempotent; the last active one stays. */
export async function setVariantActive(
  organizationId: string,
  productId: string,
  variantId: string,
  isActive: boolean,
  actorUserId: string
) {
  const product = await findVariantItemOrThrow(organizationId, productId);
  const variant = await findVariantOrThrow(organizationId, productId, variantId);

  if (variant.isActive !== isActive) {
    if (!isActive && (await otherActiveVariants(organizationId, product, variant._id)) === 0) {
      throw lastActiveVariant();
    }
    variant.isActive = isActive;
    await variant.save();
    logger.info(
      `Variant ${isActive ? "activated" : "deactivated"}: ${variantId} product=${productId} org=${organizationId} by user=${actorUserId}`
    );
  }
  return buildProductView(organizationId, product);
}

/**
 * Soft-deletes a variant of a variant item, releasing its SKU and barcodes. The last active
 * variant cannot be deleted, nor can one with stock history (VARIANT_IN_USE): deactivate it.
 */
export async function deleteVariant(organizationId: string, productId: string, variantId: string, actorUserId: string) {
  const product = await findVariantItemOrThrow(organizationId, productId);
  const variant = await findVariantOrThrow(organizationId, productId, variantId);
  if (await hasStockMovements(organizationId, [variant._id])) {
    throw ApiError.coded(409, "VARIANT_IN_USE", "This variant has stock history and can only be deactivated.");
  }

  if (variant.isActive && (await otherActiveVariants(organizationId, product, variant._id)) === 0) {
    throw lastActiveVariant();
  }

  variant.isDelete = true;
  await variant.save();

  logger.info(`Variant deleted: ${variantId} product=${productId} org=${organizationId} by user=${actorUserId}`);
  return buildProductView(organizationId, product);
}
