/**
 * Purpose: Customer Routes (Phase 4a-2).
 * Customers are organization-wide, so permissions are checked held anywhere (organization role
 * or any store role), like vendor reads:
 * - reads and the till lookup: `customer:read` (cashiers have it);
 * - create: `customer:create` (cashiers have it, for the till's "Add customer");
 * - edit, import, delete: `customer:manage` (store managers and org admins).
 */

import { Router } from "express";
import { validateRequest } from "../../middleware/validateRequest.middleware";
import { authenticate, authorizeAnyScope } from "../../middleware/rbac.middleware";
import { createCustomerSchema, importCustomersSchema, updateCustomerSchema } from "../../validators/customer.validator";
import { list, lookup, getOne, create, importMany, update, remove } from "../../controllers/customer.controller";

const customerRouter = Router();

customerRouter.use(authenticate);

const canRead = authorizeAnyScope("customer:read");
const canCreate = authorizeAnyScope("customer:create");
const canManage = authorizeAnyScope("customer:manage");

customerRouter.get("/", canRead, list);
// Before "/:customerId", which would otherwise take "lookup" as an ID.
customerRouter.get("/lookup", canRead, lookup);
customerRouter.get("/:customerId", canRead, getOne);

customerRouter.post("/", canCreate, validateRequest(createCustomerSchema), create);
customerRouter.post("/import", canManage, validateRequest(importCustomersSchema), importMany);
customerRouter.patch("/:customerId", canManage, validateRequest(updateCustomerSchema), update);
customerRouter.delete("/:customerId", canManage, remove);

export default customerRouter;
