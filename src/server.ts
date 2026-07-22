/**
 * Purpose: Application server entry point.
 * Configures the HTTP server, database connection, lifecycle signals,
 * and global process event listeners (uncaught exceptions and unhandled rejections).
 */

import http from "http";
import app from "./app";
import { env } from "./config/env.config";
import { connectDB, disconnectDB } from "./config/db.config";
import logger from "./config/logger.config";

// Global HTTP server instance reference
let server: http.Server;

/**
 * Boots the application: connects to databases and starts listening for HTTP requests.
 */
async function startServer(): Promise<void> {
  try {
    // Ensure database connection is established before starting server
    await connectDB();

    // Create native HTTP Server instance wrapping the Express application
    server = http.createServer(app);

    // Bind the server to the configured network port
    server.listen(env.PORT, () => {
      logger.info(
        `🚀 Server started on port ${env.PORT} in [${env.NODE_ENV}] mode.`
      );
      logger.info(`🔗 Health Check: http://127.0.0.1:${env.PORT}/health`);
    });
  } catch (error) {
    logger.error("Failed to start server due to connection error", { error });
    await gracefulShutdown(1);
  }
}

/**
 * Gracefully terminates server and database connections.
 * Ensures active HTTP requests and database sockets finish their cycle.
 *
 * @param exitCode Number indicating success (0) or error (1) termination code.
 */
async function gracefulShutdown(exitCode: number = 0): Promise<void> {
  logger.info("🔄 Graceful shutdown sequence initialized...");

  // Set a fallback hard timeout limit to force exit if connections hang
  const forceExitTimeout = setTimeout(() => {
    logger.error(
      "⏳ Forceful shutdown: Graceful close timeout exceeded. Killing process."
    );
    process.exit(1);
  }, 10000); // 10-second threshold

  if (server) {
    // Instruct the server to stop accepting new requests and close existing ones
    server.close(async (err) => {
      if (err) {
        logger.error("❌ Error during HTTP server close:", err);
      } else {
        logger.info(
          "🛑 HTTP server successfully stopped accepting new connections."
        );
      }

      // Close the database connection pool cleanly
      await disconnectDB();

      // Clear the timeout and exit process
      clearTimeout(forceExitTimeout);
      logger.info(
        `👋 Server shutdown complete. Goodbye! [Exit Code: ${exitCode}]`
      );
      process.exit(exitCode);
    });
  } else {
    // If server was never initialized, disconnect DB and exit immediately
    await disconnectDB();
    clearTimeout(forceExitTimeout);
    process.exit(exitCode);
  }
}

// Intercept system termination signals
process.on("SIGTERM", () => {
  logger.info("📥 Received SIGTERM signal (process termination).");
  gracefulShutdown(0);
});

process.on("SIGINT", () => {
  logger.info("📥 Received SIGINT signal (Ctrl+C).");
  gracefulShutdown(0);
});

/**
 * Handle unhandled promise rejections globally.
 * Prevents silent failures of async/await calls.
 */
process.on("unhandledRejection", (reason: unknown) => {
  logger.error(
    "🔥 CRITICAL: Unhandled Promise Rejection detected! Initiating shutdown...",
    { error: reason }
  );

  /**
   * Node.js documentation explicitly advises exiting the process upon uncaught exceptions
   * and unhandled rejections. The application is now in an undefined/corrupted state,
   * meaning continuing to run could result in memory leaks, socket locks, or corrupted data.
   */
  gracefulShutdown(1);
});

/**
 * Handle uncaught synchronous exceptions globally.
 * Prevents running in a corrupted memory state.
 */
process.on("uncaughtException", (error: Error) => {
  logger.error(
    "🔥 CRITICAL: Uncaught Exception thrown! Initiating shutdown...",
    { error }
  );

  /**
   * Node.js documentation explicitly advises exiting the process upon uncaught exceptions.
   * Attempting to recover from an uncaught exception is highly risky because the application
   * is in an undefined state. We perform a clean graceful shutdown to close active sockets
   * and release database pools before termination.
   */
  gracefulShutdown(1);
});

// Execute initialization
startServer();
