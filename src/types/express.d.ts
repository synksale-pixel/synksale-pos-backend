/**
 * Purpose: Declaration merging to extend the Express Request namespace.
 * Adds custom attributes (like id) to standard Express request objects.
 */

declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

export {};
