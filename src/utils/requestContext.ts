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
