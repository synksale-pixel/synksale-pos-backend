/**
 * Purpose: Middleware that intercepts incoming HTTP requests and logs them.
 * Utilizes Morgan for request profiling and pipes output to the Winston logger.
 */

import { Request, Response } from "express";
import morgan from "morgan";
import logger from "../config/logger.config";

/**
 * Interface representing the structured metadata extracted from each HTTP request.
 */
interface RequestLogMetadata {
  method: string | undefined;
  url: string | undefined;
  status: number;
  responseTime: number;
  userId: string | undefined;
  storeId: string | undefined;
  ip: string | undefined;
}

/**
 * Morgan Middleware Stream Integration:
 * - Directs morgan logs away from standard output and into our Winston logger.
 * - Formats logs as a JSON string within Morgan, which is parsed and forwarded
 *   to Winston with the 'http' log level for consistent structured logging.
 */
export const requestLogger = morgan(
  (tokens, req: Request, res: Response): string => {
    // Cast request object to access potential properties injected by authentication middlewares
    const extendedReq = req as Request & {
      user?: { id?: string; storeId?: string };
      userId?: string;
      storeId?: string;
    };

    const metadata: RequestLogMetadata = {
      method: tokens.method(req, res),
      url: tokens.url(req, res),
      status: Number(tokens.status(req, res)) || 0,
      responseTime: Number(tokens["response-time"](req, res)) || 0,
      // Safely check both req.user and req.userId/req.storeId contexts
      userId: extendedReq.user?.id || extendedReq.userId || undefined,
      storeId: extendedReq.user?.storeId || extendedReq.storeId || undefined,
      ip: req.ip || req.socket.remoteAddress || undefined,
    };

    return JSON.stringify(metadata);
  },
  {
    stream: {
      write: (message: string): void => {
        try {
          // Parse the JSON serialized log data generated in the formatter above
          const data: RequestLogMetadata = JSON.parse(message);

          // Build a readable message for Winston
          const logMsg = `${data.method} ${data.url} ${data.status} - ${data.responseTime}ms`;

          // Pass parsed fields as structured metadata alongside the message at the 'http' level
          logger.http(logMsg, data);
        } catch (error) {
          // In case of parsing failures, fall back to basic logging
          logger.error("Failed to parse request log entry from morgan stream", {
            error,
            rawMessage: message,
          });
        }
      },
    },
  }
);

export default requestLogger;
