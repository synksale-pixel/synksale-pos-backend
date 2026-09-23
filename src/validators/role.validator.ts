/**
 * Purpose: Role Validators.
 * Zod schemas for creating and updating an organization's roles.
 *
 * `slug` and `scope` are deliberately absent from the update schema: slug is derived from the
 * name and never accepted from a client, and scope is immutable after creation (changing it
 * would silently grant organization-wide powers to everyone already holding the role).
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";

const nameField = z
  .string()
  .trim()
  .min(2, { message: "Role name must be at least 2 characters long." })
  .max(50, { message: "Role name must be at most 50 characters long." })
  .openapi({
    description:
      "Display name. The slug is derived from it automatically and cannot be set or changed.",
    example: "Shift Supervisor",
  });

const permissionsField = z
  .array(z.string())
  .min(1, { message: "A role must grant at least one permission." })
  .openapi({
    description:
      "Permission keys this role grants. Must exist in the catalog (GET /roles/permissions), must be valid at the role's scope, and must all be permissions you already hold yourself.",
    example: ["sale:create", "sale:refund", "product:read"],
  });

export const createRoleSchema = z
  .object({
    name: nameField,
    scope: z.enum(["organization", "store"]).openapi({
      description:
        "`organization` roles apply across every store (assigned via PATCH /users/:userId/org-role). `store` roles apply at one store (assigned via the store-access endpoints). Immutable after creation.",
      example: "store",
    }),
    permissions: permissionsField,
  })
  .strict({
    message:
      "Unknown or immutable field. Only name, scope and permissions can be sent when creating a role.",
  });

export const updateRoleSchema = z
  .object({
    name: nameField.optional(),
    permissions: permissionsField.optional(),
  })
  .strict({
    message:
      "Unknown or immutable field. Only name and permissions can be updated; scope and slug are fixed at creation.",
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field (name, permissions) must be provided.",
  });

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
