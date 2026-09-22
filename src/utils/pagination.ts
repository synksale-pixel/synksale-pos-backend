/**
 * Purpose: Shared pagination helpers.
 * The same page/limit/total/totalPages block was being hand-rolled in every list service.
 * Centralising it keeps the envelope identical across endpoints and keeps the clamping rules
 * (positive page, limit capped at MAX_PAGE_LIMIT) in one place.
 */

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface PaginationInput {
  page?: number;
  limit?: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Normalises raw page/limit input into values safe to pass to skip()/limit().
 * Invalid or non-positive values fall back to the defaults rather than erroring, matching the
 * existing list endpoints' lenient behaviour.
 */
export function resolvePaging(input: PaginationInput): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = input.page && input.page > 0 ? Math.floor(input.page) : DEFAULT_PAGE;
  const limit =
    input.limit && input.limit > 0
      ? Math.min(Math.floor(input.limit), MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;

  return { page, limit, skip: (page - 1) * limit };
}

/** Builds the pagination block returned alongside every paginated list payload. */
export function buildPaginationMeta(
  page: number,
  limit: number,
  total: number
): PaginationMeta {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}
