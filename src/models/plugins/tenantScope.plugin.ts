import { Schema, Query, Aggregate, Types, PipelineStage } from "mongoose";
import { getRequestContext, RequestContext } from "../../utils/requestContext";
import { ApiError } from "../../utils/ApiError";
import { logger } from "../../config/logger.config";

/**
 * Options configuration for the tenantScopePlugin.
 * - scope: 'organization' - isolates documents by organizationId (e.g. Store itself).
 * - scope: 'organization+store' - isolates documents by both organizationId and storeId (e.g. Products, Sales).
 * - softDelete (default true): adds the `isDelete` field and hides soft-deleted documents from
 *   every read. Set it to false for append-only ledgers (sales, stock movements, audit log),
 *   which must never be deleted in any form. Tenant scoping applies either way.
 */
export interface TenantScopeOptions {
  scope: "organization" | "organization+store";
  softDelete?: boolean;
}

/** Query methods whose filter is scoped. Everything that takes a filter must be listed here. */
const SCOPED_QUERY_METHODS = [
  "find",
  "findOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "countDocuments",
  "distinct",
  "updateMany",
  "updateOne",
  "replaceOne",
  "deleteOne",
  "deleteMany",
] as const;

/** Query methods whose update argument is a whole replacement document. */
const REPLACE_METHODS = new Set(["findOneAndReplace", "replaceOne"]);

/** Query methods whose update argument is an operator document ($set, $inc, ...). */
const UPDATE_METHODS = new Set(["updateOne", "updateMany", "findOneAndUpdate"]);

/** Update operators through which a tenant ID may be written (to the context's own value). */
const SETTING_OPERATORS = new Set(["$set", "$setOnInsert"]);

/**
 * Stages that must be the first in a pipeline. The tenant $match goes right after them
 * ($geoNear instead takes it in its own `query` option).
 */
const FIRST_ONLY_STAGES = ["$search", "$searchMeta", "$vectorSearch"];

/**
 * Mongoose schema plugin to enforce multi-tenant isolation and soft deletion.
 *
 * Services still pass organizationId explicitly. This plugin is the backstop that makes a
 * forgotten or wrong tenant ID fail safe instead of reading or writing another tenant's data.
 * Everything below is driven by the AsyncLocalStorage request context and is skipped when the
 * context carries no organizationId (seed/migration scripts, login/refresh, super-admin routes).
 *
 * 1. Schema: adds `organizationId` (and `storeId` for organization+store) when missing, and
 *    `isDelete` unless softDelete is false. The tenant IDs are made immutable, so an update can
 *    never move a document into another tenant.
 * 2. Queries (find*, countDocuments, distinct, update*, replace*, delete*): fills the context's
 *    organizationId/storeId into the filter when absent, and throws when the filter names a
 *    different one. Hides soft-deleted documents unless the filter asks about `isDelete`.
 * 3. Aggregates: prepends an equivalent $match (IDs cast to ObjectId, since aggregate does no
 *    casting). It does NOT reach inside $lookup/$unionWith/$graphLookup — a join into another
 *    tenant collection must scope its own pipeline or join on _id.
 *    Note the asymmetry: a pipeline $match/$geoNear naming another organization does not throw,
 *    it is ANDed with the tenant $match and returns nothing. Both fail closed, but an
 *    unexpectedly empty report may be this.
 * 4. Writes (save/create/insertMany/replacements): fills the tenant IDs when absent and throws
 *    when they differ from the context. A write to a second store (e.g. a transfer destination)
 *    must run inside runInOrganizationStore() (store.service.ts).
 *    Update bodies (update*, findOneAndUpdate) may set a tenant ID only through $set,
 *    $setOnInsert or a top-level key, and only to the context's value; any other operator on it
 *    (including either side of $rename) and pipeline-style updates throw. On organization+store
 *    models an upsert must resolve a single store from its filter or update body.
 * 5. estimatedDocumentCount and bulkWrite cannot be scoped, so they throw inside a tenant context.
 */
export function tenantScopePlugin(schema: Schema, options: TenantScopeOptions) {
  const storeScoped = options.scope === "organization+store";
  const softDelete = options.softDelete !== false;

  // Define fields dynamically if they do not exist
  if (softDelete && !schema.path("isDelete")) {
    schema.add({
      isDelete: {
        type: Boolean,
        default: false,
        index: true,
      },
    });
  }

  if (!schema.path("organizationId")) {
    schema.add({
      organizationId: {
        type: Schema.Types.ObjectId,
        ref: "Organization",
        required: true,
        index: true,
      },
    });
  }
  makeImmutable(schema, "organizationId");

  if (storeScoped) {
    if (!schema.path("storeId")) {
      schema.add({
        storeId: {
          type: Schema.Types.ObjectId,
          ref: "Store",
          required: true,
          index: true,
        },
      });
    }
    makeImmutable(schema, "storeId");
  }

  // Pre-query hook: inject tenant scoping filters and exclude soft-deleted documents
  const preQueryHook = function (this: Query<never, never>) {
    const filter = this.getFilter();
    const op = (this as unknown as { op?: string }).op;
    const context = getRequestContext();

    // 1. Inject or verify the tenant context (if available in the current AsyncLocalStorage context)
    if (context?.organizationId) {
      scopeFilterField(filter, "organizationId", context.organizationId, op);
      if (storeScoped && context.storeId) {
        scopeFilterField(filter, "storeId", context.storeId, op);
      }

      // A replacement document would otherwise be able to drop or change the tenant IDs.
      if (op && REPLACE_METHODS.has(op)) {
        const replacement = this.getUpdate() as Record<string, unknown> | null;
        if (replacement) {
          stampWrite(replacement, context, storeScoped, op);
        }
      }

      // Immutability does not cover upserts: Mongoose moves a $set on an immutable path into
      // $setOnInsert, which it deliberately exempts. So the update body is checked here.
      if (op && UPDATE_METHODS.has(op)) {
        const update = this.getUpdate() as UpdateBody | null;
        if (update) {
          checkUpdate(update, context, storeScoped, op);
        }
        if (storeScoped && this.getOptions().upsert) {
          requireUpsertStore(filter, update, op);
        }
      }
    }

    // 2. Enforce Soft Delete Filter
    // Only filter out soft-deleted records if the query doesn't explicitly query for `isDelete` status.
    if (softDelete && filter.isDelete === undefined) {
      filter.isDelete = { $ne: true };
    }
  };

  SCOPED_QUERY_METHODS.forEach((method) => {
    schema.pre(method as never, preQueryHook);
  });

  // Pre-aggregate hook: aggregate is its own middleware family and Mongoose passes pipelines
  // through unmodified, so the query hook above never sees them.
  schema.pre("aggregate", function (this: Aggregate<unknown>) {
    const context = getRequestContext();
    const pipeline = this.pipeline();

    const match: Record<string, unknown> = {};
    if (context?.organizationId) {
      match.organizationId = toObjectId(
        context.organizationId,
        "organizationId"
      );
      if (storeScoped && context.storeId) {
        match.storeId = toObjectId(context.storeId, "storeId");
      }
    }

    const first = pipeline[0] as unknown as Record<string, unknown> | undefined;
    const insertAt = first && FIRST_ONLY_STAGES.some((s) => s in first) ? 1 : 0;

    // Respect an explicit isDelete condition in the pipeline's opening $match, as the
    // query hook does for filters.
    const opening = pipeline[insertAt] as unknown as
      { $match?: Record<string, unknown> } | undefined;
    if (softDelete && opening?.$match?.isDelete === undefined) {
      match.isDelete = { $ne: true };
    }

    if (Object.keys(match).length === 0) {
      return;
    }

    if (first && "$geoNear" in first) {
      const geoNear = first.$geoNear as { query?: Record<string, unknown> };
      geoNear.query = geoNear.query ? { $and: [geoNear.query, match] } : match;
      return;
    }

    pipeline.splice(insertAt, 0, { $match: match } as PipelineStage);
  });

  // Pre-validate hook: covers save() and create(), and insertMany (which validates each document).
  schema.pre("validate", function () {
    const context = getRequestContext();
    if (context?.organizationId) {
      stampWrite(this as unknown as WritableDoc, context, storeScoped, "save");
    }
  });

  // insertMany with { lean: true } skips validation, so check the raw documents too.
  schema.pre(
    "insertMany",
    function (next: (err?: Error) => void, docs: unknown) {
      const context = getRequestContext();
      if (context?.organizationId) {
        const list = Array.isArray(docs) ? docs : [docs];
        for (const doc of list) {
          stampWrite(doc as WritableDoc, context, storeScoped, "insertMany");
        }
      }
      next();
    }
  );

  // Neither can carry a tenant filter, so they are refused rather than silently unscoped.
  schema.pre("estimatedDocumentCount", function () {
    if (getRequestContext()?.organizationId) {
      throw scopeViolation(
        "estimatedDocumentCount is not tenant-scoped; use countDocuments instead."
      );
    }
  });
  schema.pre("bulkWrite", function (next: (err?: Error) => void) {
    if (getRequestContext()?.organizationId) {
      return next(
        scopeViolation(
          "bulkWrite bypasses tenant scoping; use scoped model methods."
        )
      );
    }
    next();
  });
}

// ==========================================
// Helpers
// ==========================================

type TenantField = "organizationId" | "storeId";

/** A Mongoose document or a plain object about to be written. */
type WritableDoc = Record<string, unknown> & {
  get?: (path: string) => unknown;
  set?: (path: string, value: unknown) => void;
};

/**
 * Fills `field` into a query filter when absent; otherwise every value it names must be the
 * context's. A plain value, { $eq } or { $in } all naming the context ID pass; any other
 * value or operator means the query reaches outside the tenant, which is a code bug.
 */
function scopeFilterField(
  filter: Record<string, unknown>,
  field: TenantField,
  expected: string,
  op: string | undefined
) {
  const value = filter[field];
  if (value === undefined) {
    filter[field] = expected;
    return;
  }
  const ids = extractIds(value);
  if (!ids || ids.length === 0 || ids.some((id) => id !== expected)) {
    throw scopeViolation(
      `${op ?? "query"} filter on ${field} does not match the request context.`,
      { field, expected, received: String(JSON.stringify(value)) }
    );
  }
}

/** Fills the tenant IDs of a document being written when absent, and throws when they differ. */
function stampWrite(
  doc: WritableDoc,
  context: RequestContext,
  storeScoped: boolean,
  op: string
) {
  const expected: [TenantField, string | undefined][] = [
    ["organizationId", context.organizationId],
    ["storeId", storeScoped ? context.storeId : undefined],
  ];

  for (const [field, id] of expected) {
    if (!id) continue;
    const current = typeof doc.get === "function" ? doc.get(field) : doc[field];
    if (current === undefined || current === null) {
      if (typeof doc.set === "function") {
        doc.set(field, id);
      } else {
        doc[field] = id;
      }
    } else if (idString(current) !== id) {
      throw scopeViolation(
        `${op} writes ${field} that does not match the request context.`,
        {
          field,
          expected: id,
          received: idString(current),
        }
      );
    }
  }
}

type UpdateBody = Record<string, unknown> | Record<string, unknown>[];

/**
 * Checks an update body against the context. Values are verified, not filled in: on upsert the
 * inserted document already takes its equality fields from the (scoped) filter.
 */
function checkUpdate(
  update: UpdateBody,
  context: RequestContext,
  storeScoped: boolean,
  op: string
) {
  if (Array.isArray(update)) {
    throw scopeViolation(`${op} with a pipeline update is not tenant-checked.`);
  }

  const expected: [TenantField, string | undefined][] = [
    ["organizationId", context.organizationId],
  ];
  if (storeScoped) {
    expected.push(["storeId", context.storeId]);
  }

  for (const [key, value] of Object.entries(update)) {
    // A top-level non-operator key is shorthand for $set.
    const operator = key.startsWith("$") ? key : "$set";
    const fields = (key.startsWith("$") ? value : { [key]: value }) as Record<
      string,
      unknown
    >;
    if (!fields || typeof fields !== "object") continue;

    for (const [field, id] of expected) {
      const renamedInto =
        operator === "$rename" && Object.values(fields).includes(field);
      if (!(field in fields) && !renamedInto) continue;

      if (!SETTING_OPERATORS.has(operator) || renamedInto) {
        throw scopeViolation(`${op} applies ${operator} to ${field}.`, {
          field,
        });
      }
      // With no store in context (org-level requests) the service chooses the store.
      if (id && idString(fields[field]) !== id) {
        throw scopeViolation(
          `${op} sets ${field} that does not match the request context.`,
          { field, expected: id, received: idString(fields[field]) }
        );
      }
    }
  }
}

/**
 * An upsert skips validators, so on a store-scoped model it could otherwise insert a document
 * with no storeId at all. The store must come from an equality filter or the update body.
 */
function requireUpsertStore(
  filter: Record<string, unknown>,
  update: UpdateBody | null,
  op: string
) {
  const fromFilter = filter.storeId;
  if (
    isIdLike(fromFilter) ||
    (fromFilter &&
      typeof fromFilter === "object" &&
      isIdLike((fromFilter as { $eq?: unknown }).$eq))
  ) {
    return;
  }
  if (update && !Array.isArray(update)) {
    const sources = [update, update.$set, update.$setOnInsert] as (
      Record<string, unknown> | undefined
    )[];
    if (sources.some((s) => s && isIdLike(s.storeId))) {
      return;
    }
  }
  throw scopeViolation(`${op} upsert on a store-scoped model has no storeId.`);
}

/** Normalizes a filter value to the list of IDs it names, or null if it is not a simple match. */
function extractIds(value: unknown): string[] | null {
  if (isIdLike(value)) {
    return [idString(value)];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const obj = value as Record<string, unknown>;
    if (keys.length === 1 && keys[0] === "$eq" && isIdLike(obj.$eq)) {
      return [idString(obj.$eq)];
    }
    if (keys.length === 1 && keys[0] === "$in" && Array.isArray(obj.$in)) {
      return obj.$in.every(isIdLike) ? obj.$in.map(idString) : null;
    }
  }
  return null;
}

function isIdLike(value: unknown): boolean {
  return typeof value === "string" || value instanceof Types.ObjectId;
}

function idString(value: unknown): string {
  // A populated reference compares by its _id.
  if (
    value &&
    typeof value === "object" &&
    "_id" in value &&
    !(value instanceof Types.ObjectId)
  ) {
    return String((value as { _id: unknown })._id);
  }
  return String(value);
}

function toObjectId(id: string, field: TenantField): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) {
    throw scopeViolation(`Request context ${field} is not a valid ObjectId.`, {
      field,
    });
  }
  return new Types.ObjectId(id);
}

/**
 * A scope violation is always a code bug, never a user error, so it surfaces as a 500 and is
 * logged loudly rather than returned as a 403/404 the client could act on.
 */
function scopeViolation(
  message: string,
  details: Record<string, unknown> = {}
): ApiError {
  logger.error(`Tenant scope violation: ${message}`, details);
  return new ApiError(500, "Tenant scope violation.");
}

/**
 * Marks a tenant ID path immutable for both document saves and update queries. SchemaType's
 * immutable() only covers documents; update casting reads `options.immutable`, so set both.
 */
function makeImmutable(schema: Schema, path: TenantField) {
  const schemaType = schema.path(path);
  schemaType.options.immutable = true;
  schemaType.immutable(true);
}
