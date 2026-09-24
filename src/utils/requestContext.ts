/**
 * Purpose: Provides a thread-safe request context store using AsyncLocalStorage.
 * Why AsyncLocalStorage: It allows us to carry transaction/request state (like requestId, and later tenant or user context)
 * across asynchronous execution paths without explicitly passing a request object or requestId argument down the call stack.
 * This simplifies deep-level logging and error reporting.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Interface representing the structured context stored for each active request.
 */
export interface RequestContext {
  requestId: string;
  organizationId?: string;
  storeId?: string;
  userId?: string;
}

// Global AsyncLocalStorage instance to track async context
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Helper function to safely fetch the current request context.
 * Returns undefined if invoked outside an active request context (e.g., during application startup).
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Runs `fn` with the request context's storeId swapped for `storeId`, keeping everything else.
 * The tenantScopePlugin rejects store-scoped reads and writes that name a store other than the
 * context's, so an operation that legitimately touches a second store (e.g. the destination of
 * an inventory transfer) must run inside this. Services should call it through
 * runInOrganizationStore() (store.service.ts), which first verifies the store belongs to the
 * caller's organization; this function does not.
 *
 * It requires an organization in the current context. Without one the plugin engages no
 * scoping at all, so a background job must establish its organization context first.
 *
 * The result is awaited inside the swapped context: a Mongoose Query only executes when
 * awaited, so one returned un-awaited would otherwise run under the original store.
 */
export function runWithStoreContext<T>(
  storeId: string,
  fn: () => T | PromiseLike<T>
): Promise<T> {
  const current = getRequestContext();
  if (!current?.organizationId) {
    throw new Error(
      "runWithStoreContext requires an organization in the request context."
    );
  }
  return requestContextStorage.run(
    { ...current, storeId },
    async () => await fn()
  );
}
