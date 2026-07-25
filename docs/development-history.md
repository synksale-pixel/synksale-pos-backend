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

---

## 🔑 Dynamic RBAC & Multi-Tenancy Architecture

We transitioned the backend from basic static role enumerations to a **Dynamic RBAC (Role-Based Access Control) & Multi-Tenant SaaS** design. This allows tenants (Organizations) to define, configure, and modify their own roles and permissions dynamically without changing code.

### 1. Architecture & Design Decisions
- **Static Vocabulary:** Action permissions (e.g., `sale:create`, `product:delete`) are defined in code as a fixed permission catalog. Developers write checks against these keys.
- **Dynamic Configuration:** Roles are stored in the database. Their scopes and permissions arrays can be edited per organization dynamically.
- **Tenant Separation:** Core data isolation ensures data cannot leak between tenants (Organizations) and sub-tenants (Stores) automatically.

---

### 2. Component-by-Component Walkthrough

#### 📂 Part 1: The Permission Catalog (`permissions.catalog.ts`)
Defines the absolute vocabulary of actions inside the platform.
- **PermissionKey:** Union type of all valid system operations.
- **PermissionDefinition:** Structured catalog with category-scoped keys:
  - **Sales:** `sale:create`, `sale:void`, `sale:refund`
  - **Catalog:** `product:create`, `product:read`, `product:update`, `product:delete`
  - **Inventory:** `inventory:adjust`, `inventory:transfer`
  - **Reports:** `report:view_store`, `report:view_org`
  - **Admin:** `user:invite`, `user:manage_roles`, `role:manage`, `store:create`, `store:configure`, `organization:configure`
- **Type Guard:** `isValidPermission(key: string): key is PermissionKey` is exported to reject invalid permissions at the database validation layer.

#### 📂 Part 2: Database Models (with Tenant Scoping & Soft Delete)

- **Organization Model (`organization.model.ts`):**
  - Represents a corporate tenant.
  - Features a unique lowercase `slug` (indexed for subdomain routing), validation for `contactEmail`, tenant status control (`isActive`), and settings configuration (e.g., default currency, timezone).
- **Store Model (`store.model.ts`):**
  - Represents physical store locations under an Organization.
  - References `organizationId` and holds fields like `code` (e.g., `STR-001`), `address`, and `timezone`.
  - Implements a compound unique index on `{ organizationId: 1, code: 1 }` ensuring store codes are unique per organization, while letting different tenants reuse codes.
- **Role Model (`role.model.ts`):**
  - Stores dynamic permissions arrays.
  - References `organizationId` (nullable for platform-wide roles).
  - Scope options: `platform`, `organization`, or `store`.
  - Protects system defaults from deletion via `isSystemRole` flag.
  - Implements a compound unique index on `{ organizationId: 1, slug: 1 }` to guarantee unique roles within the tenant workspace.
- **User Model (`user.model.ts`):**
  - References `organizationId` with a scoped unique index on `{ organizationId: 1, email: 1 }` allowing users to reuse their emails across different organizations.
  - Keeps credentials secure by marking `passwordHash` as `select: false`.
  - Maps to an organization role (`orgRoleId`) and an array of store-specific roles (`storeAccess: Array<{ storeId, roleId }>`).
  - Stores SHA-256 hashes of `refreshTokens` (with IP & UserAgent) to secure refresh flows at rest.
  - Includes a platform operator flag `isSuperAdmin` to bypass RBAC checks entirely.

#### 📂 Part 3: Tenant Scoping & Soft Delete Plugin (`tenantScope.plugin.ts`)
Serves as an automatic defense-in-depth isolation boundary at the database driver level.
- **Auto-Injection:** Injects `isDelete`, `organizationId`, and `storeId` schema paths dynamically.
- **Scoping Hooks:** Intercepts Mongoose query methods (like `find`, `findOne`, `countDocuments`, `update`, `delete`).
- **Context Enforcer:** Reads tenant IDs from `AsyncLocalStorage` and automatically overlays them on active queries.
- **Soft Delete filter:** Automatically appends `{ isDelete: { $ne: true } }` unless explicitly overridden.
- **Migration/Seed Bypass:** Disables filters gracefully if request context is unavailable (e.g., during startup seed runs).

#### 📂 Part 4: Token Authentication Service (`auth.service.ts`)
- **generateAccessToken(payload):** Signs short-lived access JWTs containing `userId`, `organizationId`, and `isSuperAdmin`.
- **generateRefreshToken():** Generates cryptographically secure, opaque random tokens, returning the raw token to the client and storing a secure SHA-256 hash in the database.
- **verifyAccessToken(token):** Verifies access token signatures and throws standard 401 `ApiError` instances on expired or malformed tokens.

#### 📂 Part 5: Effective Permissions Resolution (`permission.service.ts`)
- **getEffectivePermissions(user, storeId):** Computes the union of org-level permissions and active store-level permissions based on request context. Returns `['*']` for Super Admins.
- **canGrantRole(grantorPerms, grantorScope, targetRole):** Prevents privilege escalation. Grantors cannot create or assign roles with higher scopes, or assign permissions they do not possess.

#### 📂 Part 6: Authorization Middleware Chain (`rbac.middleware.ts`)
- **authenticate:** Resolves `Authorization` headers, verifies access, and binds `userId`/`organizationId` in AsyncLocalStorage.
- **scopeToStore:** Resolves `storeId` from parameters, body, or query. Verifies user access, then injects `storeId` into the active context.
- **authorize(permission):** Evaluates dynamic permissions against the current user/store context, checking for either exact permission key matches or the wildcard (`*`) bypass.

#### 📂 Part 7: Default Roles Provisioning (`roleSeed.service.ts`)
Seeds default templates automatically on tenant creation:
- `org_admin`: All organization and store-level scopes.
- `store_manager`: Sales, inventory adjustment, and catalog management.
- `cashier`: Basic checkout (`sale:create`, `product:read`, `report:view_store`).
- `accountant`: Organizational finances (`report:view_org`, `sale:refund`).
- `inventory_clerk`: Catalog reading and inventory adjustments.

---

### 3. How Multi-Tenant Context Flows
The sequence diagram below displays how the authentication, context bindings, and database drivers interact when a request is made:

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant Router as Express Router
    participant AuthMW as authenticate MW
    participant StoreMW as scopeToStore MW
    participant AuthzMW as authorize MW
    participant DB as MongoDB (Mongoose)

    Client->>Router: GET /api/v1/sales?storeId=STORE_123 (Header: Bearer Token)
    Note over Router: Context initialized with RequestId
    Router->>AuthMW: Execute
    AuthMW->>DB: Fetch User & populate role
    DB-->>AuthMW: User document
    Note over AuthMW: Injects userId & orgId into RequestContext
    AuthMW->>StoreMW: next()
    StoreMW->>StoreMW: Check if User has access to STORE_123
    Note over StoreMW: Injects storeId into RequestContext
    StoreMW->>AuthzMW: next()
    Note over AuthzMW: Resolve effective permissions
    Note over AuthzMW: Check if 'sale:create' is in permissions list
    AuthzMW->>Router: next() (Controller runs)
    Router->>DB: Store.find() / Sale.find()
    Note over DB: tenantScopePlugin intercepts query filter<br/>Injects { organizationId: ORG_ID, storeId: STORE_123, isDelete: false }
    DB-->>Router: Isolated tenant documents
    Router-->>Client: 200 OK (ApiResponse)
```

---
