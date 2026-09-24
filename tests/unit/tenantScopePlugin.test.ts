/**
 * Purpose: Tests for the tenantScopePlugin (src/models/plugins/tenantScope.plugin.ts) against a
 * real (in-memory) MongoDB. Two organizations are always seeded, and every case checks that a
 * request context for one of them cannot read, write or move the other's data — through
 * aggregate, distinct, the delete/replace variants and bulk inserts as well as plain find.
 */

import { describe, it, expect, beforeEach } from "vitest";
import mongoose, { Schema } from "mongoose";
import { tenantScopePlugin } from "../../src/models/plugins/tenantScope.plugin";
import {
  requestContextStorage,
  runWithStoreContext,
  RequestContext,
} from "../../src/utils/requestContext";
import { Store } from "../../src/models/store.model";
import { runInOrganizationStore } from "../../src/services/store.service";

// Test-only models, so the plugin is exercised in isolation from any model's own hooks.
const orgItemSchema = new Schema({ name: String, qty: Number });
orgItemSchema.plugin(tenantScopePlugin, { scope: "organization" });
const OrgItem = mongoose.model("TenantScopeOrgItem", orgItemSchema);

const ledgerSchema = new Schema({ name: String, qty: Number });
ledgerSchema.plugin(tenantScopePlugin, {
  scope: "organization+store",
  softDelete: false,
});
const LedgerItem = mongoose.model("TenantScopeLedgerItem", ledgerSchema);

// A geo-enabled collection to exercise the $geoNear branch of the aggregate hook, which takes
// its own `query` option instead of a normal pipeline $match.
const geoSchema = new Schema({
  name: String,
  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: [Number],
  },
});
geoSchema.index({ location: "2dsphere" });
geoSchema.plugin(tenantScopePlugin, { scope: "organization" });
const GeoItem = mongoose.model("TenantScopeGeoItem", geoSchema);

// A minimal stand-in for the real Organization model, registered only so that
// `.populate("organizationId")` has somewhere to resolve to.
const OrgRefModel =
  mongoose.models.Organization ||
  mongoose.model("Organization", new Schema({ name: String }));

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const storeA1 = new mongoose.Types.ObjectId();
const storeA2 = new mongoose.Types.ObjectId();
const storeB1 = new mongoose.Types.ObjectId();

/**
 * Runs fn inside a request context, as the authenticate/scopeToStore middleware would.
 * The result is awaited inside the context: a Mongoose Query only executes when awaited, and
 * one returned un-awaited would execute outside it.
 */
function asTenant<T>(
  ctx: Omit<RequestContext, "requestId">,
  fn: () => PromiseLike<T>
): Promise<T> {
  return requestContextStorage.run(
    { requestId: "test", ...ctx },
    async () => await fn()
  );
}
const asOrgA = <T>(fn: () => PromiseLike<T>) =>
  asTenant({ organizationId: orgA.toString() }, fn);
const asStoreA1 = <T>(fn: () => PromiseLike<T>) =>
  asTenant(
    { organizationId: orgA.toString(), storeId: storeA1.toString() },
    fn
  );

const VIOLATION = /Tenant scope violation/;

beforeEach(async () => {
  // Seeded with no request context, like a script — the plugin does not interfere.
  await OrgItem.create([
    { organizationId: orgA, name: "a-1", qty: 1 },
    { organizationId: orgA, name: "a-2", qty: 2 },
    { organizationId: orgA, name: "a-deleted", qty: 100, isDelete: true },
    { organizationId: orgB, name: "b-1", qty: 50 },
  ]);
  await LedgerItem.create([
    { organizationId: orgA, storeId: storeA1, name: "a1", qty: 1 },
    { organizationId: orgA, storeId: storeA2, name: "a2", qty: 2 },
    { organizationId: orgB, storeId: storeB1, name: "b1", qty: 3 },
  ]);
  await OrgRefModel.create({ _id: orgA, name: "Org A" });
  await GeoItem.init(); // ensure the 2dsphere index exists before $geoNear runs
  await GeoItem.create([
    {
      organizationId: orgA,
      name: "geo-a",
      location: { type: "Point", coordinates: [0, 0] },
    },
    {
      organizationId: orgB,
      name: "geo-b",
      location: { type: "Point", coordinates: [0, 0] },
    },
  ]);
});

describe("tenantScopePlugin — operations the query hook used to miss", () => {
  it("aggregate is scoped to the context organization and hides soft-deleted documents", async () => {
    const result = await asOrgA(() =>
      OrgItem.aggregate<{ total: number }>([
        { $group: { _id: null, total: { $sum: "$qty" } } },
      ])
    );
    expect(result).toEqual([{ _id: null, total: 3 }]);
  });

  it("aggregate respects an explicit isDelete condition in the opening $match", async () => {
    const result = await asOrgA(() =>
      OrgItem.aggregate([
        { $match: { isDelete: true } },
        { $project: { name: 1 } },
      ])
    );
    expect(result.map((r) => r.name)).toEqual(["a-deleted"]);
  });

  it("aggregate with a $match naming another organization returns nothing", async () => {
    const result = await asOrgA(() =>
      OrgItem.aggregate([{ $match: { organizationId: orgB } }])
    );
    expect(result).toEqual([]);
  });

  it("aggregate is scoped to the context store on store-scoped models", async () => {
    const result = await asStoreA1(() =>
      LedgerItem.aggregate([{ $project: { name: 1 } }])
    );
    expect(result.map((r) => r.name)).toEqual(["a1"]);
  });

  it("aggregate outside a request context stays unscoped (super admin / scripts)", async () => {
    const result = await OrgItem.aggregate([{ $count: "n" }]);
    expect(result).toEqual([{ n: 3 }]);
  });

  it("distinct only returns the context organization's values", async () => {
    const names = await asOrgA(() => OrgItem.distinct("name"));
    expect(names.sort()).toEqual(["a-1", "a-2"]);
  });

  it("findByIdAndDelete cannot delete another organization's document", async () => {
    const foreign = await OrgItem.findOne({ organizationId: orgB });
    const deleted = await asOrgA(() => OrgItem.findByIdAndDelete(foreign!._id));
    expect(deleted).toBeNull();
    expect(await OrgItem.collection.countDocuments({ _id: foreign!._id })).toBe(
      1
    );
  });

  it("replaceOne cannot reach another organization's document", async () => {
    const foreign = await OrgItem.findOne({ organizationId: orgB });
    const res = await asOrgA(() =>
      OrgItem.replaceOne({ _id: foreign!._id }, { name: "pwned" })
    );
    expect(res.matchedCount).toBe(0);
  });

  it("a replacement document keeps the context organization when it omits it", async () => {
    const own = await OrgItem.findOne({ organizationId: orgA, name: "a-1" });
    await asOrgA(() =>
      OrgItem.replaceOne({ _id: own!._id }, { name: "renamed" })
    );
    const raw = await OrgItem.collection.findOne({ _id: own!._id });
    expect(raw?.name).toBe("renamed");
    expect(String(raw?.organizationId)).toBe(orgA.toString());
  });

  it("a replacement document naming another organization is rejected", async () => {
    const own = await OrgItem.findOne({ organizationId: orgA, name: "a-1" });
    await expect(
      asOrgA(() =>
        OrgItem.findOneAndReplace(
          { _id: own!._id },
          { organizationId: orgB, name: "x" }
        )
      )
    ).rejects.toThrow(VIOLATION);
  });

  it("estimatedDocumentCount and bulkWrite are refused inside a tenant context", async () => {
    await expect(
      asOrgA(() => OrgItem.estimatedDocumentCount())
    ).rejects.toThrow(VIOLATION);
    await expect(
      asOrgA(() =>
        OrgItem.bulkWrite([{ insertOne: { document: { name: "x" } } }])
      )
    ).rejects.toThrow(VIOLATION);
    // Outside a request context they still work.
    expect(await OrgItem.estimatedDocumentCount()).toBe(4);
  });
});

describe("tenantScopePlugin — explicit tenant IDs in filters", () => {
  it("a filter naming the context organization is allowed (string, ObjectId, $eq, $in)", async () => {
    await asOrgA(async () => {
      expect(
        await OrgItem.countDocuments({ organizationId: orgA.toString() })
      ).toBe(2);
      expect(await OrgItem.countDocuments({ organizationId: orgA })).toBe(2);
      expect(
        await OrgItem.countDocuments({ organizationId: { $eq: orgA } })
      ).toBe(2);
      expect(
        await OrgItem.countDocuments({ organizationId: { $in: [orgA] } })
      ).toBe(2);
    });
  });

  it("a filter naming another organization throws instead of reading it", async () => {
    await expect(
      asOrgA(() => OrgItem.find({ organizationId: orgB }))
    ).rejects.toThrow(VIOLATION);
    await expect(
      asOrgA(() => OrgItem.find({ organizationId: { $in: [orgA, orgB] } }))
    ).rejects.toThrow(VIOLATION);
    await expect(
      asOrgA(() => OrgItem.find({ organizationId: { $ne: orgA } }))
    ).rejects.toThrow(VIOLATION);
    await expect(
      asOrgA(() =>
        OrgItem.updateMany({ organizationId: orgB }, { $set: { qty: 0 } })
      )
    ).rejects.toThrow(VIOLATION);
  });

  it("a filter naming another store throws when a store is in context", async () => {
    await expect(
      asStoreA1(() => LedgerItem.find({ storeId: storeA2 }))
    ).rejects.toThrow(VIOLATION);
  });

  it("with no store in context, an org-level query may filter on any store", async () => {
    const items = await asOrgA(() =>
      LedgerItem.find({ storeId: { $in: [storeA1, storeA2] } })
    );
    expect(items).toHaveLength(2);
  });

  it("runWithStoreContext allows deliberately reading a second store", async () => {
    const items = await asStoreA1(() =>
      runWithStoreContext(storeA2.toString(), () =>
        LedgerItem.find({ storeId: storeA2 })
      )
    );
    expect(items.map((i) => i.name)).toEqual(["a2"]);
  });

  it("an update cannot move a document into another organization", async () => {
    const own = await OrgItem.findOne({ organizationId: orgA, name: "a-1" });
    // In a tenant context the update body is checked and refused outright.
    await expect(
      asOrgA(() =>
        OrgItem.updateOne(
          { _id: own!._id },
          { $set: { organizationId: orgB, qty: 9 } }
        )
      )
    ).rejects.toThrow(VIOLATION);
    // Outside one (scripts), immutability still drops the change and applies the rest.
    await OrgItem.updateOne(
      { _id: own!._id },
      { $set: { organizationId: orgB, qty: 9 } }
    );
    const raw = await OrgItem.collection.findOne({ _id: own!._id });
    expect(String(raw?.organizationId)).toBe(orgA.toString());
    expect(raw?.qty).toBe(9);
  });
});

describe("tenantScopePlugin — writes", () => {
  it("create fills in the context organization and store when absent", async () => {
    const doc = await asStoreA1(() =>
      LedgerItem.create({ name: "stamped", qty: 1 })
    );
    expect(doc.organizationId?.toString()).toBe(orgA.toString());
    expect(doc.storeId?.toString()).toBe(storeA1.toString());
  });

  it("create with another organization is rejected", async () => {
    await expect(
      asOrgA(() => OrgItem.create({ organizationId: orgB, name: "smuggled" }))
    ).rejects.toThrow(VIOLATION);
    expect(await OrgItem.collection.countDocuments({ name: "smuggled" })).toBe(
      0
    );
  });

  it("create with another store is rejected unless run in that store's context", async () => {
    await expect(
      asStoreA1(() =>
        LedgerItem.create({ storeId: storeA2, name: "transfer-in", qty: 1 })
      )
    ).rejects.toThrow(VIOLATION);

    const doc = await asStoreA1(() =>
      runWithStoreContext(storeA2.toString(), () =>
        LedgerItem.create({ storeId: storeA2, name: "transfer-in", qty: 1 })
      )
    );
    expect(doc.organizationId?.toString()).toBe(orgA.toString());
  });

  it("insertMany (including lean) rejects a document for another organization", async () => {
    await expect(
      asOrgA(() =>
        OrgItem.insertMany([
          { name: "ok" },
          { organizationId: orgB, name: "bad" },
        ])
      )
    ).rejects.toThrow(VIOLATION);
    await expect(
      asOrgA(() =>
        OrgItem.insertMany([{ organizationId: orgB, name: "bad" }], {
          lean: true,
        })
      )
    ).rejects.toThrow(VIOLATION);
    expect(
      await OrgItem.collection.countDocuments({ organizationId: orgB })
    ).toBe(1);
  });

  it("insertMany fills in the context organization", async () => {
    await asOrgA(() => OrgItem.insertMany([{ name: "bulk" }], { lean: true }));
    const raw = await OrgItem.collection.findOne({ name: "bulk" });
    expect(String(raw?.organizationId)).toBe(orgA.toString());
  });

  it("save on an existing document in its own organization still works", async () => {
    await asOrgA(async () => {
      const doc = await OrgItem.findOne({ name: "a-1" });
      doc!.qty = 5;
      await doc!.save();
    });
    expect((await OrgItem.collection.findOne({ name: "a-1" }))?.qty).toBe(5);
  });
});

describe("tenantScopePlugin — softDelete option", () => {
  it("softDelete: false adds no isDelete field", () => {
    expect(ledgerSchema.path("isDelete")).toBeUndefined();
    expect(orgItemSchema.path("isDelete")).toBeDefined();
  });

  it("softDelete: false adds no isDelete filter, but tenant scoping still applies", async () => {
    // A stray isDelete flag on a ledger document must not hide it.
    await LedgerItem.collection.updateOne(
      { name: "a1" },
      { $set: { isDelete: true } }
    );
    const items = await asOrgA(() => LedgerItem.find().sort({ name: 1 }));
    expect(items.map((i) => i.name)).toEqual(["a1", "a2"]);
  });
});

describe("tenantScopePlugin — $geoNear", () => {
  it("scopes a $geoNear pipeline to the context organization via its `query` option", async () => {
    const result = await asOrgA(() =>
      GeoItem.aggregate<{ name: string }>([
        {
          $geoNear: {
            near: { type: "Point", coordinates: [0, 0] },
            distanceField: "dist",
            spherical: true,
          },
        },
      ])
    );
    expect(result.map((r) => r.name)).toEqual(["geo-a"]);
  });

  it("an explicit query naming another organization inside $geoNear returns nothing (AND semantics, like $match)", async () => {
    // Matches the existing "aggregate with a $match naming another organization" behavior:
    // the tenant hook does not throw for a conflicting explicit id inside a pipeline stage,
    // it merges its own condition in and lets Mongo return no results.
    const result = await asOrgA(() =>
      GeoItem.aggregate([
        {
          $geoNear: {
            near: { type: "Point", coordinates: [0, 0] },
            distanceField: "dist",
            spherical: true,
            query: { organizationId: orgB },
          },
        },
      ])
    );
    expect(result).toEqual([]);
  });
});

describe("tenantScopePlugin — populated tenant reference on save", () => {
  it("does not falsely reject save() when organizationId has been populated", async () => {
    await asOrgA(async () => {
      const doc = await OrgItem.findOne({ name: "a-1" }).populate(
        "organizationId"
      );
      // Sanity check that populate actually resolved to a document, not a bare ObjectId,
      // otherwise this test would not exercise the idString() populated-object branch.
      expect(doc!.organizationId).toHaveProperty("name", "Org A");
      doc!.qty = 42;
      await doc!.save();
    });
    const raw = await OrgItem.collection.findOne({ name: "a-1" });
    expect(raw?.qty).toBe(42);
    expect(String(raw?.organizationId)).toBe(orgA.toString());
  });
});

describe("tenantScopePlugin — runWithStoreContext", () => {
  it("restores the outer store once a nested call resolves", async () => {
    await asStoreA1(async () => {
      expect(requestContextStorage.getStore()?.storeId).toBe(
        storeA1.toString()
      );
      await runWithStoreContext(storeA2.toString(), async () => {
        expect(requestContextStorage.getStore()?.storeId).toBe(
          storeA2.toString()
        );
      });
      expect(requestContextStorage.getStore()?.storeId).toBe(
        storeA1.toString()
      );
      // And the plugin is scoped back to the outer store again.
      const items = await LedgerItem.find();
      expect(items.map((i) => i.name)).toEqual(["a1"]);
    });
  });

  it("refuses to run without an organization in context, rather than silently unscoping", async () => {
    // With no organization the plugin engages nothing, so a store switch would scope nothing.
    expect(() =>
      runWithStoreContext(storeA1.toString(), () => LedgerItem.find())
    ).toThrow(/requires an organization/);
  });
});

describe("tenantScopePlugin — runInOrganizationStore", () => {
  const ownStore = new mongoose.Types.ObjectId();
  const foreignStore = new mongoose.Types.ObjectId();

  beforeEach(async () => {
    // Raw inserts: only _id/organizationId/isDelete matter to the ownership check.
    await Store.collection.insertMany([
      { _id: ownStore, organizationId: orgA, isDelete: false },
      { _id: foreignStore, organizationId: orgB, isDelete: false },
    ]);
  });

  it("switches to a store of the caller's organization", async () => {
    const doc = await asStoreA1(() =>
      runInOrganizationStore(ownStore.toString(), () =>
        LedgerItem.create({ name: "transfer-in", qty: 1 })
      )
    );
    expect(doc.storeId?.toString()).toBe(ownStore.toString());
  });

  it("refuses another organization's store with a 404", async () => {
    await expect(
      asStoreA1(() =>
        runInOrganizationStore(foreignStore.toString(), () =>
          LedgerItem.create({ name: "smuggled", qty: 1 })
        )
      )
    ).rejects.toThrow(/Store not found/);
    expect(
      await LedgerItem.collection.countDocuments({ name: "smuggled" })
    ).toBe(0);
  });
});

describe("tenantScopePlugin — null tenant filter value", () => {
  it("organizationId: null in a tenant context is a scope violation, not an open query", async () => {
    await expect(
      asOrgA(() => OrgItem.find({ organizationId: null } as never))
    ).rejects.toThrow(VIOLATION);
  });
});

// Immutability alone does not protect upserts: Mongoose moves a $set on an immutable path into
// $setOnInsert, which it exempts. So the plugin checks update bodies itself.
describe("tenantScopePlugin — update bodies and upserts", () => {
  it("findOneAndUpdate with upsert cannot $set another organization", async () => {
    await expect(
      asOrgA(() =>
        OrgItem.findOneAndUpdate(
          { organizationId: orgA, name: "upsert-set" },
          { $set: { qty: 1, organizationId: orgB } },
          { upsert: true, new: true }
        )
      )
    ).rejects.toThrow(VIOLATION);
    expect(
      await OrgItem.collection.countDocuments({ name: "upsert-set" })
    ).toBe(0);
  });

  it("updateOne with upsert cannot $setOnInsert another organization", async () => {
    await expect(
      asOrgA(() =>
        OrgItem.updateOne(
          { organizationId: orgA, name: "upsert-soi" },
          { $set: { qty: 1 }, $setOnInsert: { organizationId: orgB } },
          { upsert: true }
        )
      )
    ).rejects.toThrow(VIOLATION);
    expect(
      await OrgItem.collection.countDocuments({ name: "upsert-soi" })
    ).toBe(0);
  });

  it("an upsert naming the context's own organization and store inserts correctly", async () => {
    // The StockLevel pattern: increment, creating the row on first use.
    await asStoreA1(async () => {
      await LedgerItem.updateOne(
        { name: "sku-1" },
        {
          $inc: { qty: 5 },
          $setOnInsert: { organizationId: orgA, storeId: storeA1 },
        },
        { upsert: true }
      );
      await LedgerItem.updateOne(
        { name: "sku-1" },
        { $inc: { qty: 2 } },
        { upsert: true }
      );
    });
    const raw = await LedgerItem.collection.findOne({ name: "sku-1" });
    expect(raw?.qty).toBe(7);
    expect(String(raw?.organizationId)).toBe(orgA.toString());
    expect(String(raw?.storeId)).toBe(storeA1.toString());
  });

  it("other operators on a tenant ID throw, including either side of $rename", async () => {
    const own = await OrgItem.findOne({ organizationId: orgA, name: "a-1" });
    for (const update of [
      { $unset: { organizationId: "" } },
      { $rename: { organizationId: "formerOrg" } },
      { $rename: { name: "organizationId" } },
    ]) {
      await expect(
        asOrgA(() => OrgItem.updateOne({ _id: own!._id }, update))
      ).rejects.toThrow(VIOLATION);
    }
    expect(
      String(
        (await OrgItem.collection.findOne({ _id: own!._id }))?.organizationId
      )
    ).toBe(orgA.toString());
  });

  it("a pipeline-style update is refused in a tenant context", async () => {
    await expect(
      asOrgA(() => OrgItem.updateMany({}, [{ $set: { organizationId: orgB } }]))
    ).rejects.toThrow(VIOLATION);
  });

  it("a store-scoped upsert that resolves no store is refused", async () => {
    // An org-level context has no store, and upserts skip the `required` validator.
    await expect(
      asOrgA(() =>
        LedgerItem.updateOne(
          { name: "no-store" },
          { $inc: { qty: 1 } },
          { upsert: true }
        )
      )
    ).rejects.toThrow(VIOLATION);
    expect(
      await LedgerItem.collection.countDocuments({ name: "no-store" })
    ).toBe(0);

    // Naming the store explicitly is fine for an org-level request.
    await asOrgA(() =>
      LedgerItem.updateOne(
        { name: "with-store" },
        { $inc: { qty: 1 }, $setOnInsert: { storeId: storeA2 } },
        { upsert: true }
      )
    );
    const raw = await LedgerItem.collection.findOne({ name: "with-store" });
    expect(String(raw?.storeId)).toBe(storeA2.toString());
  });
});
