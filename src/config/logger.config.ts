/**
 * Purpose: Configuration file for the application-wide Winston logger.
 * Configures structured JSON logs for production (supporting aggregation)
 * and colorized human-readable logs for development, with file rotation.
 */

import winston from "winston";
import path from "path";
import { env } from "./env.config";
import { getRequestContext } from "../utils";

// Define standard npm log levels to ensure consistency across environments
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Winston format to dynamically inject the request ID from AsyncLocalStorage context into log metadata
const addRequestId = winston.format((info) => {
  if (!info.requestId) {
    const context = getRequestContext();
    if (context?.requestId) {
      info.requestId = context.requestId;
    }
  }
  return info;
});

/**
 * Format for development environments:
 * - Colorized for terminal visibility.
 * - Human-readable timestamp format.
 * - Clean text formatting showcasing the message and optional metadata.
 */
const devFormat = winston.format.combine(
  addRequestId(),
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }), // Automatically extracts stack trace from Error objects
  winston.format.printf(
    ({ timestamp, level, message, stack, requestId, ...metadata }) => {
      let logMessage = `[${timestamp}] [${level}]`;
      if (requestId) {
        logMessage += ` [req-id: ${requestId}]`;
      }
      logMessage += `: ${message}`;
      if (stack) {
        logMessage += `\nStack Trace:\n${stack}`;
      } else if (Object.keys(metadata).length > 0) {
        logMessage += ` | Metadata: ${JSON.stringify(metadata)}`;
      }
      return logMessage;
    }
  )
);

/**
 * Format for production environments:
 * - Standardized JSON format (structured logging) for log aggregators (e.g. ELK, Datadog).
 * - Single-line log entries for easier grepping/parsing.
 * - ISO timestamp format.
 */
const prodFormat = winston.format.combine(
  addRequestId(),
  winston.format.timestamp(),
  winston.format.errors({ stack: true }), // Ensures errors logged in production capture full stack traces
  winston.format.json()
);

// Determine active log format based on NODE_ENV configuration
const format = env.NODE_ENV === "production" ? prodFormat : devFormat;

// Define default transports (Console is always active)
const transports: winston.transport[] = [
  new winston.transports.Console({
    handleExceptions: true, // Auto-catch and log uncaught exceptions on console
  }),
];

// Add file transports in production/configured environments to persist logs locally
if (env.LOG_TO_FILE) {
  // Directory path where logs will be stored
  const logDir = path.join(process.cwd(), "logs");

  /**
   * File Transport for Error logs only:
   * - Restricts logs strictly to level 'error' to isolate application crashes/failures.
   * - Limits file sizes to 5MB (maxsize) and retains a maximum of 5 files (maxFiles)
   *   to prevent the disk from filling up.
   */
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, "error.log"),
      level: "error",
      format: prodFormat, // Always use JSON for file logs to keep them structured
      maxsize: 5 * 1024 * 1024, // 5MB limit
      maxFiles: 5, // Keep up to 5 rotated error log files
      handleExceptions: true,
    })
  );

  /**
   * File Transport for Combined logs:
   * - Captures all log events up to the configured LOG_LEVEL.
   * - Limits file sizes to 10MB and retains a maximum of 5 files for disk protection.
   */
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, "combined.log"),
      format: prodFormat, // Always use JSON for file logs to keep them structured
      maxsize: 10 * 1024 * 1024, // 10MB limit
      maxFiles: 5, // Keep up to 5 rotated combined log files
    })
  );
}

/**
 * Singleton Logger Instance
 * Uses levels matching npm standards and env-configured level (e.g. debug vs info).
 */
export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  levels,
  format,
  transports,
  exitOnError: false, // Ensure the logger doesn't shut down the process itself
});

export default logger;
