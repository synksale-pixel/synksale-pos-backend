# SyncSale POS Backend

A robust, production-ready REST API backend built with **Node.js**, **Express**, **TypeScript**, and **MongoDB (Mongoose)**, designed specifically for Point of Sale (POS) applications.

---

## 🚀 Features

- **TypeScript & Express**: Modern, strongly-typed routing and middleware architecture.
- **MongoDB & Mongoose Integration**: Production-ready connection configurations, connection pool optimization, and fail-fast selection timeouts.
- **Strict Environment Validation**: Zod-based validation on startup prevents the server from booting with incorrect or missing configurations.
- **Correlated Request Tracking**: Custom middleware dynamically assigns and injects unique request IDs (`X-Request-Id`) across HTTP request contexts using `AsyncLocalStorage`.
- **Structured Logging (Winston + Morgan)**:
  - Colorized, human-readable logging with automatic stack traces for local development.
  - Standardized JSON structured logging in production environments for easy aggregation (ELK, Datadog).
  - Configurable local file rotation for application warnings, errors, and access combined logs.
- **Security Protocols**: Production headers with **Helmet** and configurable environment-aware **CORS** setups.
- **Global Error Handling**: Failsafe error handling middleware capturing all database, request validation, and application errors cleanly.
- **Developer Tooling**: Hot-reloading watch mode via `tsx`, linting with `eslint`, and formatting with `prettier`.

---

## 📂 Project Directory Structure

```text
synksale-pos-backend/
├── dist/                          # Compiled JavaScript distribution output (Git ignored)
├── logs/                          # Locally persisted logs (Git ignored)
├── src/                           # TypeScript Source Code
│   ├── config/                    # Configurations (Database, Environment validation, Winston logger)
│   │   ├── db.config.ts           # Mongoose MongoDB setup
│   │   ├── env.config.ts          # Zod environment validation schema
│   │   └── logger.config.ts       # Winston logging configuration
│   ├── controllers/               # Business logic controllers
│   ├── helpers/                   # Utility helpers for operations
│   ├── middleware/                # Express middleware layers
│   │   ├── errorHandler.middleware.ts   # Centralized error handler
│   │   ├── requestId.middleware.ts      # X-Request-Id / AsyncLocalStorage context injector
│   │   └── requestLogger.middleware.ts  # HTTP traffic log formatter
│   ├── models/                    # Mongoose database models & schemas (e.g. user.model.ts)
│   ├── routes/                    # Express routing files
│   │   └── v1/                    # API v1 routes barrel router
│   │       └── index.ts
│   ├── services/                  # Business/DB query layers
│   ├── types/                     # Shared TypeScript interface and type declarations
│   ├── utils/                     # Generic utility classes (ApiError, ApiResponse, asyncHandler)
│   ├── validators/                # Input validation Zod schemas
│   ├── app.ts                     # Core Express Application initialization & middleware stacking
│   └── server.ts                  # Server entrypoint, database startup, and process lifecycle events
├── .env.development.local         # Development configurations (Git ignored)
├── eslint.config.mts              # ESLint rules
├── package.json                   # Project scripts and dependencies
├── tsconfig.json                  # TypeScript compiler settings
└── README.md                      # Project documentation
```

---

## 🛠️ Prerequisites

Make sure you have the following installed on your machine:
- [Node.js](https://nodejs.org/) (Recommended version: `v20.x` or higher)
- [npm](https://www.npmjs.com/) (usually bundles with Node.js)
- [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) or local MongoDB instance

---

## 🚀 Getting Started

### 1. Clone the Repository
Clone the repository using HTTPS or SSH:
```bash
git clone https://github.com/synksale-pixel/synksale-pos-backend.git
cd synksale-pos-backend
```

### 2. Install Dependencies
Run the command below to install all project dependencies:
```bash
npm install
```

### 3. Environment Setup
The project uses `NODE_ENV` to determine which configuration file to load.
- Production: `.env`
- Development: `.env.development.local`
- Test: `.env.test.local`

Create your environment configuration file in the project root directory. Here is a baseline example of what to place in your `.env.development.local`:

```ini
# Port to run the server on
PORT=3000

# Server environment
NODE_ENV=development

# MongoDB Connection URI
MONGO_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<database_name>?retryWrites=true&w=majority

# CORS allowed origins (Use * or comma-separated URLs)
CORS_ORIGIN=*

# JWT Configuration (Secrets must be at least 32 characters long)
JWT_ACCESS_SECRET=your_super_secret_access_token_key_at_least_32_chars
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_SECRET=your_super_secret_refresh_token_key_at_least_32_chars
JWT_REFRESH_EXPIRY=7d

# API Versioning prefix
API_VERSION=v1

# Feature Flags
FEATURE_MULTI_CURRENCY=false
FEATURE_ADVANCED_TAX_RULES=false

# Logging Setup
LOG_LEVEL=debug
LOG_TO_FILE=false
```

### 4. Running the Project

#### Development (Hot-Reloading)
Runs the server with dynamic watcher capability. Files will be auto-compiled on save:
```bash
npm run dev
```

#### Production Build & Start
Compile the TypeScript code and start the compiled JavaScript distribution:
```bash
# Compile TS to JS
npm run build

# Start the compiled server
npm run start
```

### 5. Linting and Formatting
To keep the codebase compliant with coding styles:
```bash
# Run code formatter (Prettier)
npm run format

# Verify formatting violations
npm run format:check

# Run linter rules (ESLint)
npm run lint
```

---

## 🌐 API Health Endpoints

Once the application starts, you can check its status using the following endpoints:

| Endpoint | Method | Description | Response Example |
| :--- | :--- | :--- | :--- |
| `/health` | `GET` | Infrastructure/Load-Balancer health check | `{"status":"healthy","timestamp":"...","uptime":1.24,"environment":"development"}` |
| `/api/v1/health` | `GET` | Application/API consumer health check | `{"statusCode":200,"data":{"timestamp":"..."},"message":"OK","success":true}` |

---

## 📦 Pushing to GitHub

Follow these steps to push your local changes to the GitHub repository:

### Step 1: Stage Changes
Stage all modified and untracked files:
```bash
git add .
```

### Step 2: Commit Changes
Create a commit with a descriptive message:
```bash
git commit -m "feat: implement user registration and authentication middleware"
```

### Step 3: Push to GitHub
Push your local branch commits to the remote origin server:

- **If your branch already has an upstream set** (standard setup):
  ```bash
  git push
  ```
- **If you are working on a new branch** (e.g. `feature/user-auth`) that does not exist on GitHub yet:
  ```bash
  git push -u origin feature/user-auth
  ```
- **If you are working directly on the default branch** (usually `main` or `master`) for the first time:
  ```bash
  git push -u origin main
  ```

---

## 🤝 Contributing

1. Create a new branch: `git checkout -b feature/your-feature-name`
2. Make your changes and commit them: `git commit -m "feat: add feature-name"`
3. Push to your branch: `git push origin feature/your-feature-name`
4. Open a Pull Request on GitHub.