/**
 * Purpose: Unit-level tests for the pure privilege-ceiling functions in permission.service.ts.
 * Unlike tests/integration/roleManagement.test.ts, these call canGrantRole/canModifyRole
 * directly, including with a real hydrated Mongoose document, to verify assumptions the
 * integration suite cannot see through the HTTP/JSON boundary (JSON.stringify would silently
 * paper over the exact bug under test here).
 */

import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import { Role, IRole } from "../../src/models/role.model";
import { canGrantRole, canModifyRole } from "../../src/services/permission.service";

describe("canGrantRole — scope handling when the target role object is missing a `scope` field", () => {
  it("treats an object with no `scope` key as rank 0, so the scope gate always passes", () => {
    const actorPermissions = ["sale:create"];
    const actorScope = "store" as const;

    // No `scope` property at all — this is what {...hydratedMongooseDoc} produces, below.
    const scopeless = { permissions: ["sale:create"] } as unknown as IRole;
    expect(canGrantRole(actorPermissions, actorScope, scopeless)).toBe(true);

    // The same permissions, but with an explicit scope the actor should NOT be able to grant.
    const withScope = { scope: "organization", permissions: ["sale:create"] } as IRole;
    expect(canGrantRole(actorPermissions, actorScope, withScope)).toBe(false);
  });
});

describe("canModifyRole — spreading a hydrated Mongoose document", () => {
  it("a RAW spread drops every field it does not explicitly re-set (scope, name, organizationId, ...)", async () => {
    // This is the hazard canModifyRole has to work around, asserted directly so the reason for
    // the .toObject() call in permission.service.ts cannot be "simplified" away later.
    // loadRole() returns a hydrated Document, and Mongoose defines schema-path getters on the
    // model's compiled prototype rather than as the document's own enumerable properties, so a
    // plain object spread does not pick them up.
    const role = await Role.create({
      organizationId: new mongoose.Types.ObjectId(),
      scope: "store",
      name: "Spread Check",
      slug: "spread_check_unit",
      permissions: ["sale:create"],
    });
    const hydrated = await Role.findById(role._id); // a real Document, same shape loadRole returns

    const spread = {
      ...(hydrated as unknown as Record<string, unknown>),
      permissions: ["sale:create", "inventory:adjust"],
    };

    // scope/name/organizationId vanish; only the explicitly reassigned `permissions` key
    // (and Mongoose's own internal `_doc`/`$__`/`$isNew`) survive.
    expect(spread.scope).toBeUndefined();
    expect(spread.name).toBeUndefined();
    expect(spread.organizationId).toBeUndefined();
    expect(spread.permissions).toEqual(["sale:create", "inventory:adjust"]);
  });

  it("rejects an actor who does not dominate the role's CURRENT scope", async () => {
    // The first check reads currentRole.scope by direct property access, which works on a
    // hydrated document — the spread hazard above never applied to it.
    const role = await Role.create({
      organizationId: new mongoose.Types.ObjectId(),
      scope: "organization", // above a "store" actor
      name: "Org Scoped",
      slug: "org_scoped_unit",
      permissions: ["report:view_org"],
    });
    const hydrated = await Role.findById(role._id);

    const storeActorPermissions = ["report:view_org"]; // holds the permission, but not the scope
    const result = canModifyRole(
      storeActorPermissions,
      "store",
      hydrated as never,
      ["report:view_org"]
    );

    expect(result).toBe(false);
  });

  it("rejects an actor who dominates the role today but not the permissions being added", async () => {
    // This is the check that the raw spread broke: it builds the proposed state from
    // currentRole, so before .toObject() the proposed role had NO scope at all and ranked 0,
    // making the scope gate pass unconditionally. Exercised here through a real hydrated
    // document, which is what role.service actually passes in.
    const role = await Role.create({
      organizationId: new mongoose.Types.ObjectId(),
      scope: "store",
      name: "Modest",
      slug: "modest_unit",
      permissions: ["sale:create"],
    });
    const hydrated = await Role.findById(role._id);

    const actorPermissions = ["sale:create"]; // dominates the role as it stands
    expect(canModifyRole(actorPermissions, "store", hydrated as never)).toBe(true);

    // ...but not once inventory:adjust is added, which the actor does not hold.
    expect(
      canModifyRole(actorPermissions, "store", hydrated as never, [
        "sale:create",
        "inventory:adjust",
      ])
    ).toBe(false);
  });

  it("builds the proposed role with its scope intact", async () => {
    // Regression guard for the .toObject() fix: a store-scoped actor must not be able to
    // modify an organization-scoped role by having its scope vanish from the proposed object.
    const role = await Role.create({
      organizationId: new mongoose.Types.ObjectId(),
      scope: "organization",
      name: "Org Level",
      slug: "org_level_unit",
      permissions: ["report:view_org"],
    });
    const hydrated = await Role.findById(role._id);

    // An actor holding the permission AND organization scope is fine...
    expect(
      canModifyRole(["report:view_org"], "organization", hydrated as never, ["report:view_org"])
    ).toBe(true);

    // ...while the same actor at store scope is not, on both checks.
    expect(
      canModifyRole(["report:view_org"], "store", hydrated as never, ["report:view_org"])
    ).toBe(false);
  });
});
