import express, { Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env.config";
import requestIdMiddleware from "./middleware/requestId.middleware";
import requestLogger from "./middleware/requestLogger.middleware";
import v1Router from "./routes/v1";
import swaggerUi from "swagger-ui-express";
import { generateOpenApiDocument } from "./config/openapi.config";
import {
  notFoundHandler,
  globalErrorHandler,
} from "./middleware/errorHandler.middleware";

// Initialize the Express application
const app = express();

// ===== Request Context (must be first) =====
app.use(requestIdMiddleware);

// ===== Body Parsers =====
// Body parsers: parse incoming JSON & urlencoded payloads
// Limit payloads to 10mb to protect against malicious massive payloads (Denial of Service)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ===== Request Logging =====
// Request logging middleware - piped to Winston (early registration is crucial to profile all requests)
app.use(requestLogger);

// ===== Other Global Middleware =====
// Secure the application by setting various HTTP headers via Helmet
app.use(helmet());

// Enable CORS with configurations validated in our env
app.use(
  cors({
    origin: env.CORS_ORIGIN === "*" ? "*" : env.CORS_ORIGIN.split(","),
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    credentials: true,
  })
);

// ===== Routes =====

// Liveness health-check endpoint (vital for Docker, Kubernetes, AWS, or Uptime monitors)
// This is outside the versioned prefix for infrastructure/load-balancer use.
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: env.NODE_ENV,
  });
});

// Versioned API routes
// The API_VERSION environment variable allows v2 to be mounted alongside v1 in the future without breaking existing clients.
app.use(`/api/${env.API_VERSION}`, v1Router);

// ===== API Documentation (Swagger UI) =====
// Mounted ONLY outside production by default (docs are not exposed publicly in prod
// unless explicitly decided otherwise). The spec is generated from the Zod validators/registry.
if (env.NODE_ENV !== "production") {
  const openApiDocument = generateOpenApiDocument();
  // Raw spec: import into Postman/Insomnia/codegen tools
  app.get("/api-docs.json", (_req: Request, res: Response) => {
    res.status(200).json(openApiDocument);
  });
  // Interactive UI
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
}

// ===== Error Handling (must be last) =====

// 404 Fallback Route Handler - intercepts unmatched HTTP endpoints and forwards to globalErrorHandler
app.use(notFoundHandler);

// Centralized Global Error Handler Middleware - processes, logs, and responds to all thrown errors
app.use(globalErrorHandler);

export default app;
