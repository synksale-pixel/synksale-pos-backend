/**
 * Class representing a standardized successful HTTP API response wrapper.
 * Provides consistent response formats across all controller endpoints.
 *
 * Uses a generic type parameter `T` to preserve the type safety of the returned data payload.
 */
export class ApiResponse<T = unknown> {
  public readonly statusCode: number;
  public readonly data: T;
  public readonly message: string;
  public readonly success: boolean;

  /**
   * @param statusCode The HTTP status code of the response (e.g., 200, 201)
   * @param data The typed data payload returned to the client
   * @param message Friendly descriptive confirmation message (defaults to "Success")
   */
  constructor(statusCode: number, data: T, message: string = "Success") {
    this.statusCode = statusCode;
    this.data = data;
    this.message = message;

    // Automatically flags true for any standard HTTP success status code
    this.success = statusCode < 400;
  }
}
