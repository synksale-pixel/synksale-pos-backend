/**
 * Purpose: User (staff) Management Validators.
 * Zod schemas for modifying an existing user's access. Creating users is validated in
 * userInvite.validator.ts.
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const objectIdField = (label: string, description: string, example: string) =>
  z
    .string()
    .regex(objectIdRegex, {
      message: `Invalid ${label} format. Must be a 24-character hex string.`,
    })
    .openapi({ description, example });

export const setOrgRoleSchema = z
  .object({
    roleId: objectIdField(
      "roleId",
      "ID of an ORGANIZATION-scoped role in your organization. Send null to remove the user's organization-wide role and leave them with only their store assignments.",
      "665f1c2e8a4b3c0012ab34cd"
    )
      .nullable(),
  })
  .strict({ message: "Unknown field. Only roleId can be sent to this endpoint." });

export const grantStoreAccessSchema = z
  .object({
    storeId: objectIdField(
      "storeId",
      "Store to assign the user to. Must be active and belong to your organization.",
      "665f1c2e8a4b3c0012ab34ef"
    ),
    roleId: objectIdField(
      "roleId",
      "ID of a STORE-scoped role in your organization (e.g. cashier, store_manager).",
      "665f1c2e8a4b3c0012ab34cd"
    ),
  })
  .strict({ message: "Unknown field. Only storeId and roleId can be sent to this endpoint." });

export const updateStoreAccessSchema = z
  .object({
    roleId: objectIdField(
      "roleId",
      "ID of the STORE-scoped role the user should hold at this store instead.",
      "665f1c2e8a4b3c0012ab34cd"
    ),
  })
  .strict({ message: "Unknown field. Only roleId can be sent to this endpoint." });

export type SetOrgRoleInput = z.infer<typeof setOrgRoleSchema>;
export type GrantStoreAccessInput = z.infer<typeof grantStoreAccessSchema>;
export type UpdateStoreAccessInput = z.infer<typeof updateStoreAccessSchema>;
