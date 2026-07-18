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
}
