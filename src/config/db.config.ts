import mongoose from "mongoose";
import { env } from "./env.config";

/**
 * Establish connection to the MongoDB cluster.
 * Uses the URI verified and exported by env.config.ts.
 */
export async function connectDB(): Promise<void> {
  // Set up connection lifecycle listeners
  mongoose.connection.on("connected", () => {
    console.log("✅ MongoDB connected successfully.");
  });

  mongoose.connection.on("error", (err) => {
    console.error(`❌ MongoDB connection error: ${err.message}`);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn(
      "⚠️ MongoDB connection lost. Mongoose will attempt automatic reconnection."
    );
  });

  try {
    // Establish connection to MongoDB
    await mongoose.connect(env.MONGO_URI, {
      /**
       * In production, automatic index building can degrade performance.
       * Indexes should be managed via migration scripts or DB administration.
       */
      autoIndex: env.NODE_ENV !== "production",

      /**
       * Fail fast (5s selection timeout) rather than holding request sockets open
       * indefinitely if the DB cluster is unreachable.
       */
      serverSelectionTimeoutMS: 5000,

      /**
       * Keep sockets alive to avoid TCP handshake overhead on high traffic POS servers.
       */
      socketTimeoutMS: 45000,
    });
  } catch (error) {
    console.error(
      "❌ Critical: Failed to establish initial database connection:",
      error
    );

    // Server cannot start without database connection. Terminate execution.
    process.exit(1);
  }
}

/**
 * Closes the active MongoDB connection.
 * Essential for graceful shutdown to ensure all pending operations are completed
 * before the process exits.
 */
export async function disconnectDB(): Promise<void> {
  try {
    await mongoose.disconnect();
    console.log("🔌 MongoDB connection closed successfully.");
  } catch (error) {
    console.error("❌ Error during database disconnect:", error);
  }
}
