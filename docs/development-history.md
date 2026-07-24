# SyncSale POS Backend - Development History & Architecture Log

This document tracks the initial setup phase, completed features, structural decisions, and configuration standards established in the codebase so far.

---

## 📅 Project Setup & Configuration

- **TypeScript Foundation:** Initialized typescript compiler using standard strict settings (`tsconfig.json`) targeting `ES2022` with CommonJS module generation.
- **Path Aliasing:** Configured `@/*` mapped to `src/*` to avoid deeply nested relative imports (e.g., `import X from "../../../utils"`).
- **Formatters and Linters:** Configured ESLint (`eslint.config.mts`) and Prettier (`.prettierrc`, `.prettierignore`) for codebase consistency.

---

## ⚙️ Environment Configuration (`src/config/env.config.ts`)

- **Strict Validation (Zod):** Implemented schema-based validation for all incoming `process.env` properties. The server will fail to startup and output detailed error logs if variables are missing or misconfigured.
- **Dynamic Loading:** Loads environment files based on the active `NODE_ENV`:
  - `test` ➡️ `.env.test.local`
  - `development` ➡️ `.env.development.local`
  - `production` ➡️ `.env`
- **Key Parameters Validated:**
  - `PORT`, `NODE_ENV` (Enforced enum: development/production/test)
  - `MONGO_URI` (Must be a valid URL format)
  - `JWT_ACCESS_SECRET` & `JWT_REFRESH_SECRET` (Strict minimum length of 32 characters enforced; must be different secrets)
  - `CORS_ORIGIN`, `API_VERSION`
  - Feature Flags (`FEATURE_MULTI_CURRENCY`, `FEATURE_ADVANCED_TAX_RULES`)
  - Logging level (`LOG_LEVEL`, `LOG_TO_FILE`)

---

## 🗄️ Database Layer (`src/config/db.config.ts` & `src/models/`)

- **Mongoose MongoDB Connection:**
  - Configured listeners on the connection pool (`connected`, `error`, `disconnected`).
  - Connection options tailored for POS environments: `autoIndex: false` in production (prevents latency spikes due to index rebuilds), `serverSelectionTimeoutMS: 5000` (fail fast if DB is down), and `socketTimeoutMS: 45000` (keeps sockets alive).
- **User Model (`src/models/user.model.ts`):**
  - **Roles Enum (`UserRole`):** Defines `SUPER_ADMIN`, `STORE_ADMIN`, `MANAGER`, `CASHIER`, `INVENTORY_MANAGER`, and `ACCOUNTANT`.
  - **PIN Password Format:** Custom Mongoose validation enforces numeric-only passwords (PIN style) for `SUPER_ADMIN` and `STORE_ADMIN` roles, while allowing standard passwords for cashiers/managers.
  - **Security Hooks:** Pre-save middleware automatically hashes passwords using `bcryptjs`.
  - **JWT Generation Instance Methods:**
    - `generateAccessToken()`: Encodes `id`, `email`, `role`, and `storeId` (for multi-tenant scoping if not SUPER_ADMIN).
    - `generateRefreshToken()`: Encodes user `id` for session renewal.
  - **Output Scoping:** Automatic JSON serialization transform strips sensitive fields like `password` and `__v` from results.

---

## 🪵 Structured Logging & Context Correlation

- **Correlation ID Middleware (`src/middleware/requestId.middleware.ts`):**
  - Generates or forwards a unique `X-Request-Id` UUID for each incoming request.
  - Stores this ID inside a Node `AsyncLocalStorage` context block (`src/utils/requestContext.ts`).
- **Winston Custom Logger (`src/config/logger.config.ts`):**
  - Reads active request contexts dynamically and injects the `requestId` into all Winston metadata logs.
  - **Development Mode:** Outputs human-readable, colorized terminal logs detailing timestamp, log level, request ID (if active), messages, and stack traces.
  - **Production Mode:** Outputs structured single-line JSON logs to feed aggregation tools (like Datadog/ELK).
  - **File Rotation Logging:** If `LOG_TO_FILE=true`, records `combined.log` (10MB limit) and `error.log` (5MB limit) in the local `/logs` directory, retaining the 5 most recent files.
- **Morgan HTTP Traffic Logger (`src/middleware/requestLogger.middleware.ts`):**
  - Intercepts incoming HTTP requests and pipes access descriptions (method, path, status code, response time) directly through Winston.

---

## 🛡️ Security & Route Architecture (`src/app.ts`)

- **HTTP Protection:** Embedded **Helmet** to block common injection vectors by configuring security headers.
- **CORS Config:** Configured dynamic origin mapping checking against the validated environment origins.
- **Payload Limits:** Restricted JSON and urlencoded body parsers to `10mb` max limits to prevent buffer overload DoS attacks.
- **Barrel Routing Structure:** Versioned endpoint management via `src/routes/v1/index.ts`.
- **Infrastructure Health Checks:** A non-versioned, lightweight `/health` route reporting uptime, environment, and system diagnostics for monitors/load balancers.

---

## ⚠️ Centralized Error Handling (`src/middleware/errorHandler.middleware.ts`)

- **Standardized Utilities (`src/utils/`):**
  - `ApiError`: Extends base Error to track HTTP status codes, validation errors, and custom messages.
  - `ApiResponse`: Utility for wrapping JSON payloads consistently (`statusCode`, `data`, `message`, `success`).
  - `asyncHandler`: Eliminates boilerplated `try/catch` wrappers around Express controllers.
- **Failsafe Global Handler:**
  - Catches route failures, JSON parsing crashes, mongoose cast/validation issues, and duplicate key errors.
  - Sanitizes stack trace information so development details are not leaked in production mode.
