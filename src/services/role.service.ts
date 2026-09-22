/**
 * Purpose: Role Service (read side).
 * Lists the roles defined in an organization so administrators can pick a roleId when inviting
 * a user or changing an assignment. Without this, the invite endpoint is unusable from a
 * client: it requires a roleId and nothing else exposes one.
 *
 * Role creation/editing (role:manage) is deliberately not here yet — this file is the minimum
 * needed to make the staffing endpoints usable.
 */

import { Role, IRole } from "../models/role.model";
import { PERMISSION_CATALOG } from "../config/permissions.catalog";

export interface ListRolesInput {
  scope?: "organization" | "store";
}

/**
 * Returns every non-deleted role belonging to the organization, organization-scoped first so
 * the more privileged roles are at the top of a picker.
 */
export async function listRoles(
  organizationId: string,
  input: ListRolesInput = {}
): Promise<IRole[]> {
  const filter: Record<string, unknown> = { organizationId };
  if (input.scope) {
    filter.scope = input.scope;
  }

  return Role.find(filter).sort({ scope: 1, name: 1 });
}

/**
 * Returns the fixed permission catalog (the vocabulary of permissions the system understands).
 * Static data, identical for every organization — useful for labelling permission keys in a UI.
 */
export function listPermissionCatalog() {
  return PERMISSION_CATALOG;
}
