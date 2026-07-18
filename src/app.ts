/* eslint-disable @typescript-eslint/no-explicit-any */
import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env.config";
import { ApiError } from "./utils";

// Initialize the Express application
const app = express();

/**
 * Global Middlewares
 */

// Secure the application by setting various HTTP headers via Helmet
app.use(helmet());

// Enable CORS with configurations validated in our env
app.use(
  cors({
    origin: env.CORS_ORIGIN === "*" ? "*" : env.CORS_ORIGIN.split(","),
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Body parsers: parse incoming JSON & urlencoded payloads
// Limit payloads to 10mb to protect against malicious massive payloads (Denial of Service)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/**
 * Core Application Routes
 */

// Liveness health-check endpoint (vital for Docker, Kubernetes, AWS, or Uptime monitors)
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: env.NODE_ENV,
  });
});

/**
 * 404 Fallback Route Handler
 * Intercepts requests that do not match any defined HTTP endpoint
 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: {
      message: "The requested API endpoint was not found on this server.",
      code: "API_ENDPOINT_NOT_FOUND",
    },
  });
});

/**
 * Centralized Global Error Handler Middleware
 * Catches all asynchronous and synchronous unhandled exceptions thrown across routes.
 */
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // Log the full error internally for server analysis
  console.error("🔥 Critical App Error:", err);

  // Handle custom ApiError instances
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: err.success,
      statusCode: err.statusCode,
      message: err.message,
      errors: err.errors,
      // Do not leak stack traces in production to mitigate system footprint exposure
      ...(env.NODE_ENV === "development" && { stack: err.stack }),
    });
  }

  // Handle generic system/npm errors
  const statusCode = (err as any).statusCode || 500;
  const message = err.message || "A critical server error occurred.";

  return res.status(statusCode).json({
    success: false,
    error: {
      message,
      code: (err as any).code || "INTERNAL_SERVER_ERROR",
      // Do not leak stack traces in production to mitigate system footprint exposure
      ...(env.NODE_ENV === "development" && { stack: err.stack }),
    },
  });
});

export default app;
