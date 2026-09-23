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
  | "user:read"
  | "user:invite"
  | "user:manage"
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
    key: "user:read",
    label: "View Staff Members",
    category: "Admin",
    // Store managers read the roster of their own store, so this is meaningful at store scope.
    minScope: "store",
  },
  {
    key: "user:invite",
    label: "Invite Staff Members",
    category: "Admin",
    // A store manager hiring a cashier for their own store is normal retail; the privilege
    // ceiling (canGrantRole) still prevents them granting a role above their own.
    minScope: "store",
  },
  {
    key: "user:manage",
    label: "Activate/Deactivate Staff Members",
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

/** Looks up a permission's catalog entry. */
export function getPermissionDefinition(
  key: string
): PermissionDefinition | undefined {
  return PERMISSION_CATALOG.find((definition) => definition.key === key);
}

/** Scope hierarchy, highest first. Shared by the catalog and the privilege checks. */
export const SCOPE_RANK: Record<"platform" | "organization" | "store", number> = {
  platform: 3,
  organization: 2,
  store: 1,
};

/**
 * True when a permission may live in a role of the given scope.
 *
 * `minScope` is the LOWEST scope at which a permission is meaningful, so a role may hold any
 * permission at or below its own scope. An organization role can hold `sale:create`
 * (minScope "store") because an org admin does everything; a store role cannot hold
 * `report:view_org` (minScope "organization") because a single store has no view of the
 * whole organization.
 *
 * Until now `minScope` was decorative — nothing read it except the org_admin seed filter.
 */
export function permissionFitsScope(
  roleScope: "platform" | "organization" | "store",
  key: string
): boolean {
  const definition = getPermissionDefinition(key);
  if (!definition) {
    return false;
  }
  return SCOPE_RANK[roleScope] >= SCOPE_RANK[definition.minScope];
}
