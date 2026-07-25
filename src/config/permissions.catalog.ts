/**
 * Purpose: Defines the fixed vocabulary of permissions (Permission Catalog) in the system.
 * Adding a permission here means the actual authorization check must exist in the code somewhere.
 * This file does NOT decide who gets what permissions, but defines what permissions are possible.
 */

// Union type of all valid permissions in the system, grouped by logical category.
export type PermissionKey =
  // Sales
  | "sale:create"
  | "sale:void"
  | "sale:refund"
  // Catalog
  | "product:create"
  | "product:read"
  | "product:update"
  | "product:delete"
  // Inventory
  | "inventory:adjust"
  | "inventory:transfer"
  // Reports
  | "report:view_store"
  | "report:view_org"
  // Admin
  | "user:invite"
  | "user:manage_roles"
  | "role:manage"
  | "store:create"
  | "store:configure"
  | "organization:configure";

export interface PermissionDefinition {
  key: PermissionKey;
  label: string;
  category: string;
  minScope: "platform" | "organization" | "store";
}

/**
 * The system permission catalog. Each entry has:
 * - key: The unique permission code used in authorize(...) checks.
 * - label: A human-readable short description of the permission.
 * - category: Logical grouping for UI/management.
 * - minScope: The minimum scope level at which this permission makes sense.
 */
export const PERMISSION_CATALOG: PermissionDefinition[] = [
  // ===== Sales =====
  {
    key: "sale:create",
    label: "Create Sales",
    category: "Sales",
    minScope: "store",
  },
  {
    key: "sale:void",
    label: "Void Sales",
    category: "Sales",
    minScope: "store",
  },
  {
    key: "sale:refund",
    label: "Process Refunds",
    category: "Sales",
    minScope: "store",
  },

  // ===== Catalog =====
  {
    key: "product:create",
    label: "Create Products",
    category: "Catalog",
    minScope: "organization",
  },
  {
    key: "product:read",
    label: "View Products",
    category: "Catalog",
    minScope: "store",
  },
  {
    key: "product:update",
    label: "Update Products",
    category: "Catalog",
    minScope: "organization",
  },
  {
    key: "product:delete",
    label: "Delete Products",
    category: "Catalog",
    minScope: "organization",
  },

  // ===== Inventory =====
  {
    key: "inventory:adjust",
    label: "Adjust Inventory Levels",
    category: "Inventory",
    minScope: "store",
  },
  {
    key: "inventory:transfer",
    label: "Transfer Inventory Between Stores",
    category: "Inventory",
    minScope: "organization",
  },

  // ===== Reports =====
  {
    key: "report:view_store",
    label: "View Store-level Reports",
    category: "Reports",
    minScope: "store",
  },
  {
    key: "report:view_org",
    label: "View Organization-level Reports",
    category: "Reports",
    minScope: "organization",
  },

  // ===== Admin =====
  {
    key: "user:invite",
    label: "Invite Staff Members",
    category: "Admin",
    minScope: "organization",
  },
  {
    key: "user:manage_roles",
    label: "Manage User Role Assignments",
    category: "Admin",
    minScope: "organization",
  },
  {
    key: "role:manage",
    label: "Create/Modify Custom Roles",
    category: "Admin",
    minScope: "organization",
  },
  {
    key: "store:create",
    label: "Create New Stores",
    category: "Admin",
    minScope: "organization",
  },
  {
    key: "store:configure",
    label: "Modify Store Configurations",
    category: "Admin",
    minScope: "store",
  },
  {
    key: "organization:configure",
    label: "Modify Organization Configuration",
    category: "Admin",
    minScope: "organization",
  },
];

/**
 * Type guard helper to check if a string key is a valid PermissionKey.
 */
export function isValidPermission(key: string): key is PermissionKey {
  return PERMISSION_CATALOG.some((definition) => definition.key === key);
}
