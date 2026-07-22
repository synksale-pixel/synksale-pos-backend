import express, { Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env.config";
import requestLogger from "./middleware/requestLogger.middleware";
import {
  notFoundHandler,
  globalErrorHandler,
} from "./middleware/errorHandler.middleware";

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

// Request logging middleware - piped to Winston (early registration is crucial to profile all requests)
app.use(requestLogger);

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

// ===== Error Handling (MUST be registered last) =====

// 404 Fallback Route Handler - intercepts unmatched HTTP endpoints and forwards to globalErrorHandler
app.use(notFoundHandler);

// Centralized Global Error Handler Middleware - processes, logs, and responds to all thrown errors
app.use(globalErrorHandler);

export default app;
