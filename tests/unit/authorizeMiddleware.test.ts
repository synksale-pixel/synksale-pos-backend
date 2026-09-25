/**
 * Purpose: Unit tests for the `authorize` middleware's store resolution.
 * `authorize` must only honour the store that scopeToStore verified into the request context.
 * If it read a caller-supplied storeId, a route that forgot scopeToStore would pass the
 * permission check on the caller's store role while the tenant plugin applied no store filter,
 * exposing every store in the organization.
 */

import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import { Request, Response } from "express";
import { Role } from "../../src/models/role.model";
import { authorize } from "../../src/middleware/rbac.middleware";
import { requestContextStorage } from "../../src/utils/requestContext";
import { ApiError } from "../../src/utils/ApiError";

async function makeStoreStaff() {
  const organizationId = new mongoose.Types.ObjectId();
  const storeId = new mongoose.Types.ObjectId();
  const role = await Role.create({
    organizationId,
    scope: "store",
    name: "Stock Clerk",
    slug: "stock_clerk_authorize_unit",
    permissions: ["product:read"],
  });
  const user = {
    _id: new mongoose.Types.ObjectId(),
    isSuperAdmin: false,
    orgRoleId: null,
    storeAccess: [{ storeId, roleId: role._id }],
  };
  return { organizationId, storeId: storeId.toString(), user };
}

/** Runs `authorize` inside a request context and resolves with whatever it passes to next(). */
function runAuthorize(
  req: Partial<Request>,
  context: { organizationId: string; storeId?: string }
): Promise<unknown> {
  return new Promise((resolve) => {
    requestContextStorage.run({ requestId: "test", ...context }, () => {
      authorize("product:read")(req as Request, {} as Response, (err?: unknown) =>
        resolve(err)
      );
    });
  });
}

describe("authorize — store resolution", () => {
  it("grants store-role permissions when scopeToStore has put the store in the context", async () => {
    const { organizationId, storeId, user } = await makeStoreStaff();

    const result = await runAuthorize(
      { user, params: { storeId }, body: {}, query: {} } as unknown as Partial<Request>,
      { organizationId: organizationId.toString(), storeId }
    );

    expect(result).toBeUndefined();
  });

  it("ignores a caller-supplied storeId when no verified store is in the context", async () => {
    const { organizationId, storeId, user } = await makeStoreStaff();

    // Same request as above, but as if the route forgot scopeToStore: the storeId the caller
    // sent (in params, body and query) must not unlock their store role.
    const result = await runAuthorize(
      {
        user,
        params: { storeId },
        body: { storeId },
        query: { storeId },
      } as unknown as Partial<Request>,
      { organizationId: organizationId.toString() }
    );

    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).statusCode).toBe(403);
  });
});
