/**
 * A single structured error detail. `code` is a stable machine-readable identifier the frontend
 * can switch on (e.g. "TOO_MANY_DECIMALS"); `meta` carries values for the UI message.
 */
export interface ApiErrorDetail {
  field?: string;
  code?: string;
  message?: string;
  meta?: Record<string, unknown>;
}

/**
 * Custom application-level error class representing an HTTP API error.
 * Extends the native JavaScript Error class to include HTTP status codes,
 * a success flag (always false), and structured arrays of nested validation or details errors.
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly data: unknown | null;
  public readonly success: boolean;
  public readonly errors: unknown[];
  /** Optional stable error code; omitted from the response when not set. */
  public code?: string;

  /**
   * @param statusCode The HTTP response status code (e.g., 400, 401, 404, 500)
   * @param message Human-readable error explanation (defaults to "Something went wrong")
   * @param errors Nested validation or technical error details (defaults to an empty array)
   * @param stack Optional custom stack trace string
   */
  constructor(
    statusCode: number,
    message: string = "Something went wrong",
    errors: unknown[] = [],
    stack: string = ""
  ) {
    // Invoke base Error constructor to assign message property
    super(message);

    this.statusCode = statusCode;
    this.data = null;
    this.message = message;
    this.success = false;
    this.errors = errors;

    if (stack) {
      this.stack = stack;
    } else {
      // Capture call stack while omitting this constructor from trace logs
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Builds an ApiError carrying a stable error code.
   * @example throw ApiError.coded(409, "TAX_RATE_NAME_TAKEN", "A tax rate named 'VAT' already exists.")
   */
  static coded(
    statusCode: number,
    code: string,
    message: string,
    errors: ApiErrorDetail[] = []
  ): ApiError {
    const error = new ApiError(statusCode, message, errors);
    error.code = code;
    Error.captureStackTrace(error, ApiError.coded);
    return error;
  }
}
