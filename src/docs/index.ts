/**
 * Purpose: Loads every route-documentation file so they register on the shared registry.
 * Add new domain files here (src/docs/<domain>.openapi.ts) when documenting new routes.
 */
import "./health.openapi";
import "./tenantAuth.openapi";
import "./userInvite.openapi";
import "./user.openapi";
import "./role.openapi";
import "./store.openapi";
import "./organization.openapi";
import "./taxRate.openapi";
import "./platformAuth.openapi";
import "./platformOrganization.openapi";
