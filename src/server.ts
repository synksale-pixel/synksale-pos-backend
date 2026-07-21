import http from "http";
import app from "./app";
import { env } from "./config/env.config";
import { connectDB, disconnectDB } from "./config/db.config";

// Global HTTP server instance reference
let server: http.Server;

/**
 * Boots the application: connects to databases and starts listening for HTTP requests.
 */
async function startServer(): Promise<void> {
  // Ensure database connection is established before starting server
  await connectDB();

  // Create native HTTP Server instance wrapping the Express application
  server = http.createServer(app);

  // Bind the server to the configured network port
  server.listen(env.PORT, () => {
    console.log(
      `🚀 Server started on port ${env.PORT} in [${env.NODE_ENV}] mode.`
    );
    console.log(`🔗 Health Check: http://127.0.0.1:${env.PORT}/health`);
  });

  /**
   * Handle unhandled promise rejections globally.
   * Prevents silent failures of async/await calls.
   */
  process.on("unhandledRejection", (reason: unknown) => {
    console.error(
      "🔥 CRITICAL: Unhandled Promise Rejection detected! Initiating shutdown..."
    );
    console.error(reason);

    // Shut down server gracefully with exit code 1 (error state)
    gracefulShutdown(1);
  });

  /**
   * Handle uncaught synchronous exceptions globally.
   * Prevents running in an corrupted memory state.
   */
  process.on("uncaughtException", (error: Error) => {
    console.error(
      "🔥 CRITICAL: Uncaught Exception thrown! Initiating shutdown..."
    );
    console.error(error.name, error.message);
    console.error(error.stack);

    // Shut down server gracefully with exit code 1 (error state)
    gracefulShutdown(1);
  });
}

/**
 * Gracefully terminates server and database connections.
 * Ensures active HTTP requests and database sockets finish their cycle.
 *
 * @param exitCode Number indicating success (0) or error (1) termination code.
 */
async function gracefulShutdown(exitCode: number = 0): Promise<void> {
  console.log("🔄 Graceful shutdown sequence initialized...");

  // Set a fallback hard timeout limit to force exit if connections hang
  const forceExitTimeout = setTimeout(() => {
    console.error(
      "⏳ Forceful shutdown: Graceful close timeout exceeded. Killing process."
    );
    process.exit(1);
  }, 10000); // 10-second threshold

  if (server) {
    // Instruct the server to stop accepting new requests and close existing ones
    server.close(async (err) => {
      if (err) {
        console.error("❌ Error during HTTP server close:", err);
      } else {
        console.log(
          "🛑 HTTP server successfully stopped accepting new connections."
        );
      }

      // Close the database connection pool cleanly
      await disconnectDB();

      // Clear the timeout and exit process
      clearTimeout(forceExitTimeout);
      console.log(
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
  console.log("📥 Received SIGTERM signal (process termination).");
  gracefulShutdown(0);
});

process.on("SIGINT", () => {
  console.log("📥 Received SIGINT signal (Ctrl+C).");
  gracefulShutdown(0);
});

// Execute initialization
startServer();
