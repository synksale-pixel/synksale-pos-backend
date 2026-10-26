/**
 * Purpose: Stock Service.
 * Stock per store: levels, the movement ledger, adjustments (including set-to-counted), one-step
 * transfers between stores, opening stock for new products and variants, and the stock checks
 * the catalog needs (in-use, unit lock, stock on hand).
 *
 * Every change goes through stockLedger.applyMovement inside a transaction. Validation that only
 * needs the request and the catalog (unknown variants, untracked products, units, store
 * references) runs before any write; checks that depend on the stock itself (negative stock)
 * run inside the transaction, against the levels read there.
 *
 * Quantities are stored in thousandths and money in minor units; the API uses numbers and decimal
 * strings (see utils/quantity.ts and utils/money.ts).
 */

import mongoose from "mongoose";
import { Product, ProductDocument } from "../models/product.model";
import { ProductVariant, ProductVariantDocument, variantDisplayName } from "../models/productVariant.model";
import { Store } from "../models/store.model";
import { User, IUser } from "../models/user.model";
import { Organization } from "../models/organization.model";
import { StockLevel } from "../models/stockLevel.model";
import { StockMovement, StockMovementDocument } from "../models/stockMovement.model";
import { StockAdjustment, StockAdjustmentDocument, IStockAdjustmentLine } from "../models/stockAdjustment.model";
import { StockTransfer, StockTransferDocument, IStockTransferLine } from "../models/stockTransfer.model";
import { ApiError, ApiErrorDetail } from "../utils/ApiError";
import { formatMoney, parseMoney } from "../utils/money";
import { fromMilli, toMilli } from "../utils/quantity";
import { createdAtRange } from "../utils/dateRange";
import { resolvePaging, buildPaginationMeta } from "../utils/pagination";
import { logger } from "../config/logger.config";
import { getCurrency } from "../config/currencies.config";
import { unitAllowsDecimal } from "../config/units.config";
import { categoryRefs, categoryWithDescendants } from "./category.service";
import { hasOrganizationScopeRole, storesWithPermission } from "./permission.service";
import { applyMovement, readLevel, LevelState } from "./stockLedger.service";
import {
  REASON_RULES,
  MOVEMENT_TYPES,
  MovementType,
  CreateStockAdjustmentInput,
  CreateStockTransferInput,
} from "../validators/stock.validator";

type ObjectId = mongoose.Types.ObjectId;
const oid = (id: string | ObjectId) => new mongoose.Types.ObjectId(String(id));

// ==========================================
// Organization settings
// ==========================================

interface StockSettings {
  decimals: number;
  allowNegativeStock: boolean;
  timezone: string;
}

async function stockSettings(organizationId: string): Promise<StockSettings> {
  const organization = await Organization.findById(organizationId).select("settings");
  if (!organization) {
    throw ApiError.coded(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
  }
  return {
    decimals: getCurrency(organization.settings.currency).decimals,
    allowNegativeStock: organization.settings.inventory?.allowNegativeStock ?? false,
    timezone: organization.settings.timezone || "UTC",
  };
}

// ==========================================
// Errors
// ==========================================

function validationError(field: string, message: string): ApiError {
  return ApiError.coded(400, "VALIDATION_FAILED", `Request Validation Failed: ${field}: ${message}`, [
    { field, code: "VALIDATION_FAILED", message },
  ]);
}

/** One 400 for every line problem found, coded after the first. */
function lineErrors(errors: ApiErrorDetail[]): ApiError {
  return ApiError.coded(400, errors[0].code!, errors[0].message!, errors);
}

function insufficientStock(errors: ApiErrorDetail[]): ApiError {
  return ApiError.coded(409, "INSUFFICIENT_STOCK", errors[0].message!, errors);
}

// ==========================================
// References for responses
// ==========================================

type StoreRef = { id: ObjectId; name: string; code: string };
type UserRef = { id: ObjectId; name: string } | null;

async function storeRefs(organizationId: string, storeIds: ObjectId[]): Promise<Map<string, StoreRef>> {
  if (storeIds.length === 0) return new Map();
  // Deleted stores still name their history.
  const stores = await Store.find({ organizationId, _id: { $in: storeIds }, isDelete: { $in: [true, false] } }).select(
    "name code"
  );
  return new Map(stores.map((store) => [store._id.toString(), { id: store._id, name: store.name, code: store.code }]));
}

async function userRefs(organizationId: string, userIds: (ObjectId | null)[]): Promise<Map<string, UserRef>> {
  const ids = userIds.filter((id): id is ObjectId => Boolean(id));
  if (ids.length === 0) return new Map();
  const users = await User.find({ organizationId, _id: { $in: ids }, isDelete: { $in: [true, false] } }).select(
    "firstName lastName"
  );
  return new Map(
    users.map((user) => [user._id.toString(), { id: user._id, name: `${user.firstName} ${user.lastName}`.trim() }])
  );
}

interface CatalogRefs {
  variant(id: ObjectId): { id: ObjectId; name: string; sku: string | null };
  product(id: ObjectId): { id: ObjectId; name: string; unit: string };
}

/** Variant and product names for history rows, including deleted ones. */
async function catalogRefs(organizationId: string, variantIds: ObjectId[], productIds: ObjectId[]): Promise<CatalogRefs> {
  const anyState = { $in: [true, false] };
  const [variants, products] = await Promise.all([
    variantIds.length
      ? ProductVariant.find({ organizationId, _id: { $in: variantIds }, isDelete: anyState }).select("productId attributeValues sku")
      : [],
    productIds.length
      ? Product.find({ organizationId, _id: { $in: productIds }, isDelete: anyState }).select("name unit attributes")
      : [],
  ]);
  const productById = new Map(products.map((product) => [product._id.toString(), product]));
  const variantById = new Map(variants.map((variant) => [variant._id.toString(), variant]));
  return {
    variant(id) {
      const variant = variantById.get(id.toString());
      const product = variant ? productById.get(variant.productId.toString()) : undefined;
      return {
        id,
        name: product && variant ? variantDisplayName(product, variant.attributeValues) : "(unknown)",
        sku: variant?.sku ?? null,
      };
    },
    product(id) {
      const product = productById.get(id.toString());
      return { id, name: product?.name ?? "(unknown)", unit: product?.unit ?? "pcs" };
    },
  };
}

// ==========================================
// Line validation (before any write)
// ==========================================

interface StockedVariant {
  variant: ProductVariantDocument;
  product: ProductDocument;
}

/**
 * Resolves each line's variant and refuses unknown or deleted variants (VARIANT_NOT_FOUND) and
 * variants whose product does not track inventory (VARIANT_NOT_STOCKED). Inactive ones are fine.
 */
async function loadStockedVariants(organizationId: string, variantIds: string[]): Promise<StockedVariant[]> {
  const variants = await ProductVariant.find({ organizationId, _id: { $in: variantIds.map(oid) } });
  const products = await Product.find({ organizationId, _id: { $in: variants.map((variant) => variant.productId) } });
  const variantById = new Map(variants.map((variant) => [variant._id.toString(), variant]));
  const productById = new Map(products.map((product) => [product._id.toString(), product]));

  const errors: ApiErrorDetail[] = [];
  const resolved = variantIds.map((variantId, index) => {
    const variant = variantById.get(variantId.toLowerCase());
    const product = variant ? productById.get(variant.productId.toString()) : undefined;
    const field = `lines[${index}].variantId`;
    if (!variant || !product) {
      errors.push({ field, code: "VARIANT_NOT_FOUND", message: `Variant '${variantId}' not found.` });
      return null;
    }
    if (product.type !== "goods" || !product.inventory.trackInventory) {
      errors.push({
        field,
        code: "VARIANT_NOT_STOCKED",
        message: `'${variantDisplayName(product, variant.attributeValues)}' does not track inventory.`,
      });
      return null;
    }
    return { variant, product };
  });
  if (errors.length > 0) throw lineErrors(errors);
  return resolved as StockedVariant[];
}

function assertWholeIfNeeded(quantity: number | undefined, unit: string, field: string) {
  if (quantity !== undefined && !unitAllowsDecimal(unit) && !Number.isInteger(quantity)) {
    throw validationError(field, `Unit '${unit}' only allows whole quantities.`);
  }
}

/**
 * The stores a body refers to must be stores of the organization, and active unless the ref
 * allows otherwise (a transfer may empty a deactivated store, e.g. when a branch closes).
 */
async function assertActiveStores(organizationId: string, refs: { storeId: string; field: string; allowInactive?: boolean }[]) {
  const ids = [...new Set(refs.map((ref) => ref.storeId.toLowerCase()))];
  const stores = await Store.find({ organizationId, _id: { $in: ids.map(oid) } }).select("isActive");
  const byId = new Map(stores.map((store) => [store._id.toString(), store]));
  for (const ref of refs) {
    const store = byId.get(ref.storeId.toLowerCase());
    if (!store) {
      throw ApiError.coded(400, "STORE_NOT_FOUND", "Store not found.", [{ field: ref.field, code: "STORE_NOT_FOUND" }]);
    }
    if (!store.isActive && !ref.allowInactive) {
      throw ApiError.coded(400, "STORE_INACTIVE", "This store is deactivated.", [{ field: ref.field, code: "STORE_INACTIVE" }]);
    }
  }
}

const insufficientDetail = (index: number, stocked: StockedVariant, availableMilli: number, requestedMilli: number) => {
  const name = variantDisplayName(stocked.product, stocked.variant.attributeValues);
  const available = fromMilli(availableMilli);
  const requested = fromMilli(requestedMilli);
  return {
    field: `lines[${index}]`,
    code: "INSUFFICIENT_STOCK",
    message: `Not enough stock for '${name}': ${available} available, ${requested} requested.`,
    meta: { variantId: stocked.variant._id.toString(), available, requested },
  };
};

// ==========================================
// Adjustments
// ==========================================

/** Costs in an adjustment are the store's average cost: shown only with inventory:read. */
const costOrNull = (minor: number, decimals: number, showCost: boolean) => (showCost ? formatMoney(minor, decimals) : null);

function toAdjustmentLineView(line: IStockAdjustmentLine, refs: CatalogRefs, decimals: number, showCost: boolean) {
  return {
    variant: refs.variant(line.variantId),
    product: refs.product(line.productId),
    mode: line.mode,
    countedQuantity: line.countedQuantityMilli === null ? null : fromMilli(line.countedQuantityMilli),
    quantityBefore: fromMilli(line.quantityBeforeMilli),
    quantityChange: fromMilli(line.quantityChangeMilli),
    quantityAfter: fromMilli(line.quantityAfterMilli),
    unitCost: costOrNull(line.unitCostMinor, decimals, showCost),
    valueChange: costOrNull(line.valueChangeMinor, decimals, showCost),
  };
}

async function toAdjustmentViews(
  organizationId: string,
  adjustments: StockAdjustmentDocument[],
  decimals: number,
  withLines: boolean,
  showCost = true
) {
  const lines = adjustments.flatMap((adjustment) => adjustment.lines);
  const [stores, users, refs] = await Promise.all([
    storeRefs(organizationId, [...new Set(adjustments.map((a) => a.storeId.toString()))].map(oid)),
    userRefs(organizationId, adjustments.map((a) => a.createdBy)),
    withLines
      ? catalogRefs(organizationId, lines.map((line) => line.variantId), lines.map((line) => line.productId))
      : null,
  ]);
  return adjustments.map((adjustment) => ({
    id: adjustment._id,
    store: stores.get(adjustment.storeId.toString()) ?? null,
    reason: adjustment.reason,
    note: adjustment.note ?? null,
    valueChange: costOrNull(adjustment.valueChangeMinor, decimals, showCost),
    createdBy: users.get(adjustment.createdBy.toString()) ?? null,
    createdAt: adjustment.createdAt,
    ...(withLines
      ? { lines: adjustment.lines.map((line) => toAdjustmentLineView(line, refs!, decimals, showCost)) }
      : { lineCount: adjustment.lines.length }),
  }));
}

/**
 * Records an adjustment in one store. Runs inside the caller's transaction (see
 * idempotency.service): every line is applied, or none is. `showCost` is false for a caller
 * without inventory:read, whose response must not reveal the store's average cost.
 */
export async function createAdjustment(
  organizationId: string,
  storeId: string,
  input: CreateStockAdjustmentInput,
  actorUserId: string,
  session: mongoose.ClientSession,
  showCost = true
) {
  const settings = await stockSettings(organizationId);
  const stocked = await loadStockedVariants(organizationId, input.lines.map((line) => line.variantId));
  const unitCosts = input.lines.map((line, index) => {
    const unit = stocked[index].product.unit;
    assertWholeIfNeeded(line.quantityChange, unit, `lines[${index}].quantityChange`);
    assertWholeIfNeeded(line.countedQuantity, unit, `lines[${index}].countedQuantity`);
    return line.unitCost === undefined ? undefined : parseMoney(line.unitCost, settings.decimals, `lines[${index}].unitCost`);
  });

  const orgId = oid(organizationId);
  const store = oid(storeId);
  const adjustmentId = new mongoose.Types.ObjectId();
  const at = new Date();
  const rule = REASON_RULES[input.reason];
  const type: MovementType = input.reason === "opening_balance" ? "opening" : "adjustment";

  // Pass 1: read every level and work out each change; refuse before writing anything.
  const plans: { before: LevelState; changeMilli: number }[] = [];
  const shortfalls: ApiErrorDetail[] = [];
  for (const [index, line] of input.lines.entries()) {
    const before = await readLevel(session, orgId, store, stocked[index].variant._id);
    const changeMilli =
      line.countedQuantity !== undefined ? toMilli(line.countedQuantity) - before.quantityMilli : toMilli(line.quantityChange!);
    if (line.countedQuantity !== undefined && rule.direction === "add" && changeMilli < 0) {
      throw validationError(
        `lines[${index}].countedQuantity`,
        `Reason ${input.reason} only adds stock, and the count is below the current stock (${fromMilli(before.quantityMilli)}).`
      );
    }
    if (!settings.allowNegativeStock && changeMilli < 0 && before.quantityMilli + changeMilli < 0) {
      shortfalls.push(insufficientDetail(index, stocked[index], before.quantityMilli, -changeMilli));
    }
    plans.push({ before, changeMilli });
  }
  if (shortfalls.length > 0) throw insufficientStock(shortfalls);

  // Pass 2: write the movements.
  const lines: IStockAdjustmentLine[] = [];
  for (const [index, line] of input.lines.entries()) {
    const { variant, product } = stocked[index];
    const { before, changeMilli } = plans[index];
    const fallbackCost = before.avgCostMinor ?? variant.costPriceMinor ?? 0;
    const base = {
      variantId: variant._id,
      productId: product._id,
      mode: line.countedQuantity !== undefined ? ("count" as const) : ("change" as const),
      countedQuantityMilli: line.countedQuantity !== undefined ? toMilli(line.countedQuantity) : null,
      quantityBeforeMilli: before.quantityMilli,
    };

    if (changeMilli === 0) {
      lines.push({ ...base, quantityChangeMilli: 0, quantityAfterMilli: before.quantityMilli, unitCostMinor: fallbackCost, valueChangeMinor: 0 });
      continue;
    }
    const applied = await applyMovement(session, {
      organizationId: orgId,
      storeId: store,
      variantId: variant._id,
      productId: product._id,
      type,
      before,
      quantityMilli: changeMilli,
      unitCostMinor: changeMilli > 0 ? (unitCosts[index] ?? fallbackCost) : undefined,
      source: { type: "adjustment", id: adjustmentId, number: null },
      reason: input.reason,
      note: input.note ?? null,
      createdBy: oid(actorUserId),
      at,
    });
    lines.push({
      ...base,
      quantityChangeMilli: changeMilli,
      quantityAfterMilli: applied.after.quantityMilli,
      unitCostMinor: applied.unitCostMinor,
      valueChangeMinor: applied.valueChangeMinor,
    });
  }

  const [adjustment] = await StockAdjustment.create(
    [
      {
        _id: adjustmentId,
        organizationId: orgId,
        storeId: store,
        reason: input.reason,
        note: input.note ?? null,
        lines,
        valueChangeMinor: lines.reduce((total, line) => total + line.valueChangeMinor, 0),
        createdBy: oid(actorUserId),
        createdAt: at,
      },
    ],
    { session }
  );

  logger.info(`Stock adjusted: ${adjustmentId} store=${storeId} org=${organizationId} by user=${actorUserId}`);
  const [view] = await toAdjustmentViews(organizationId, [adjustment], settings.decimals, true, showCost);
  return view;
}

export interface ListQuery {
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export async function listAdjustments(organizationId: string, storeId: string, query: ListQuery & { reason?: string }) {
  const settings = await stockSettings(organizationId);
  const { page, limit, skip } = resolvePaging(query);
  const filter: Record<string, unknown> = { organizationId, storeId };
  const range = createdAtRange(query.from, query.to, settings.timezone);
  if (range) filter.createdAt = range;
  if (query.reason && Object.hasOwn(REASON_RULES, query.reason)) filter.reason = query.reason;

  const [total, adjustments] = await Promise.all([
    StockAdjustment.countDocuments(filter),
    StockAdjustment.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
  ]);
  return {
    adjustments: await toAdjustmentViews(organizationId, adjustments, settings.decimals, false),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

export async function getAdjustment(organizationId: string, storeId: string, adjustmentId: string) {
  const adjustment = await StockAdjustment.findOne({ _id: adjustmentId, organizationId, storeId });
  if (!adjustment) {
    throw ApiError.coded(404, "ADJUSTMENT_NOT_FOUND", "Stock adjustment not found.");
  }
  const settings = await stockSettings(organizationId);
  const [view] = await toAdjustmentViews(organizationId, [adjustment], settings.decimals, true);
  return view;
}

// ==========================================
// Transfers
// ==========================================

function toTransferLineView(line: IStockTransferLine, refs: CatalogRefs, decimals: number) {
  return {
    variant: refs.variant(line.variantId),
    product: refs.product(line.productId),
    quantity: fromMilli(line.quantityMilli),
    unitCost: formatMoney(line.unitCostMinor, decimals),
    fromQuantityAfter: fromMilli(line.fromQuantityAfterMilli),
    toQuantityAfter: fromMilli(line.toQuantityAfterMilli),
  };
}

async function toTransferViews(organizationId: string, transfers: StockTransferDocument[], decimals: number, withLines: boolean) {
  const lines = transfers.flatMap((transfer) => transfer.lines);
  const storeIds = [...new Set(transfers.flatMap((t) => [t.fromStoreId.toString(), t.toStoreId.toString()]))].map(oid);
  const [stores, users, refs] = await Promise.all([
    storeRefs(organizationId, storeIds),
    userRefs(organizationId, transfers.map((t) => t.createdBy)),
    withLines
      ? catalogRefs(organizationId, lines.map((line) => line.variantId), lines.map((line) => line.productId))
      : null,
  ]);
  return transfers.map((transfer) => ({
    id: transfer._id,
    fromStore: stores.get(transfer.fromStoreId.toString()) ?? null,
    toStore: stores.get(transfer.toStoreId.toString()) ?? null,
    note: transfer.note ?? null,
    totalValue: formatMoney(transfer.totalValueMinor, decimals),
    createdBy: users.get(transfer.createdBy.toString()) ?? null,
    createdAt: transfer.createdAt,
    ...(withLines
      ? { lines: transfer.lines.map((line) => toTransferLineView(line, refs!, decimals)) }
      : { lineCount: transfer.lines.length }),
  }));
}

/**
 * Moves stock between two stores in one step. The source must hold enough of every line, even
 * when the organization allows negative stock. The source may be deactivated (emptying a closed
 * branch); the destination must be active. Runs inside the caller's transaction.
 */
export async function createTransfer(
  organizationId: string,
  input: CreateStockTransferInput,
  actorUserId: string,
  session: mongoose.ClientSession
) {
  const settings = await stockSettings(organizationId);
  await assertActiveStores(organizationId, [
    { storeId: input.fromStoreId, field: "fromStoreId", allowInactive: true },
    { storeId: input.toStoreId, field: "toStoreId" },
  ]);
  const stocked = await loadStockedVariants(organizationId, input.lines.map((line) => line.variantId));
  input.lines.forEach((line, index) => assertWholeIfNeeded(line.quantity, stocked[index].product.unit, `lines[${index}].quantity`));

  const orgId = oid(organizationId);
  const from = oid(input.fromStoreId);
  const to = oid(input.toStoreId);
  const transferId = new mongoose.Types.ObjectId();
  const at = new Date();
  const source = { type: "transfer" as const, id: transferId, number: null };
  const createdBy = oid(actorUserId);

  const sourceLevels: LevelState[] = [];
  const shortfalls: ApiErrorDetail[] = [];
  for (const [index, line] of input.lines.entries()) {
    const before = await readLevel(session, orgId, from, stocked[index].variant._id);
    const quantityMilli = toMilli(line.quantity);
    if (before.quantityMilli < quantityMilli) {
      shortfalls.push(insufficientDetail(index, stocked[index], Math.max(0, before.quantityMilli), quantityMilli));
    }
    sourceLevels.push(before);
  }
  if (shortfalls.length > 0) throw insufficientStock(shortfalls);

  const lines: IStockTransferLine[] = [];
  for (const [index, line] of input.lines.entries()) {
    const { variant, product } = stocked[index];
    const quantityMilli = toMilli(line.quantity);
    const common = { organizationId: orgId, variantId: variant._id, productId: product._id, source, note: input.note ?? null, createdBy, at };

    const out = await applyMovement(session, { ...common, storeId: from, type: "transfer_out", before: sourceLevels[index], quantityMilli: -quantityMilli });
    const destinationBefore = await readLevel(session, orgId, to, variant._id);
    const arrived = await applyMovement(session, {
      ...common,
      storeId: to,
      type: "transfer_in",
      before: destinationBefore,
      quantityMilli,
      unitCostMinor: out.unitCostMinor,
      totalValueMinor: -out.valueChangeMinor,
    });
    lines.push({
      variantId: variant._id,
      productId: product._id,
      quantityMilli,
      unitCostMinor: out.unitCostMinor,
      valueMinor: -out.valueChangeMinor,
      fromQuantityAfterMilli: out.after.quantityMilli,
      toQuantityAfterMilli: arrived.after.quantityMilli,
    });
  }

  const [transfer] = await StockTransfer.create(
    [
      {
        _id: transferId,
        organizationId: orgId,
        fromStoreId: from,
        toStoreId: to,
        note: input.note ?? null,
        lines,
        totalValueMinor: lines.reduce((total, line) => total + line.valueMinor, 0),
        createdBy,
        createdAt: at,
      },
    ],
    { session }
  );

  logger.info(`Stock transferred: ${transferId} ${input.fromStoreId} -> ${input.toStoreId} org=${organizationId} by user=${actorUserId}`);
  const [view] = await toTransferViews(organizationId, [transfer], settings.decimals, true);
  return view;
}

/** Transfers into or out of the stores where the caller holds inventory:read (all for an org role). */
async function transferVisibility(user: IUser): Promise<Record<string, unknown> | null> {
  const stores = await storesWithPermission(user, "inventory:read");
  if (stores === "all") return null;
  const ids = [...stores].map(oid);
  return { $or: [{ fromStoreId: { $in: ids } }, { toStoreId: { $in: ids } }] };
}

export async function listTransfers(organizationId: string, user: IUser, query: ListQuery & { storeId?: string }) {
  const settings = await stockSettings(organizationId);
  const { page, limit, skip } = resolvePaging(query);
  const conditions: Record<string, unknown>[] = [{ organizationId }];
  const visibility = await transferVisibility(user);
  if (visibility) conditions.push(visibility);
  if (query.storeId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(query.storeId)) {
      return { transfers: [], pagination: buildPaginationMeta(page, limit, 0) };
    }
    const storeId = oid(query.storeId);
    conditions.push({ $or: [{ fromStoreId: storeId }, { toStoreId: storeId }] });
  }
  const range = createdAtRange(query.from, query.to, settings.timezone);
  if (range) conditions.push({ createdAt: range });
  const filter = { $and: conditions };

  const [total, transfers] = await Promise.all([
    StockTransfer.countDocuments(filter),
    StockTransfer.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
  ]);
  return {
    transfers: await toTransferViews(organizationId, transfers, settings.decimals, false),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

/** A transfer the caller may not see looks exactly like one that does not exist, so ids cannot be probed. */
export async function getTransfer(organizationId: string, user: IUser, transferId: string) {
  const transfer = await StockTransfer.findOne({ _id: transferId, organizationId });
  const stores = await storesWithPermission(user, "inventory:read");
  const visible =
    transfer &&
    (stores === "all" || stores.has(transfer.fromStoreId.toString()) || stores.has(transfer.toStoreId.toString()));
  if (!transfer || !visible) {
    throw ApiError.coded(404, "TRANSFER_NOT_FOUND", "Stock transfer not found.");
  }
  const settings = await stockSettings(organizationId);
  const [view] = await toTransferViews(organizationId, [transfer], settings.decimals, true);
  return view;
}

// ==========================================
// Movements (the ledger)
// ==========================================

function toMovementView(movement: StockMovementDocument, stores: Map<string, StoreRef>, users: Map<string, UserRef>, refs: CatalogRefs, decimals: number) {
  return {
    id: movement._id,
    store: stores.get(movement.storeId.toString()) ?? null,
    variant: refs.variant(movement.variantId),
    product: refs.product(movement.productId),
    type: movement.type,
    quantityChange: fromMilli(movement.quantityMilli),
    quantityAfter: fromMilli(movement.quantityAfterMilli),
    unitCost: formatMoney(movement.unitCostMinor, decimals),
    valueChange: formatMoney(movement.valueChangeMinor, decimals),
    source: { type: movement.source.type, id: movement.source.id, number: movement.source.number ?? null },
    reason: movement.reason ?? null,
    note: movement.note ?? null,
    createdBy: movement.createdBy ? (users.get(movement.createdBy.toString()) ?? null) : null,
    createdAt: movement.createdAt,
  };
}

export async function listMovements(
  organizationId: string,
  storeId: string,
  query: ListQuery & { productId?: string; variantId?: string; type?: string }
) {
  const settings = await stockSettings(organizationId);
  const { page, limit, skip } = resolvePaging(query);
  const empty = { movements: [], pagination: buildPaginationMeta(page, limit, 0) };
  const filter: Record<string, unknown> = { organizationId, storeId };

  for (const field of ["productId", "variantId"] as const) {
    const value = query[field];
    if (value === undefined) continue;
    if (!mongoose.Types.ObjectId.isValid(value)) return empty; // a malformed id matches nothing
    filter[field] = oid(value);
  }
  if (query.type && (MOVEMENT_TYPES as readonly string[]).includes(query.type)) filter.type = query.type;
  const range = createdAtRange(query.from, query.to, settings.timezone);
  if (range) filter.createdAt = range;

  const [total, movements] = await Promise.all([
    StockMovement.countDocuments(filter),
    StockMovement.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
  ]);
  const [stores, users, refs] = await Promise.all([
    storeRefs(organizationId, [oid(storeId)]),
    userRefs(organizationId, movements.map((movement) => movement.createdBy)),
    catalogRefs(organizationId, movements.map((m) => m.variantId), movements.map((m) => m.productId)),
  ]);
  return {
    movements: movements.map((movement) => toMovementView(movement, stores, users, refs, settings.decimals)),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

// ==========================================
// Stock levels
// ==========================================

export interface ListStockQuery {
  search?: string;
  categoryId?: string;
  includeSubcategories?: boolean;
  status?: string;
  includeInactive?: boolean;
  page?: number;
  limit?: number;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STATUS_MATCH: Record<string, Record<string, unknown>> = {
  in_stock: { quantityMilli: { $gt: 0 } },
  out_of_stock: { quantityMilli: { $lte: 0 } },
  negative: { quantityMilli: { $lt: 0 } },
  low: {
    $expr: {
      $and: [
        { $ne: [{ $ifNull: ["$reorderPoint", null] }, null] },
        { $lte: ["$quantityMilli", { $round: [{ $multiply: ["$reorderPoint", 1000] }, 0] }] },
      ],
    },
  },
};

interface StockRow {
  _id: ObjectId;
  sku: string | null;
  attributeValues: Record<string, string>;
  reorderPoint: number | null;
  isActive: boolean;
  quantityMilli: number;
  level: { valueMinor: number; avgCostMinor: number | null; lastMovementAt: Date } | null;
  product: { _id: ObjectId; name: string; unit: string; isActive: boolean; categoryId: ObjectId | null; attributes: { name: string }[] };
}

/**
 * Every variant of every goods product that tracks inventory, with its stock in this store
 * (0 when it never had any). Driven from the catalog so never-stocked variants are listed.
 */
export async function listStoreStock(organizationId: string, storeId: string, query: ListStockQuery, showCost: boolean) {
  const settings = await stockSettings(organizationId);
  const { page, limit, skip } = resolvePaging(query);
  const store = (await storeRefs(organizationId, [oid(storeId)])).get(storeId.toLowerCase())!;
  const empty = { store, items: [], pagination: buildPaginationMeta(page, limit, 0) };

  const productMatch: Record<string, unknown> = {
    "product.isDelete": { $ne: true },
    "product.type": "goods",
    "product.inventory.trackInventory": true,
  };
  if (!query.includeInactive) {
    productMatch["product.isActive"] = true;
  }
  if (query.categoryId !== undefined) {
    if (query.categoryId === "none") {
      productMatch["product.categoryId"] = null;
    } else if (mongoose.Types.ObjectId.isValid(query.categoryId)) {
      const categoryId = oid(query.categoryId);
      productMatch["product.categoryId"] =
        query.includeSubcategories === false ? categoryId : { $in: await categoryWithDescendants(organizationId, categoryId) };
    } else {
      return empty;
    }
  }
  // MongoDB rejects a regex containing a NUL byte (500), so drop any from the term.
  const term = query.search?.replace(/\0/g, "").trim();
  if (term) {
    productMatch.$or = [
      { "product.nameKey": { $regex: `^${escapeRegex(term.toLowerCase())}` } },
      { skuKey: { $regex: `^${escapeRegex(term.toLowerCase())}` } },
      { scanCodes: { $regex: `^${escapeRegex(term.toUpperCase())}` } },
    ];
  }

  const pipeline: mongoose.PipelineStage[] = [
    ...(query.includeInactive ? [] : [{ $match: { isActive: true } }]),
    { $lookup: { from: Product.collection.name, localField: "productId", foreignField: "_id", as: "product" } },
    { $unwind: "$product" },
    { $match: productMatch },
    {
      // The tenant plugin does not reach inside $lookup, so the join scopes itself.
      $lookup: {
        from: StockLevel.collection.name,
        let: { variantId: "$_id" },
        pipeline: [
          { $match: { organizationId: oid(organizationId), storeId: oid(storeId), $expr: { $eq: ["$variantId", "$$variantId"] } } },
        ],
        as: "level",
      },
    },
    { $addFields: { level: { $first: "$level" } } },
    { $addFields: { quantityMilli: { $ifNull: ["$level.quantityMilli", 0] } } },
  ];
  if (query.status && Object.hasOwn(STATUS_MATCH, query.status)) {
    pipeline.push({ $match: STATUS_MATCH[query.status] });
  }
  pipeline.push(
    { $sort: { "product.nameKey": 1, comboKey: 1, _id: 1 } },
    {
      $facet: {
        items: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              sku: 1,
              attributeValues: 1,
              reorderPoint: 1,
              isActive: 1,
              quantityMilli: 1,
              level: { valueMinor: 1, avgCostMinor: 1, lastMovementAt: 1 },
              product: { _id: 1, name: 1, unit: 1, isActive: 1, categoryId: 1, attributes: 1 },
            },
          },
        ],
        total: [{ $count: "count" }],
      },
    }
  );

  const [result] = await ProductVariant.aggregate<{ items: StockRow[]; total: { count: number }[] }>(pipeline);
  const rows = result?.items ?? [];
  const total = result?.total[0]?.count ?? 0;
  const categories = await categoryRefs(
    organizationId,
    rows.map((row) => row.product.categoryId).filter((id): id is ObjectId => Boolean(id))
  );

  return {
    store,
    items: rows.map((row) => {
      const level = row.level && row.level.lastMovementAt ? row.level : null;
      const quantityMilli = row.quantityMilli;
      return {
        variant: {
          id: row._id,
          name: variantDisplayName(row.product, row.attributeValues),
          sku: row.sku ?? null,
          isActive: row.isActive,
        },
        product: {
          id: row.product._id,
          name: row.product.name,
          unit: row.product.unit,
          isActive: row.product.isActive,
          category: row.product.categoryId ? (categories.get(row.product.categoryId.toString()) ?? null) : null,
        },
        quantity: fromMilli(quantityMilli),
        reorderPoint: row.reorderPoint ?? null,
        isLow: row.reorderPoint !== null && row.reorderPoint !== undefined && quantityMilli <= toMilli(row.reorderPoint),
        averageCost: showCost && level?.avgCostMinor != null ? formatMoney(level.avgCostMinor, settings.decimals) : null,
        stockValue: showCost ? formatMoney(level?.valueMinor ?? 0, settings.decimals) : null,
        lastMovementAt: level?.lastMovementAt ?? null,
      };
    }),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

/** The stores a user may see: all active stores for an organization role, their own otherwise. */
async function accessibleActiveStores(organizationId: string, user: IUser) {
  const filter: Record<string, unknown> = { organizationId, isActive: true };
  if (!user.isSuperAdmin && !hasOrganizationScopeRole(user)) {
    filter._id = { $in: (user.storeAccess ?? []).map((access) => access.storeId) };
  }
  return Store.find(filter).select("name code").sort({ name: 1, _id: 1 });
}

/** A product's stock in every active store the caller can access, per variant. */
export async function getProductStock(organizationId: string, productId: string, user: IUser) {
  const product = await Product.findOne({ _id: productId, organizationId });
  if (!product) {
    throw ApiError.coded(404, "PRODUCT_NOT_FOUND", "Product not found.");
  }
  const [variants, stores, costStores, settings] = await Promise.all([
    ProductVariant.find({ organizationId, productId: product._id }).sort({ _id: 1 }),
    accessibleActiveStores(organizationId, user),
    storesWithPermission(user, "inventory:read"),
    stockSettings(organizationId),
  ]);
  const levels = await StockLevel.find({
    organizationId,
    variantId: { $in: variants.map((variant) => variant._id) },
    storeId: { $in: stores.map((store) => store._id) },
  });
  const levelOf = new Map(levels.map((level) => [`${level.variantId}:${level.storeId}`, level]));
  const canSeeCost = (storeId: ObjectId) => costStores === "all" || costStores.has(storeId.toString());

  return {
    product: { id: product._id, name: product.name, unit: product.unit, trackInventory: product.inventory.trackInventory },
    variants: variants.map((variant) => {
      const perStore = stores.map((store) => {
        const level = levelOf.get(`${variant._id}:${store._id}`);
        const showCost = canSeeCost(store._id);
        return {
          store: { id: store._id, name: store.name, code: store.code },
          quantity: fromMilli(level?.quantityMilli ?? 0),
          averageCost: showCost && level?.avgCostMinor != null ? formatMoney(level.avgCostMinor, settings.decimals) : null,
          stockValue: showCost ? formatMoney(level?.valueMinor ?? 0, settings.decimals) : null,
          quantityMilli: level?.quantityMilli ?? 0,
        };
      });
      return {
        variant: {
          id: variant._id,
          name: variantDisplayName(product, variant.attributeValues),
          sku: variant.sku ?? null,
          isActive: variant.isActive,
        },
        totalQuantity: fromMilli(perStore.reduce((total, entry) => total + entry.quantityMilli, 0)),
        stores: perStore.map(({ quantityMilli: _omit, ...entry }) => entry),
      };
    }),
  };
}

// ==========================================
// Catalog hooks (used by product.service)
// ==========================================

export interface OpeningStockLine {
  storeId: string;
  quantity: number;
  unitCost?: string;
}

/** Checks opening stock lines before the product transaction: active stores, unit rules, costs. */
export async function prepareOpeningStock(
  organizationId: string,
  entries: { lines: OpeningStockLine[]; unit: string; defaultCostMinor: number | null; field: string }[],
  decimals: number
) {
  await assertActiveStores(
    organizationId,
    entries.flatMap((entry) => entry.lines.map((line, index) => ({ storeId: line.storeId, field: `${entry.field}[${index}].storeId` })))
  );
  return entries.map((entry) =>
    entry.lines.map((line, index) => {
      assertWholeIfNeeded(line.quantity, entry.unit, `${entry.field}[${index}].quantity`);
      return {
        storeId: oid(line.storeId),
        quantityMilli: toMilli(line.quantity),
        unitCostMinor:
          line.unitCost !== undefined ? parseMoney(line.unitCost, decimals, `${entry.field}[${index}].unitCost`) : (entry.defaultCostMinor ?? 0),
      };
    })
  );
}

export type PreparedOpeningLine = Awaited<ReturnType<typeof prepareOpeningStock>>[number][number];

/** Writes `opening` movements for a variant created in this transaction. */
export async function recordOpeningStock(
  session: mongoose.ClientSession,
  input: { organizationId: string; productId: ObjectId; variantId: ObjectId; lines: PreparedOpeningLine[]; actorUserId: string }
) {
  const at = new Date();
  for (const line of input.lines) {
    // A variant created in this transaction has no stock anywhere yet.
    await applyMovement(session, {
      organizationId: oid(input.organizationId),
      storeId: line.storeId,
      variantId: input.variantId,
      productId: input.productId,
      type: "opening",
      before: { quantityMilli: 0, valueMinor: 0, avgCostMinor: null },
      quantityMilli: line.quantityMilli,
      unitCostMinor: line.unitCostMinor,
      source: { type: "product", id: input.productId, number: null },
      createdBy: oid(input.actorUserId),
      at,
    });
  }
}

/** True when any of the variants has ever had a stock movement (in-use and unit locks). */
export async function hasStockMovements(organizationId: string, variantIds: ObjectId[]): Promise<boolean> {
  if (variantIds.length === 0) return false;
  return Boolean(await StockMovement.exists({ organizationId, variantId: { $in: variantIds } }));
}

/** True when any store holds a non-zero quantity of any of the variants. */
export async function hasStockOnHand(organizationId: string, variantIds: ObjectId[]): Promise<boolean> {
  if (variantIds.length === 0) return false;
  return Boolean(await StockLevel.exists({ organizationId, variantId: { $in: variantIds }, quantityMilli: { $ne: 0 } }));
}

/** Quantity on hand per variant across the organization's active stores (milli units). */
export async function stockOnHandByVariant(organizationId: string, variantIds: ObjectId[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  if (variantIds.length === 0) return totals;
  const activeStores = await Store.find({ organizationId, isActive: true }).select("_id");
  const rows = await StockLevel.aggregate<{ _id: ObjectId; quantityMilli: number }>([
    {
      $match: {
        organizationId: oid(organizationId),
        variantId: { $in: variantIds },
        storeId: { $in: activeStores.map((store) => store._id) },
      },
    },
    { $group: { _id: "$variantId", quantityMilli: { $sum: "$quantityMilli" } } },
  ]);
  for (const row of rows) totals.set(row._id.toString(), row.quantityMilli);
  return totals;
}
