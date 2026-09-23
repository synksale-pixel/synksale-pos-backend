/**
 * Purpose: Unit-level tests for the Role model's pre('validate') scope backstop
 * (src/models/role.model.ts). Verifies the claim in role.service.ts that this hook is a
 * backstop "no code path can bypass" — specifically, whether it is reached on write paths
 * other than .save()/.create().
 */

import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import { Role } from "../../src/models/role.model";

describe("Role pre('validate') scope backstop", () => {
  it("rejects an out-of-scope permission on new Role(...).save(), independent of any service-layer check", async () => {
    const role = new Role({
      organizationId: new mongoose.Types.ObjectId(),
      scope: "store",
      name: "Direct Save",
      slug: "direct_save_backstop",
      permissions: ["report:view_org"], // minScope "organization", invalid at store scope
    });

    await expect(role.save()).rejects.toThrow(/not valid at store scope/i);
  });

  it("rejects the same input via Role.create()", async () => {
    await expect(
      Role.create({
        organizationId: new mongoose.Types.ObjectId(),
        scope: "store",
        name: "Direct Create",
        slug: "direct_create_backstop",
        permissions: ["report:view_org"],
      })
    ).rejects.toThrow(/not valid at store scope/i);
  });

  it("is NOT reached via findOneAndUpdate + runValidators — a latent gap, currently unused by any code path in this repo", async () => {
    // grep confirms role.service.ts / roleSeed.service.ts only ever write Role documents via
    // .create() or .save(), so this gap is not reachable today. It is still worth asserting:
    // document middleware (pre('validate')) only fires on .validate()/.save(); update-query
    // validators (`runValidators: true`) only run SchemaType-level path validators, not
    // document middleware. If a future change wrote Role via findOneAndUpdate/updateOne, this
    // scope check would silently stop applying.
    const role = await Role.create({
      organizationId: new mongoose.Types.ObjectId(),
      scope: "store",
      name: "Update Path",
      slug: "update_path_backstop",
      permissions: ["sale:create"],
    });

    const updated = await Role.findOneAndUpdate(
      { _id: role._id },
      { $set: { permissions: ["report:view_org"] } },
      { new: true, runValidators: true }
    );

    // If the backstop were reached here, this would have rejected instead of succeeding.
    expect(updated!.permissions).toEqual(["report:view_org"]);
  });
});
