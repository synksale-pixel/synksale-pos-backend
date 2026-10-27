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

### 4. Linting and Type Safety Adjustments
We eliminated the use of the `any` keyword in the implementation by:
1. **Namespace Merging (`types/express.d.ts`):** Extended the Express Request interface to merge type-safe `user?: UserDocument` and context keys.
2. **Error Narrowing:** Refactored catches to type-check `error instanceof Error` before accessing properties.
3. **Mongoose Populated Casts:** Handled populated schema fields using safe narrowing checks (e.g., `'scope' in orgRole` property guard) instead of casting as `any`.

---

## 👑 Platform-Level Super Admin Authentication System

We implemented a secure, end-to-end Super Admin Authentication System designed to manage platform-level administrators separately from tenant-level users (like managers, cashiers, and org admins). This guarantees platform operators can manage the system globally without contaminating multi-tenant data boundaries.

### 1. Database Schema & Data Layer Security (`src/models/user.model.ts`)
We established strict boundary layers directly in the database:
- **Conditional Organization Scoping:** Super Admins span all organizations. We updated the `IUser` interface to support a `null` `organizationId` and configured a conditional validation function in Mongoose:
  ```typescript
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: "Organization",
    required: function (this: any) {
      return !this.isSuperAdmin; // Only required for tenant accounts
    }
  }
  ```
- **Tenant Exclusivity Hook (Defense-in-Depth):** Added a schema-level `pre("validate")` hook that rejects saving user documents if both `isSuperAdmin: true` and `organizationId` are present. This prevents tenant-to-platform privilege escalation.
- **Partial Compound Indexing Strategy:**
  - MongoDB's default compound unique index on `{ organizationId: 1, email: 1 }` fails when multiple users have a `null` organizationId (since only one document can have a null value).
  - Reconfigured this to a partial index: `{ organizationId: 1, email: 1 }` filtered to `{ organizationId: { $gt: null } }`. This ignores platform accounts.
  - Added a second partial index: `{ email: 1 }` filtered to `{ isSuperAdmin: true }` to ensure all Super Admin email addresses are globally unique across the platform.

---

### 2. Strong Cryptographic Boundaries (JWT & Secrets)
To prevent cross-tenant key-compromise attacks (where a compromised tenant key might be used to sign a platform token), configurations are strictly isolated in `src/config/env.config.ts`:
- **Isolate JWT Platform Secret:** Signs and verifies Super Admin tokens exclusively using `JWT_PLATFORM_SECRET`. We added strict refinements checking that this platform secret does not match the tenant access or refresh secrets.
- **Tighter Expiry Configurations:** Platform tokens carry higher privilege, requiring shorter lifetimes:
  - Access Token expiry: `10m` (vs tenant `15m`).
  - Refresh Token expiry: `3d` (vs tenant `7d`).
- **Audience Claim Guard:** Super Admin access tokens are signed with the audience claim `{ aud: 'platform' }`. The platform verifier strictly asserts `aud === 'platform'`, ensuring tenant JWTs are rejected on platform routes.

---

### 3. Factorization of Shared Cryptography (`src/utils/token.util.ts`)
To keep our code DRY (Don't Repeat Yourself), we extracted cryptographic and helper logic from the existing tenant service into a unified utility file:
- `generateOpaqueToken()`: Generates a 40-byte hex-random plaintext token and returns both the plain string (for the client) and its SHA-256 hashed representation (for database storage).
- `hashToken()`: Reusable helper for SHA-256 token hashing.
- `getExpiryDate()`: Parses human-friendly time periods (e.g. `3d`, `10m`) into native JavaScript Date objects.
- Refactored the original `auth.service.ts` to consume these shared utilities, ensuring clean and reusable patterns.

---

### 4. Platform Authentication Middleware (`src/middleware/platformAuth.middleware.ts`)
Created a dedicated middleware for Super Admin authentication that operates in complete isolation from the tenant RBAC:
- Extracts and verifies bearer tokens using the platform secret (`JWT_PLATFORM_SECRET`).
- Re-validates the database state (`isSuperAdmin === true` and `isActive === true`) to catch real-time account deactivations.
- Binds user details to the request (`req.user`) and registers `userId` in the thread-safe `AsyncLocalStorage` Request Context.

---

### 5. Platform Controller, Validation & Routes
Built the controller layer (`src/controllers/platformAuth.controller.ts`) to manage authentication endpoints:
- **Anti-User Enumeration Login:** If a login fails, the controller catches the failure, logs the detailed breakdown internally via Winston, and returns a generic `401 Invalid credentials` to the client. This prevents attackers from finding valid admin emails by analyzing response differences.
- **Refresh Token Rotation (RTR):** Enforces single-use refresh tokens. When a session is refreshed, the old refresh token is revoked and a new pair is issued. Contains code documentation detailing how to handle token reuse attacks (terminating all active sessions if a previously-used token is presented again).
- **Logout Mechanics:** Supports logging out of a single device (by matching and removing the hashed token) or purging the entire `refreshTokens` subdocument array to log out of all devices.
- **Namespaced API:** Mounted the routes under `/api/v1/platform/auth/...` so it is isolated and clearly identifiable in routing trees.

---

### 6. CLI-Only Seeding Pathway (`src/scripts/seedSuperAdmin.ts`)
To enforce that Super Admin accounts are never created via public HTTP endpoints, we built a secure database initialization CLI script:
- Invoked via `npm run seed:super-admin`.
- Parses arguments (`--email`, `--password`), checks environment variables as a fallback, and uses interactive terminal prompting if variables are missing.
- Runs input checks against Zod schemas and saves the new administrator document directly to the database.

---

### 7. End-to-End Verification
- **Compilation & Formatting Check:** Ensured strict type compliance and verified linting rules.
- **Integration Test Suite (`testSuperAdminAuth.ts`):** Built a self-contained integration test environment starting a mock server on port `3999`. Runs 7 test cases covering:
  1. Successful Super Admin Login
  2. Input Validation Failure (Invalid email)
  3. Incorrect Password Attempt
  4. Access Token verification (Audience guard validation)
  5. Session Refresh rotation and RTR
  6. Logout (Session invalidation)
  7. Tenant Token rejection on Platform route
  All tests pass successfully.

---

## 🏢 Tenant Onboarding, User Invitations & Transactional Signup

We implemented a robust and secure **Multi-Tenant Onboarding System** featuring atomic organization signups, invite-based user registration with strict privilege escalations control, and safe transactional database operations.

### 1. Database Schema & Model Enhancements (`src/models/user.model.ts`)
To accommodate an invitation flow without violating schema constraints (since invited users do not have a password or active status at the time of creation), we updated the User schema:
- **Invitation Tracking Fields:**
  - `inviteToken`: Hashed (SHA-256) opaque token, marked `select: false` to prevent accidental database leakage.
  - `inviteTokenExpiresAt`: Timestamp representing invite validity.
  - `inviteStatus`: Enum with values `'pending'` | `'accepted'`, defaulting to `'accepted'` (since self-registering organization admins are immediately active and accepted).
- **Conditional Password Requirement:** Modified the `passwordHash` field to be required only when the invitation is accepted:
  ```typescript
  passwordHash: {
    type: String,
    required: function (this: any) {
      return this.inviteStatus !== "pending";
    },
    select: false,
  }
  ```
- **Safe Password Comparison:** Refactored the `comparePassword()` instance method to return `false` gracefully if the user has no password set (e.g. pending invited users) rather than raising internal server exceptions:
  ```typescript
  userSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
    if (!this.isSelected("passwordHash")) {
      throw new Error("Password hash not loaded. Please select passwordHash...");
    }
    if (!this.passwordHash) {
      return false; // Safely return false if user has no password set (e.g., pending invitee)
    }
    return bcrypt.compare(candidatePassword, this.passwordHash);
  };
  ```

---

### 2. Transactional Tenant Onboarding (`src/services/organizationSignup.service.ts`)
Signing up a new tenant involves modifying multiple Mongoose collections (`organizations`, `roles`, and `users`). To prevent orphaned records in case of partial failures, we implemented these steps inside a **Mongoose session transaction**:
- **Slugification & Collision Handler:** Automatically generates a clean, lowercase URL slug from the organization name. If a collision is detected in the database, a fallback loop appends a 4-character random alphanumeric suffix and retries up to 10 times.
- **Transactional Role Seeding:** Integrated `seedDefaultRolesForOrganization` inside the session context, ensuring the default tenant roles (such as `org_admin`, `store_manager`, `cashier`) are provisioned within the transactional boundary.
- **Immediate Admin Bindings:** Binds the initial tenant user to the newly seeded `org_admin` role.
- **Atomic Operations:** If any database write fails during role seeding, user creation, or organization creation, the transaction rolls back, keeping the database in a clean state. On success, the transaction commits. *(Superseded: signup no longer issues tokens. The organization is created as `pending` and must be approved by a Super Admin; see "Gated Organization Onboarding" below.)*

---

### 3. Invite-based User Onboarding (`src/services/userInvite.service.ts`)
Manages the lifecycle of user invitations and prevents privilege escalations:
- **Enforcing the Privilege Ceiling:** Before creating an invite, the system verifies that the inviter's scope rank and permission keys are superior to or equal to the target role. A user with `store_manager` privileges cannot invite an `org_admin`, nor can any user assign a role that possesses permissions they do not have themselves.
- **Hashed Opaque Invitations:** Reuses the opaque token design. A cryptographically secure 40-byte plaintext hex token is generated for the email URL, while the SHA-256 hash is stored in the database.
- **Scope Scoping Assignment:**
  - For `'organization'` scoped roles, the role ID is assigned directly to `orgRoleId`.
  - For `'store'` scoped roles, the configuration pushes a binding into the `storeAccess` array (validating that `storeId` is provided).
- **Auto-Login on Accept:** When accepting an invitation, the token is verified, the user sets their password (triggering Mongoose's pre-save hashing hook), the account status turns active, and the invite status becomes `'accepted'`. The system immediately returns the access and refresh tokens.

---

### 4. Controller & Route Configurations
- **Anti-Enumeration Login:** Refactored tenant auth login endpoints. If the slug, email, or password comparison fails, the system responds with a generic `401 Invalid credentials` to block brute-force scanners from mapping active accounts. Status checks (e.g. `isActive`) are executed only after password validation.
- **Dynamic Permission Resolution (`/me`):** Built the `/me` routing endpoint. It resolves the user's active permissions context. If a `storeId` query parameter is passed, the service aggregates the user's store-specific permissions (e.g., cashier operations) alongside their organization-wide permissions.

---

### 5. Strict TypeScript & ESLint Compliance
Refactored operations to ensure clean compilations without bypassing type checks:
- **Eliminated Explicit Any:** Cleaned up type assertions, typing request payloads with strict interfaces.
- **ES6 Object Destructuring over Delete Operands:** The JavaScript `delete` operator is unsafe and discouraged in strict TypeScript setups. Instead, we sanitize database documents using object destructuring:
  ```typescript
  const { passwordHash: _passwordHash, refreshTokens: _refreshTokens, ...userResponse } = user.toObject();
  ```
  Unused outputs are prefixed with an underscore (`_`), complying with the ESLint rules for unused variables.

---

### 6. Programmatic Verification (`src/scripts/verifyTenantFlow.ts`)
We created a verification script in the development environment to prove the integrity of the onboarding systems:
- Verifies that organization signups are fully atomic and yield valid auth tokens.
- Asserts that invitations register users with `isActive: false` and no passwords.
- Validates that accepting the invite activates the account, registers the password hash, and logs the user in.
- Asserts that a `store_manager` trying to invite an `org_admin` is intercepted and throws a `403 Access Denied` error.

---

## 🚦 Gated Organization Onboarding (Sales-Assisted Approval)

Organization signup no longer grants immediate access. New organizations are created as `pending` and can only authenticate after a Super Admin approves them.

### 1. Signup Request (`POST /api/v1/auth/signup`)
- **Body:** `organizationName`, `contactPhone` (required), `contactEmail` (optional), `adminFirstName`, `adminLastName`, `adminEmail`, `adminPassword`.
- **`contactPhone`:** New required field on the Organization model. Accepts 7-20 characters: optional leading `+`, digits, spaces, `-` and `()`.
- **`contactEmail`:** Optional. When omitted, it falls back to `adminEmail`.
- **No tokens issued:** The response is `201` with `{ organization: { id, name, slug, approvalStatus } }`.

### 2. Duplicate Application Protection (`organizationSignup.service.ts`)
Duplicates are keyed on `adminEmail` (names collide between unrelated businesses):
- **Pre-check:** Rejects with `409` if the admin email belongs to a user in an organization that is `pending` or `approved`. Rejected and soft-deleted organizations are ignored.
- **Database-level guarantee:** `applicantEmail` (denormalized copy of the admin email) has a partial unique index limited to `approvalStatus: "pending"`, so two simultaneous signups cannot both pass the pre-check. A duplicate-key error maps to `409`.
- **Transient conflict retry:** The public `signupOrganization` wraps the transactional `signupOrganizationOnce` and retries up to 4 times on `TransientTransactionError`.

### 3. Approval State on the Organization Model
- `approvalStatus`: `pending` (default) | `approved` | `rejected`, orthogonal to `isActive` (which still means post-approval suspension).
- Audit fields: `approvedBy`, `approvedAt`, `rejectedBy`, `rejectedAt`, `rejectionReason`.
- Roles are seeded at signup (not approval), so pending and rejected organizations already have their default roles.

### 4. Super Admin Review API (`/api/v1/platform/organizations`, Super Admin token required)
Files: `platformOrganization.routes.ts`, `.controller.ts`, `.service.ts`, `platformOrganization.validator.ts`.

| Endpoint | Behavior |
|---|---|
| `GET /` | Paginated list, optional `?status=`, `page`, `limit` (max 100) |
| `GET /:id` | Full detail of one application |
| `POST /:id/approve` | Optional body `{ slug }` to correct the slug. `400` if already approved. `409` if the same applicant has another pending/approved organization or the slug is taken. Clears prior rejection fields. |
| `POST /:id/reject` | Body `{ reason }` (5-500 chars). Only `pending` organizations can be rejected (atomic conditional update); otherwise `400`. Use `isActive` to suspend a live organization. |

Approve and reject are logged through Winston. TODO: dedicated audit log collection and applicant email notification.

### 5. Login Enforcement (`tenantAuth.controller.ts`)
After the password is verified (to preserve anti-enumeration), login returns `403` for `pending` ("still pending review"), `rejected` ("not approved"), suspended organizations and deactivated users. Per the review notes in the reject service, `authenticate` also re-checks `approvalStatus` on each request.

### 6. Flow Summary
```
signup -> pending --approve--> approved --(isActive=false)--> suspended
             |
             +--reject--> rejected --approve (re-review)--> approved
```

### 7. Known Gaps / Next Steps
- No re-apply path for rejected organizations (the applicant can sign up again; a dedicated flow is planned).
- No applicant notification (needs an email service), so the Super Admin must communicate the slug and decision out of band.
- No immutable audit log collection.

### 8. Token Lifetimes (for reference)
| Token | Tenant users | Super Admin |
|---|---|---|
| Access | 15m (`JWT_ACCESS_EXPIRY`) | 10m (`JWT_PLATFORM_ACCESS_EXPIRY`) |
| Refresh (rotating) | 7d (`JWT_REFRESH_EXPIRY`) | 3d (`JWT_PLATFORM_REFRESH_EXPIRY`) |

---

## 👥 Staff Management (Phase 0 + Phase 1)

Before this work an organization admin could create Store B but had no way to staff it: the only
endpoints under `/users` were "send invite" and "accept invite". There was no way to list staff,
assign an existing employee to another store, change anyone's role, or — critically — **turn off
a departing employee**. `user.isActive` was enforced in `authenticate` and on refresh, but nothing
in the API could ever set it to `false`.

Identity was settled before the POS domain deliberately: sales and inventory records will carry
`createdBy`/`storeId`, and once a ledger references users the assignment model is expensive to
change.

### Phase 0 — Foundations

**1. New permissions (`permissions.catalog.ts`)**
`user:read` (view the roster) and `user:manage` (activate/deactivate). Reusing `user:invite` as
the gate for reading staff would have been semantic drift. `user:invite` and `user:read` are now
`minScope: "store"`, and `store_manager` holds both: a store manager hiring a cashier for their
own store is normal retail, and the privilege ceiling still stops them granting anything above
themselves.

**2. System role reconcile (`syncSystemRolePermissions`)**
`seedDefaultRolesForOrganization` is idempotent *by slug* — an existing role is skipped entirely,
permissions untouched. So adding a catalog key never reached organizations seeded earlier, and
their `org_admin` would silently 403 on any endpoint guarding the new key. The reconcile unions in
missing template permissions and is **additive, never subtractive**, so an organization's own
customizations survive. Run `npm run sync:system-roles` after every catalog change.

**3. Tenant scoping on `User` and `Role`**
Neither model used `tenantScopePlugin`; every user query was hand-written with an explicit
`organizationId` filter. With `GET /users/:userId` added, one forgotten `User.findById` would have
been a cross-tenant read of another organization's employee record. The plugin adds no fields
here (both schemas already define `organizationId` and `isDelete`) — only the pre-query hooks.
Safe for the unauthenticated paths: login, refresh, accept-invite and platform auth all run with
no organization in the request context, and `authenticate` sets the context only *after* its own
lookup. Services still pass `organizationId` explicitly; the plugin is the backstop.

**4. `canManageUser` (`permission.service.ts`)**
`canGrantRole` answers "may you hand out this role" — it inspects only the role being assigned, so
on its own it would let a store manager with `user:manage_roles` deactivate the organization admin
(deactivation assigns no role). `canManageUser` adds the missing half: the actor must already hold
every privilege the target holds, across their organization role **and** every store role.

**5. `storeAccess` integrity**
Nothing stopped two entries for the same store, and `getEffectivePermissions` resolves a store
role with `Array.prototype.find` — so whether someone was a cashier or a manager depended on array
insertion order. A `pre("validate")` hook now enforces one role per store. Added the two indexes
the new queries need: `{ organizationId, "storeAccess.storeId" }` and `{ organizationId, orgRoleId }`.

### Phase 1 — The staffing surface

`userInvite.routes.ts` was merged into `user.routes.ts`: two routers on `/users` with overlapping
path shapes (`/invite` vs `/:userId`) is a footgun. `POST /users/accept-invite` stays public by
being registered before the router-level `authenticate`.

| Endpoint | Gate |
|---|---|
| `GET /users` | `user:read` (any scope) |
| `GET /users/:userId` | `user:read` (any scope) |
| `PATCH /users/:userId/org-role` | organization role + `user:manage_roles` |
| `POST /users/:userId/store-access` | `scopeToStore` + `user:manage_roles` |
| `PATCH /users/:userId/store-access/:storeId` | `scopeToStoreAllowInactive` + `user:manage_roles` |
| `DELETE /users/:userId/store-access/:storeId` | `scopeToStoreAllowInactive` + `user:manage_roles` |
| `PATCH /users/:userId/deactivate` \| `/activate` | organization role + `user:manage` |
| `POST /users/:userId/invite/resend` | `user:invite` (any scope) |
| `DELETE /users/:userId/invite` | `user:invite` (any scope) |
| `GET /roles`, `GET /roles/permissions` | `user:read` (any scope) |

**`GET /roles` was a blocker for a feature already shipped.** `POST /users/invite` requires a
`roleId` and nothing exposed one, so the invite endpoint was not callable from a client. Each
organization gets its own copy of the default roles at signup, so role IDs differ per tenant and
must not be hard-coded. It is gated on `user:read` rather than `user:manage_roles` because anyone
who can invite staff needs to resolve a role ID.

**`authorizeAnyScope` (`rbac.middleware.ts`).** `authorize` only consults a store role when a
`storeId` is in context, which is correct for store-scoped actions but makes store-agnostic routes
unreachable for a store manager: on `GET /users` their organization role is empty, so they were
rejected before the service ran. `authorizeAnyScope` resolves the permission across every store
the caller works at — it answers "may you do this somewhere", so every endpoint using it narrows
the result itself. The same fix applies inside `loadManageableTarget`, which evaluates the actor
across all their stores when the action names no specific store.

**Visibility.** Mirrors `listStores`: organization-scoped roles see the whole roster; store-scoped
staff see only users who share one of their stores. A user the caller cannot see is reported as
**404, not 403**, so the endpoints cannot be used to probe who exists. The rule (`canSeeUser`) is
applied to reads *and* mutations, so a store manager cannot resend or revoke an invite for an
invitee at another store.

**Guards on modification.**
- *Self-protection*: you cannot change your own organization role or deactivate yourself (400).
  Not philosophy — it is the easy path to an organization with zero admins that only a DB shell
  can fix.
- *Last administrator*: refuses (409) to leave the organization with no active admin. The count
  and the update share one transaction, so two concurrent demotions cannot both pass a stale read.
  **Note:** with the current permission set this is defense-in-depth rather than a reachable path —
  any actor allowed to call these endpoints is themselves an active administrator and so is
  counted. It becomes reachable as soon as custom roles (Phase 2) can separate `user:manage` from
  `user:manage_roles`.
- *Inactive stores*: granting access is refused; revoking is always allowed. A closed store must
  never trap its employees. `setStoreActive` still leaves `storeAccess` intact, so reactivation
  restores access as it was.
- *No session invalidation on role change*: `generateAccessToken` deliberately omits permissions
  and `authorize` resolves fresh from the database per request, so role changes take effect on the
  next call. Deactivation additionally clears `refreshTokens`.

**Delete policy.** Accepted users are **never** deleted, only deactivated — sales history will
reference them. Pending invitees **are** hard-deleted on revoke: they have never logged in,
nothing references them, and the unique index on `{ organizationId, email }` does not exclude
soft-deleted rows, so a soft delete would keep the address occupied and a re-invite would 409.

### Audit log

`AuditLog` (org-scoped) plus `recordAudit()`, called from every privileged mutation as it was
written rather than retrofitted later. Records role changes, store-access changes,
activation/deactivation and the invite lifecycle — not reads, and not sales, which are their own
ledger. An audit write never fails the request: losing a row is bad, but rolling back a completed
role change because the audit insert failed is worse.

### Invite token exposure

`inviteUser` returned the plaintext token in the API response. With resend and revoke added, that
multiplies how many plaintext tokens travel through response logs and browser devtools.
`buildInviteDelivery` now returns the token **only outside production**; in production the response
carries `delivery: "email_pending"` and omits `inviteToken`/`inviteLink`.

**This makes production invites undeliverable until an email service is wired up — deliberately.**
It is the remaining blocker before onboarding a real customer.

### Incidental fixes

- **`npm run build` was broken on `develop`.** `tsconfig.json` set `"ignoreDeprecations": "6.0"`,
  which the installed TypeScript 5.9.3 rejects (`TS5103`). Changed to `"5.0"`; the project now
  compiles clean.
- **Pagination consolidated** into `resolvePaging`/`buildPaginationMeta` (`utils/pagination.ts`)
  and a shared `PaginationSchema`. The same block had been hand-rolled in the store and platform
  organization services and was about to become a third copy.
- **`resolveOrganizationId`** extracted to `utils/requestOrganization.ts`; the store and invite
  controllers each had their own copy of the same "organizationId is populated, read its `_id`"
  logic.

### Known gaps / next steps

- No email service, so production invites cannot be delivered (see above).
- No role CRUD yet (`role:manage`): `GET /roles` and `GET /roles/permissions` are read-only.
  When it lands, block deleting a role still assigned to any user — a soft-deleted role makes
  `getEffectivePermissions` return nothing for that store, which fails closed but silently.
- `minScope` in the permission catalog is still advisory: nothing validates that a store-scoped
  role cannot hold `organization:configure`. Enforce it in role creation, or drop the field.
- Store managers can invite new staff to their own store but cannot assign an *existing* employee
  to it (`user:manage_roles` is organization-level). Intentional for now — reassignment is a
  cross-store action — but worth revisiting.

---

## 🎭 Role Management (Phase 2)

`GET /roles` shipped read-only in Phase 1, so an organization was stuck with the five roles
seeded at signup. This adds custom roles: a shop can define "Shift Supervisor" (till and refunds,
no inventory) without waiting on a code change.

### Endpoints

| Method | Path | Gate |
|---|---|---|
| `POST` | `/api/v1/roles` | organization role + `role:manage` |
| `GET` | `/api/v1/roles/:roleId` | `user:read` (any scope) |
| `PATCH` | `/api/v1/roles/:roleId` | organization role + `role:manage` |
| `DELETE` | `/api/v1/roles/:roleId` | organization role + `role:manage` |

Reads stay on `user:read` because anyone who can invite staff needs to resolve a `roleId`, and
store managers hold `user:invite` without `role:manage`. Writes are organization-level: what
permissions exist in the organization is not a per-store decision.

`GET /roles` and `GET /roles/:roleId` now return **`usageCount`** — how many users hold the role —
so a client can warn before a delete that would be refused. It is one grouped aggregation for the
whole page, not a query per role, and a user holding the same role at several stores counts once.

### The two ceilings

**Creating**: `canGrantRole` — you cannot mint a role whose scope or permissions exceed your own.
This is what stops role management being an escalation hole.

**Modifying and deleting**: `canModifyRole`, new in this phase. `canGrantRole` inspects only the
permissions being *set*, so on its own a limited administrator could edit `org_admin` and strip it
to nothing, or quietly repoint a role other people hold. The actor must dominate the role **as it
stands today** as well as the state they are moving it to. Same shape as `canManageUser` from
Phase 0, applied to a role instead of a user.

### What is immutable, and why

- **`slug`** is derived from `name` (`"Shift Supervisor"` → `shift_supervisor`, numeric suffix on
  collision) and never accepted from a client. It is the key `syncSystemRolePermissions` matches
  templates on, so a client-chosen slug could collide with a system role's.
- **`scope`** is fixed at creation. Flipping a store role to organization scope would instantly
  grant organization-wide powers to everyone already holding it — a silent mass escalation with
  no record of who gained what.
- **A built-in role's permissions** cannot be changed (renaming is fine). The reconcile re-adds
  template permissions additively, so an edit here would be silently undone the next time the
  catalog grows. Organizations needing a different set create a custom role.

### Deleting

Refused with 409 while any user still holds the role. A soft-deleted role is filtered out by the
`Role` pre-query hook, so `getEffectivePermissions` resolves it to `null` and its holders silently
end up with zero permissions at that store — it fails closed, which is right, but it is invisible
to the administrator and undebuggable for the user. The count runs inside the same transaction as
the delete so a concurrent assignment cannot slip through.

The delete is soft, so audit entries can still resolve the role's name.

### `minScope` is no longer decorative

It had exactly one consumer since day one — the `org_admin` filter in `roleSeed.service.ts`.
Now a role may only hold permissions at or below its own scope: an organization role can grant
`sale:create`, but a store role cannot grant `report:view_org`. Enforced in the service for a
precise message and repeated as a `pre("validate")` hook on the model so no path bypasses it.

None of the five seeded roles violate it, so no migration was needed — but it **did** catch a
fixture in `store.test.ts` that built a *store*-scoped role holding `store:create` (minScope
`organization`). The assertion it supported — that the ceiling rejects an over-privileged role
within the same scope — is still valid, so the fixture was rewritten with a reduced inviter.
Which surfaced a side effect of Phase 1 worth knowing:

> **`store_manager` now holds every store-level permission.** After gaining `user:read` and
> `user:invite`, no store-scoped role can exceed it, so a store manager can assign any store role
> at their own store — including promoting a cashier to store manager. Reasonable for retail, but
> it is a real widening, not just a test artifact.

### The unique index kept deleted slugs occupied

`{ organizationId, slug }` was unique with no `isDelete` filter, so deleting "Shift Supervisor"
would have reserved `shift_supervisor` forever and recreating it would fail with a confusing
duplicate-key 409. Same bug class as the user-email index noted in Phase 1. Now a partial index
on `{ isDelete: false }`, and there is a test that deletes a role and recreates it with the same
name.

### Correction: the last-administrator guard is still unreachable

Phase 1 recorded the 409 guard as defense-in-depth that would "become reachable as soon as custom
roles can separate `user:manage` from `user:manage_roles`". That was wrong, and this phase proves
it — the refusal in that scenario is a 403 from the ceiling, never the 409:

- to count as an administrator, the TARGET must hold `user:manage_roles`;
- `canManageUser` requires the ACTOR to hold everything the target holds, so the actor holds it too;
- `user:manage_roles` is `minScope: "organization"`, so it can only come from an organization-scoped
  role — exactly what the admin count looks at.

So any actor who clears the ceiling is themselves a counted administrator and the remaining count
is never zero. `minScope` enforcement actually tightened this further, by closing the one loophole
(borrowing the permission from a store role). The guard is kept deliberately — it is cheap, it is
correct, and it is the backstop if the definition of "administrator" or the ceiling ever changes —
but it is documented as unreachable rather than pending, and the test asserts the 403 that really
happens.

### Testing

42 new tests in `tests/integration/roleManagement.test.ts`; 237 pass in total. Covers both
ceilings, system-role protection, scope/slug immutability, `minScope` rejection in both
directions, delete-while-in-use and delete-after-reassign, slug collision and reuse-after-delete,
cross-tenant isolation on every verb, audit entries, and that a permission change takes effect on
the holder's next request with no re-login.

### Still open

- Email service: production invites remain undeliverable (carried over from Phase 1).
- No way to bulk-reassign a role's holders. Delete refuses and tells you the count; an optional
  `replacementRoleId` on the delete request would close it, deferred until someone asks.
- Deleted roles cannot be restored. Soft delete keeps the row for audit resolution only.

## 🛡️ Tenant Scope Plugin Hardening

`tenantScopePlugin` is the backstop that stops a forgotten or wrong tenant ID from reaching
another tenant's data. Before the POS domain (catalog, inventory, sales, reports) lands on it,
four gaps were closed.

### Operations the plugin never saw

Only eight query methods were hooked. `aggregate` is a separate Mongoose middleware family and
was not covered at all. `distinct`, `findOneAndDelete` (which also covers `findByIdAndDelete`),
`findOneAndReplace` and `replaceOne` were missing from the list. The `usageCount` bug fixed in
`43e7968` came from this gap.

- The missing query methods are now hooked.
- A `pre("aggregate")` hook puts a `$match` at the front of the pipeline. Aggregates don't cast
  types, so the IDs are cast to ObjectId first. `$geoNear` takes the filter in its `query`, and
  `$search`/`$vectorSearch` get it right after their stage. An explicit `isDelete` in the opening
  `$match` is respected. Joins (`$lookup`, `$unionWith`) are **not** scoped: a join into another
  tenant collection must scope its own pipeline or join on `_id`.
- A pipeline `$match`/`$geoNear` that names another organization does **not** throw, unlike a
  query filter. It is ANDed with the tenant `$match` and returns nothing. Both fail closed, but
  if a report comes back unexpectedly empty, check for this first.
- `estimatedDocumentCount` and `bulkWrite` take no scopable filter. They now throw inside a
  tenant context.

### Explicit IDs were trusted

The plugin only filled `organizationId`/`storeId` when a filter left them out, so a filter naming
the wrong tenant went through unchecked. A filter may now name only the context's ID (as a plain
value, `$eq` or `$in`), and anything else throws a 500 `Tenant scope violation` that is logged as
an error. It's a 500 because only a code bug can cause it. When no store is in the context
(org-level requests), store filters are left to the service. Both tenant IDs are now
`immutable`, so an update can't move a document into another tenant. This needed
`options.immutable` as well as `SchemaType.immutable()`, because update casting reads only the
option.

### Writes were unchecked

`save`/`create`/`insertMany` (including `lean`) and replacement documents now fill in the
context's IDs when they're missing, and throw when they differ.

Update bodies needed their own check. With `upsert: true`, Mongoose moves a `$set` on an
immutable path into `$setOnInsert`, which it deliberately exempts from immutability. So an upsert
whose filter correctly named org A could still insert the document into org B. The pos-tester
review found this. The rules for `updateOne`/`updateMany`/`findOneAndUpdate` are now:

- A tenant ID may appear only in `$set`, `$setOnInsert` or a top-level key, and only with the
  context's value.
- Any other operator on it throws, including either side of `$rename`.
- Pipeline-style updates are refused inside a tenant context.
- On `organization+store` models, an upsert must resolve one store from an equality filter or
  from the update body. Upserts skip `required`, so an org-level request could otherwise insert a
  row with no `storeId`.

A read or write that legitimately touches a second store, such as a transfer's destination, goes
through `runInOrganizationStore(storeId, fn)` in `store.service.ts`. It verifies the store belongs
to the context organization, then runs `fn` under `runWithStoreContext`. That lower-level helper
now throws when the context has no organization, because otherwise it would scope nothing.
Background jobs must set up their organization context first.

### Soft-delete is now opt-out

`softDelete: false` drops the `isDelete` field and filter but keeps tenant scoping. Ledgers
(sales, stock movements) must use it. The audit log now does, so existing rows keep an unused
`isDelete: false` and no migration is needed.

### Testing

39 tests in `tests/unit/tenantScopePlugin.test.ts` use two seeded organizations and cover each
operation above. They include the upsert rules (both the refusals and the allowed own-store upsert
used for stock levels), `$geoNear`, saving a document with a populated organization, and nested
store switches. 293 tests pass in total.

---

## 🧱 Catalog & Purchases — Phase 0: Foundations

v1 targets the GCC (the Purchases Specification v2 is written for Bahrain/UAE). This phase lays
the groundwork that products, stock and purchases need: money, currency, tax rates and coded
errors. No Zoho integration: the platform builds those features itself.

### Currency and country

- `src/config/currencies.config.ts` lists the supported currencies with their minor-unit
  decimals (BHD/KWD/OMR = 3, AED/QAR/SAR/INR = 2) and countries. INR stays so organizations
  created before the switch remain valid.
- An organization trades in **one currency**. New stores must send `countryCode` (ISO 3166-1),
  and it must be a country using the organization's currency (`STORE_COUNTRY_CURRENCY_MISMATCH`).
  Legacy stores without `countryCode` can set it through `PATCH /stores/:storeId`.
- Signup takes an optional `currency` (default **BHD**, was hard-coded INR) and seeds that
  country's standard VAT rate as the default tax rate (BH 10%, AE/OM 5%, SA 15%; none for KW/QA).

### Organization settings — `GET` / `PATCH /api/v1/organization`

Any member can read the profile (clients need `currency.decimals` to format money). Updating
needs `organization:configure` on an org-level role. Updatable: `legalName`,
`taxRegistrationNumber` (TRN, spaces/hyphens stripped), `settings.currency`, `settings.timezone`,
`settings.inventory.allowNegativeStock` (default false). A currency change is refused while any
store is in a country using another currency (`CURRENCY_STORE_MISMATCH`).

> Once priced documents exist (Phase 1+), a currency change must also be refused, since it
> would reinterpret every stored amount.

### Money — `src/utils/money.ts`

Amounts are stored as integer minor units and sent over the API as decimal strings (`"1.250"`).
All arithmetic goes through decimal.js; rounding is half-up per line. `parseMoney` rejects more
decimals than the currency has rather than rounding user input.

### Tax rates — `/api/v1/tax-rates`

A rate is a list of components (`[{ name: "VAT", rate: 10 }]`), so a split tax fits the same
shape later. `rate` is their exact sum. Names are unique per organization, case-insensitive, and
reusable after delete. Exactly one default, enforced by a partial unique index; the default can't
be deactivated or deleted, and an inactive rate can't become default. Reads need only
authentication (product form and POS need them); writes need the new **`tax:manage`**
permission (org-level; org_admin and accountant). Document lines will copy the rate they used.

### Coded errors

`ApiError.coded(status, code, message, errors)` adds a stable `code` to the response, and error
details can carry `field`, `code` and `meta`. Generic translations now carry codes too:
`VALIDATION_FAILED` (Zod, Mongoose validation) and `DUPLICATE` (E11000). Existing callers are
unchanged.

### Deploy note

Run `npm run migrate` (indexes + `sync:system-roles`) so existing organizations' org_admin and
accountant roles receive `tax:manage`.

### Testing

New: `tests/unit/money.test.ts`, `tests/integration/organization.test.ts`,
`tests/integration/taxRate.test.ts`, and `tests/integration/phase0Hardening.test.ts` from the
pos-tester review (concurrent default/name races, tenant isolation on every tax-rate action,
platform-token and RBAC boundaries, signup rollback when tax seeding fails). That review found two
money bugs, now fixed: `-0` could be returned, and an invalid quantity or rate surfaced as a 500
instead of a coded 400 (`INVALID_QUANTITY` / `INVALID_RATE`). The plugin test's Organization stand-in is now inserted raw,
because `store.service` now loads the real Organization model. Manual: Requestly Section 6
(`docs/requestly/section-6-org-settings-tax-rates.postman_collection.json`). 378 tests pass.

---

## 📦 Catalog — Phase 1 contract (validators + Swagger, no endpoints yet)

The product/category API is defined first, for the frontend developer to sign off, before any
model or service is written. `/categories` and `/products` are documented in Swagger with a
"contract preview" note and return 404 until they are implemented.

Decisions (approved 2026-10-13):

- **Product + ProductVariant.** Every product has at least one variant; a single item has one
  hidden `isDefault` variant. Stock, purchase and sale lines will always reference `variantId`.
  Tax, category, unit and type live on the product; SKU, barcodes, prices and reorder point on
  the variant.
- **Request shape follows the frontend form** (`sales` / `purchase` / `inventory` groups). Single
  items send SKU, barcodes, prices and reorder point at the top level; variant items send
  `attributes` + `variants`.
- **Money as decimal strings**; selling prices VAT-inclusive when the new org setting
  `settings.sales.pricesIncludeTax` is true (default, live now); cost prices VAT-exclusive.
- `taxPreference`: standard / zero_rated / exempt / out_of_scope (GCC VAT). `type` and `itemType`
  are immutable. SKU optional and unique per org; UPC/EAN/ISBN unique and scannable; MPN is
  reference only. Flat categories with `sortOrder`. Images are URLs only.
- **No opening stock in Phase 1.** It arrives with the stock ledger (Phase 2) as `opening`
  movements, so there is never a second source of truth for stock.
- Units live in `src/config/units.config.ts`; kg, g, L, mL, m and cm allow up to 3 decimals.

The pos-tester review found and fixed: a crash on an attribute named `constructor` (prototype
lookup), a book's identical EAN/ISBN being flagged as a duplicate, services accepting a reorder
point, update accepting a tax rate on a non-standard product or duplicate attributes, and empty
nested updates counting as changes.

Checks the services must do (the schema can't see the stored product): re-check reorder points
when the unit changes, refuse service-only violations arriving via PATCH, check an added variant's
reorder point against the unit, and coerce `page`/`limit` query strings.

### Test runner

Each test file starts its own in-memory replica set; a dozen at once timed out waiting for a
primary and failed whole files intermittently. `vitest.config.ts` now caps `maxWorkers` at 4,
which is reliable (~50 s). 470 tests pass.

---

## 📦 Catalog — Phase 1 implementation

`/categories` and `/products` are live behind the contract above; the "contract preview" notes
are gone from Swagger.

- **Models.** `Category`, `Product`, `ProductVariant`, all organization-scoped with soft delete.
  Uniqueness lives in partial unique indexes over non-deleted rows: category name and SKU per
  organization (case-insensitive), every UPC/EAN/ISBN per organization across all three kinds
  (a multikey `scanCodes` index), one attribute combination per product, one default variant per
  product. The SKU and barcode indexes filter on `$type: "string"` so variants without them never
  collide. Money is stored as integer minor units (`sellingPriceMinor`, `costPriceMinor`).
- **Services.** SKU/barcode conflicts are checked up front so the 409 names the product that has
  the value; the indexes stay the final word under races. Rules the model hooks apply on `save()`
  only (services never track inventory, no tax rate unless standard-rated) are applied by the
  service before every write. Price changes are audited (`product.price_changed`).
- **Reads** need `product:read` held anywhere (`authorizeAnyScope`), so cashiers can search and
  scan; writes need an organization-level role and the matching `product:*` permission.
- **Guards added to Phase 0 services:** the organization currency is locked once any product
  exists (409 `CURRENCY_LOCKED`), and a tax rate any product uses cannot be deleted
  (409 `TAX_RATE_IN_USE`).
- **`syncIndexes` now covers `TaxRate`** (it was missing, so production never got its unique
  indexes) and the three catalog models. Run `npm run migrate` on deploy.

Bug found while testing: product writes built their documents before the transaction, and on a
transient-error retry `session.withTransaction` re-ran the callback with documents already marked
saved, so the retry tried to *update* a product the aborted attempt never committed
(`DocumentNotFoundError`, seen once under full-suite load). The service now uses
`connection.transaction()`, which resets document state between attempts; a test forces the
retry with a spied `save()`. The existing services load their documents inside the transaction
and are unaffected.

Reviews before commit:

- **pos-tester** added `catalogEdgeCases.test.ts` (28 tests: concurrent SKU/barcode/combination
  races give 409 never 500, EAN/ISBN cross-kind conflicts, operator-shaped and array query
  params, ReDoS-style searches, role edge cases, soft-deleted parents, audit contents and audit
  failure, guard ordering). No source bugs found.
- **swagger-docs** audit: each product write endpoint now documents only the error codes it can
  actually return (the shared 400 block listed codes some endpoints never throw), 409 examples
  show the real `errors[].field` paths, `PRODUCT_IN_USE` / `VARIANT_IN_USE` are marked reserved,
  and search/lookup/list-parsing behaviour is spelled out. Open question it raised: list `search`
  does not strip hyphens while `/products/lookup` does.

Test runner: `tests/setup.ts` now retries a failed in-memory replica-set start (3 attempts). The
start runs at module load, outside `hookTimeout`, and an occasional `WaitForPrimaryTimeoutError`
on a busy machine failed four whole files once during this work.

Manual: Requestly Section 7 (`docs/requestly/section-7-catalog.postman_collection.json`), replayed
against the app on the in-memory database before handing over. 579 tests pass.

---

## 📦 Catalog — subcategories

Approved 2026-10-15 after a tech-lead review, before Phase 2 (the stock ledger does not read
categories, but category reports will, so the tree is cheapest to add now).

- **Depth 2** (category → subcategory), one constant `MAX_CATEGORY_DEPTH` in
  `category.model.ts`; raising it needs no data change.
- **Model:** `parentId` (null for a root) plus `ancestors` (root first). Products keep a single
  `categoryId` and may sit on either level; ancestors are never copied onto products, so a move
  touches categories only.
- **Names unique among siblings:** the unique index is now `{organizationId, parentId, nameKey}`.
  The old `{organizationId, nameKey}` index must be dropped with `npm run sync:indexes -- --apply`
  on every environment, or it keeps refusing "Accessories" under a second parent (and the
  service reports that as `CATEGORY_NAME_TAKEN`, so it would look like correct behaviour).
- **Moves:** `PATCH /categories/{id}` with `parentId` (null for the top level). Refused with
  `CATEGORY_CYCLE` (itself or its own subcategory) or `CATEGORY_DEPTH_EXCEEDED` (the parent is a
  subcategory, or the category has subcategories and would stop being top-level). The move
  rewrites the ancestors of the whole subtree in a transaction; at depth 2 a category with
  children can only stay top-level, so that rewrite only does work once the limit is raised.
- **Delete:** `CATEGORY_IN_USE` (direct products) is unchanged and checked first; a category
  with subcategories is refused with `CATEGORY_HAS_CHILDREN` (`meta.childCount`).
- **Responses:** categories gain `parentId`, `depth` and `totalProductCount` (`productCount`
  stays direct-only); the list stays flat. A product's `category` gains `path`
  ("Mobiles › Accessories").
- **Product list:** `categoryId` now includes subcategories; `includeSubcategories=false` limits
  it to direct members.
- Categories stored before this change have neither field; Mongoose fills the defaults on read
  and MongoDB matches a missing `parentId` as null, so they behave as top-level categories
  without a data migration (covered by a test).

Concurrency (found by the pos-tester review): the tree checks span documents (a parent's depth,
a category's children), but each request checked them before writing, so two admins acting at
the same instant could put a child under a category being moved (leaving it 3 levels deep with
stale `ancestors`) or under one being deleted (an orphan). Create, move and delete now read and
check the tree inside the transaction that writes it, and putting a child under a category also
writes to that category (`claimParent`, which bumps a hidden `treeVersion`). MongoDB only
detects a conflict between transactions that write the same document, so this write makes the
two requests conflict; the loser is retried and its checks see the winner's result. Three tests
force each interleaving by pausing one request at its first write; all three fail with the claim
disabled. Products still don't claim their category, so a product created at the same instant
its category is deleted can reference a deleted category (noted in `deleteCategory`).

---

## 📦 Stock — Phase 2 contract (validators + Swagger, no endpoints yet)

The stock ledger API is defined first, for the frontend developer to sign off, as in Phase 1.
The new **Inventory** endpoints are documented in Swagger with a "contract preview" note and
return 404 until they are implemented.

Decisions (approved 2026-10-17):

- **Ledger.** Every change to stock is an append-only movement (`opening`, `adjustment`,
  `transfer_out`, `transfer_in`; purchases and sales will add more types). A stock level per
  store and variant is a projection, updated in the same transaction. Corrections are new
  movements, never edits.
- **Costing:** weighted average cost per store, VAT-exclusive, recorded on every movement.
- **Opening stock** goes on the product form as a per-store list
  (`inventory.openingStock` / `variants[i].openingStock`: `[{ storeId, quantity, unitCost? }]`),
  only when a product or variant is created.
- **Adjustments** (`POST /stores/{storeId}/stock-adjustments`, `inventory:adjust`) use a fixed
  reason list (damaged, expired, theft_loss, found, count_correction, other + note) and
  either a signed `quantityChange` or a `countedQuantity` ("set to counted").
- **Transfers** (`POST /stock-transfers`, organization role + `inventory:transfer`) are one
  step and instant, and always need stock at the source, even when negative stock is allowed.
- **Negative stock** follows `settings.inventory.allowNegativeStock` (`INSUFFICIENT_STOCK`).
- **Idempotency-Key header** is required on adjustments and transfers: a retry with the same
  key and body replays the first response.
- **Reads:** store stock list (`product:read`), a product's stock by store, store movement
  history and adjustments (`inventory:adjust`), transfers (`inventory:transfer`). Products gain
  `stockOnHand` (optional in the schema until the ledger ships).
- **Locks** once a variant has movements: `UNIT_LOCKED`, `STOCK_ON_HAND` (turning tracking off
  with stock), and `PRODUCT_IN_USE` / `VARIANT_IN_USE` become live.

Until the ledger ships, product create and add-variant refuse a well-formed `openingStock` with
400 `VALIDATION_FAILED` instead of silently dropping it.

Changes from the tech-lead review (approved 2026-10-17):

- **CORS** now allows the `Idempotency-Key` request header and exposes `Idempotent-Replayed`
  and `X-Request-Id`. Without it every adjustment and transfer would fail in the browser while
  passing in Supertest and Requestly, which skip preflight.
- **`opening_balance` reason** gives products created before stock tracking their first stock
  (add or count; writes `opening` movements) instead of mislabelling it `found`.
- **Reasons decide direction:** `damaged` / `expired` / `theft_loss` remove only, `found` and
  `opening_balance` add only, `count_correction` and `other` either way; counts only with
  `count_correction` or `opening_balance`.
- **New `inventory:read` permission** (store scope) for movements, adjustments, transfers and
  cost figures; seeded for store_manager, inventory_clerk and accountant (which also gains
  `product:read`), and org_admin gets every permission. Without it, stock reads show quantities
  but `averageCost` / `stockValue` are null, and once the ledger ships so is `costPrice`.
  Transfer reads are store-filtered rather than organization-only.
- **Open-ended response values:** a movement's `source.type` and `reason` are plain strings
  (later phases add values); `source.number` is reserved for document numbers.
- **Dates:** bare `from` / `to` dates are read in the organization's timezone, both inclusive.
- Opening stock `unitCost` stays **per unit**; the frontend labels it "rate per unit".

### Deploy note

Run `npm run sync:system-roles` (part of `npm run migrate`) so existing organizations' roles
receive `inventory:read` (and the accountant `product:read`).

Testing: `tests/unit/stockValidator.test.ts` pins the contract (Swagger examples parse, line
rules, reason directions, transfer rules, the idempotency header, opening stock on the product
form); `tests/integration/cors.test.ts` checks the preflight. The catalog route tests now use a
custom reports-only role as "an organization role without `product:read`".

The pos-tester review added `tests/integration/stockContract.test.ts` (opening stock refused on
create, add-variant and update without persisting anything; `inventory:read` seeding and the
system-role sync for existing organizations; accountant catalog access and tenant isolation; the
role privilege ceiling for `inventory:read`; the OpenAPI document lists the Inventory paths) and
`tests/unit/stockValidatorEdgeCases.test.ts` (quantity precision and range, non-numeric input,
strict-mode injection, notes, reasons, the idempotency key format). No source bugs found. The
"returns 404" and opening-stock refusal tests are in their own `describe` blocks, to be flipped
when the ledger ships. 684 tests pass.

---

## 📦 Stock — Phase 2 implementation

The Inventory endpoints are live behind the contract above; the "contract preview" notes are
gone from Swagger, and product create / add-variant now accept opening stock.

- **Models.** `StockMovement` (the ledger: append-only, the model refuses update and delete
  queries), `StockLevel` (one row per store and variant, a projection updated in the same
  transaction as each movement), `StockAdjustment`, `StockTransfer` and `IdempotencyKey`. Ledger
  models use `softDelete: false`. Quantities are stored in thousandths (`utils/quantity.ts`),
  money in minor units.
- **Engine** (`stockLedger.service.ts`): `applyMovement` is the only code that changes stock.
  Weighted average per store: a level keeps its total value rather than a rounded average, so
  receipts do not drift; removing stock uses the exact average and emptying it removes the exact
  remaining value; at 0 or below the level is worth 0 and the last average is kept.
- **Concurrency.** Changes read the level inside the transaction; two transactions writing the
  same level conflict and the loser is retried with fresh reads, so the last unit can never be
  removed twice and no addition is lost. Two first-ever movements racing to insert a level row
  are retried on the unique index.
- **Idempotency.** The key's record is inserted in the same transaction as the change: a crash
  rolls both back, and concurrent requests with one key conflict on that row, so exactly one
  applies and the others replay it. The fingerprint covers user, method, path and body. Records
  expire after 24 hours (TTL index).
- **Opening stock** is validated (active stores, units, costs) before the product transaction
  and written as `opening` movements inside it.
- **Catalog locks:** `PRODUCT_IN_USE`, `VARIANT_IN_USE`, `UNIT_LOCKED` and `STOCK_ON_HAND` are
  live. Product responses carry `stockOnHand` (active stores only); `costPrice` is null for
  callers without `inventory:read` or a product write permission.
- **Dates:** `utils/dateRange.ts` reads bare `from` / `to` dates in the organization's timezone.
- `opening_balance` counts below the current stock are refused (400), since that reason only
  adds stock.

### Deploy note

Run `npm run migrate`: it creates the indexes of the five new collections (including the TTL
index on idempotency keys) and gives existing roles `inventory:read`.

Testing: `tests/integration/stockLedger.test.ts` (28 tests over HTTP: opening stock, locks,
adjustments in both modes, reasons, negative stock, weighted average, transfers, idempotent
retries including concurrent ones, concurrent removals and additions, permissions and cost
visibility, history filters, the ledger invariant) and `tests/unit/stockMath.test.ts` (costing
and timezone date math). The Phase 2 contract tests that expected the interim refusal now check
the real store validation. 726 tests pass.

### pos-tester review

Found three inputs that returned 500, all fixed:

- An upper-case store id in the URL: `scopeToStore` put it into the request context as-is and
  the tenant plugin, which compares ids as strings, saw a mismatch. The context id is now
  lower-cased (this also covers the older `/stores/:storeId` routes).
- An absurd `?page=` (1e30, Infinity) overflowed the MongoDB skip on **every** list endpoint;
  `resolvePaging` now caps the page at 1,000,000.
- `?status=constructor` (an inherited object key) reached `$match`; status and reason lookups
  now use `Object.hasOwn`.

Design changes approved after the review (2026-10-20):

- The adjustment POST response no longer shows costs (`unitCost`, `valueChange`) to a caller
  without `inventory:read` for the store, matching every read endpoint.
- `GET /stock-transfers/{id}` returns 404 `TRANSFER_NOT_FOUND` for a transfer the caller may not
  see, as for one that does not exist, so ids cannot be probed.
- A transfer may take stock **out of a deactivated store** (only the destination must be
  active), so closing a branch no longer strands its stock or blocks switching tracking off.

Reviewed and holding: cross-tenant and cross-store isolation, idempotent replays (per store, per
user, byte-identical, failures never stored), races between transfers and adjustments, a
5000-step random run of the costing invariants, and every response against its Zod schema.
`IDEMPOTENCY_IN_PROGRESS` is practically unreachable (concurrent duplicates conflict and
replay). New: `tests/integration/stockLedgerReview.test.ts` (69 tests) and
`tests/unit/stockMathEdgeCases.test.ts` (14). 810 tests pass.

---

## 🧾 Purchases — Phase 3 plan

Phase 3 builds purchasing natively (no Zoho), in five sub-phases, each contract-first:
**3a vendors**, **3b purchase orders**, **3c goods receipts** (the only thing that adds stock),
**3d vendor bills and payments**, **3e returns to vendor** (damaged, expired, wrong item, excess)
with debit notes. Later: PO approvals, landed cost, foreign-currency bills, purchase units
(cartons), reorder suggestions, vendor statements, emailed POs.

Decisions (approved 2026-10-21; the Purchases Specification v2 may still refine them):

- Goods can be received without a PO.
- A bill without a receipt is only for services (rent, freight); goods bills link to receipts.
- Posted receipts are never edited or cancelled: fix them with a return or an adjustment.
- Returns always need stock on hand, even when negative stock is allowed.
- Receiving does not overwrite the product's cost price; "last purchase cost" is kept separately.
- An organization without a TRN cannot reclaim input VAT, so VAT goes into its stock cost.
- No foreign-currency bills in v1: everything is in the organization's currency.
- One store per PO and receipt; vendors and bills are organization-wide. Numbers are per
  organization and document type (PO-, GRN-, DN-).
- A return may link to the receipt it came from (optional); vendor credit is used against
  later bills.

## 🧾 Purchases — Phase 3a contract (vendors: validators + Swagger, no endpoints yet)

The **Vendors** endpoints (`GET/POST /vendors`, `GET/PATCH/DELETE /vendors/{vendorId}`) are
documented in Swagger with a "contract preview" note and return 404 until implemented.

- **Fields:** `name` (required, unique per organization, case-insensitive), `legalName`,
  `taxRegistrationNumber` (normalised like the organization's TRN; not unique, since branches
  share one), `countryCode` (any country; defaults to the organization's country from its
  currency), `vatTreatment` (see the review changes below),
  `contactName`, `email`, `phone`, `address` (all parts optional, merged on update),
  `paymentTermsDays` (0-365, default 0), `notes`, `isActive`. No currency: v1 bills are in the
  organization's currency.
- **List:** paginated by name, with `search` (name, legal name, TRN, phone, email),
  `isActive`, `countryCode` and `vatTreatment`. Each vendor shows `productCount` (products naming it as
  preferred).
- **Deactivate** (`isActive: false`) hides a vendor from pickers (what it blocks: see the
  review changes below). **Delete** is a soft delete that clears products' preferred vendor; once purchasing
  ships, a vendor with documents is refused (`VENDOR_IN_USE`). Posted documents will keep a copy
  of the vendor's details, so later edits never change them.
- **Product form:** `purchase.preferredVendorId` replaces the free-text `preferredVendorName`
  (deprecated, removed when vendors ship; existing names are not converted). Products read back
  `purchase.preferredVendor: { id, name, isActive } | null` (optional in the schema until then).
  Until vendors ship, product create and update refuse `preferredVendorId` with 400
  `VALIDATION_FAILED` instead of silently dropping it.
- **Permissions:** `vendor:manage` (organization scope) for writes; `purchase:read` (store
  scope, held anywhere) for reads, so staff receiving goods can pick the vendor (product
  editors too: see below). Seeded:
  org_admin both, accountant both, store_manager and inventory_clerk `purchase:read`, cashier
  neither.
- **Error codes:** `VENDOR_NOT_FOUND`, `VENDOR_NAME_TAKEN`, `VENDOR_INACTIVE`, `VENDOR_IN_USE`.
- `taxRegistrationNumberField` moved into `organization.validator.ts` as a shared export.

Changes from the tech-lead review (approved 2026-10-21):

- **`vatTreatment`** (`vat_registered` / `not_registered` / `overseas`) is an explicit vendor
  field instead of being inferred from country + TRN at bill time, which breaks for intra-GCC
  supplies, unregistered local vendors and designated zones. On create it defaults from the
  TRN and country (TRN → `vat_registered`; no TRN and foreign → `overseas`; else
  `not_registered`); on update it changes only when sent. `vat_registered` needs a TRN. Posted
  documents keep a copy. Response consumers treat it as open-ended.
- **Deactivation** blocks only new purchase orders and receipts without a PO. Receipts against
  open POs, bills, payments and returns stay allowed, so goods in transit and money owed can be
  settled.
- **Vendor reads** also allow `product:create` / `product:update` (held anywhere), so a catalog
  editor role without `purchase:read` can still load the preferred-vendor picker.
- **`preferredVendorId` is checked only when sent**, so an unrelated product edit never fails
  because the stored vendor was later deactivated or deleted.
- **Search:** TRN terms are normalised like the field; email terms lowercased; phone matches
  the term's digits anywhere in a digits-only key, from 4 digits.
- **`countryCode`** is checked against the 249 assigned ISO 3166-1 alpha-2 codes
  (`src/config/isoCountries.config.ts`), on the body and on the list filter (uppercased). `UK`
  and `XX` are rejected.
- **For 3b:** vendor delete vs. purchase-document create will be claim-style
  (`findOneAndUpdate` on a `hasDocuments` flag), so no PO, receipt or bill can attach to a
  vendor being deleted. A dangling `preferredVendorId` after the delete/product-save race reads
  as null and is accepted.
- **Not added, on purpose:** vendor opening balance (comes in 3d as an opening-balance bill,
  so payables come only from documents), vendor code, multiple contacts, bank details.
- **When vendors ship:** count products with a `preferredVendorName` before removing it; if any
  real tenant has some, copy them into `purchase.description` instead of dropping them.

### Deploy note

Run `npm run migrate` (it includes `sync:system-roles`) so existing organizations' roles receive
`vendor:manage` and `purchase:read`.

Testing: `tests/unit/vendorValidator.test.ts` pins the contract (Swagger examples parse, field
rules, update rules, `preferredVendorId` on the product form);
`tests/integration/vendorContract.test.ts` covers the `preferredVendorId` refusal (nothing
persisted), the 404 routes, role seeding and the sync for existing organizations, role scope
rules for the new keys, and the OpenAPI document. The refusal and 404 tests are in their own
`describe` blocks, to be flipped when vendors ship. The Phase 2 role-sync test now also expects
the Phase 3a keys.

---

## 🧾 Purchases — Phase 3a implementation (vendors)

The Vendors endpoints are live behind the Phase 3a contract.

- **Model** `Vendor` (organization-scoped, soft delete): `nameKey` backs a unique
  `{ organizationId, nameKey }` index on non-deleted vendors; `phoneKey` (digits only) backs the
  phone search. TRNs are stored normalised. Address is always present with null parts.
- **Create** fills `countryCode` from the organization's currency (BHD → BH) and derives
  `vatTreatment` when omitted. **Update** applies only the sent fields, merges `address` field by
  field (`null` clears it), never re-derives `vatTreatment`, and refuses `vat_registered` when the
  resulting TRN is empty. Name clashes are `VENDOR_NAME_TAKEN` (pre-check plus the unique index for
  concurrent creates).
- **List** sorts by name; filters are lenient like the other lists (an unknown country or VAT
  treatment matches nothing). `productCount` is one grouped read per page.
- **Delete** soft-deletes and clears `purchase.preferredVendorId` on products in one
  transaction. `VENDOR_IN_USE` arrives with purchase documents in 3b.
- **Reads** use `authorizeAnyScope("purchase:read", "product:create", "product:update")`;
  `authorizeAnyScope` now accepts several permissions (any one suffices).
- **Products:** `purchase.preferredVendorId` replaces `preferredVendorName` (now an unknown
  field, 400). It is checked only when sent (`VENDOR_NOT_FOUND` / `VENDOR_INACTIVE`, 400, field
  `purchase.preferredVendorId`). Products read back `purchase.preferredVendor: { id, name,
  isActive } | null`; a deleted vendor reads as null. New index
  `{ organizationId, "purchase.preferredVendorId" }`.
- **Migration** `npm run migrate:vendor-names` (now part of `npm run migrate`) appends each old
  free-text name to the product's purchase description ("Preferred vendor: …", kept within 1000
  characters) and removes the field. Idempotent.
- **Test setup** now waits for every model's indexes (`Model.init()`) before tests run. Without
  it a file's first tests could run before a unique index existed, which made the concurrent-SKU
  test flaky once the new product index and vendor collection lengthened index builds.

### Deploy note

Run `npm run migrate`: it builds the vendor and product indexes, syncs the role permissions and
migrates the old vendor names.

Testing: `tests/integration/vendors.test.ts` (create defaults and VAT derivation, uniqueness
including concurrent creates, reads and tenant isolation, search and filters, update rules,
permissions per role including a catalog-editor custom role, the preferred vendor on products,
delete clearing, dangling references, the name migration). `vendorContract.test.ts` was flipped
to the shipped behaviour. 882 tests pass.

### pos-tester review

Fixed:

- A NUL byte in `search` (`?search=%00`) returned 500, because MongoDB rejects such a regex. The
  term now drops NUL bytes in the vendor, product and store stock lists (the latter two had the
  same bug).
- The name migration turned a whitespace-only name into a bare "Preferred vendor: " line; such
  values are now just removed.
- `mergedDescription` cut the vendor line when the existing description was near 1000
  characters; it now shortens the existing description instead, so the name is kept.

Reviewed and holding: tenant isolation (reads, writes, deletes, `productCount`, cross-org
`preferredVendorId`), the read/write permission gates, delete atomicity (a failed product clear
rolls the vendor delete back), every response against its Zod schema, and hostile query, path and
body input. Known and accepted: lenient list filters (as on the other lists), two concurrent
deletes of one vendor both return 200, and soft-deleted products keep a dangling
`preferredVendorId` (reads as null). An organization role with only `vendor:manage` cannot read
vendors (the documented read gate); seeded roles always pair it with `purchase:read`.
New: `tests/integration/vendorReview.test.ts` (88 tests). 971 tests pass.

---

## 🧾 Purchases — Phase 3b contract (purchase orders: validators + Swagger, no endpoints yet)

The **Purchase Orders** endpoints are documented in Swagger with a "contract preview" note and
return 404 until implemented: `GET /purchase-orders` (cross-store list),
`GET/POST /stores/{storeId}/purchase-orders`,
`GET/PATCH/DELETE /stores/{storeId}/purchase-orders/{purchaseOrderId}`, and `POST …/issue`,
`…/cancel`, `…/close`.

Decisions (approved 2026-10-27, all as the tech lead recommended):

1. The number (PO-00001, per organization) is given when the draft is created; deleted drafts
   leave gaps (a PO is not a tax document).
2. An issued PO stays editable until the first goods receipt, then it is locked.
3. VAT is shown as an estimate; the vendor's bill (3d) has the final figure.
4. Services are refused on POs; they go straight onto bills in 3d.
5. Store managers (own store) and org admins create POs: new permission `purchase:order`.
6. No line discounts in v1.

- **Lifecycle:** `draft` → `issued` → `partially_received` → `received` (the last two set only
  by goods receipts in 3c), plus `cancelled` (issued, nothing received) and `closed` (partly
  received, the rest will not come). Drafts can be deleted (soft); nothing else can. A PO never
  changes stock. Responses carry `editable` so the UI can show or hide Edit.
- **Fields:** the store comes from the URL (active, fixed once created), `vendorId` (active;
  changeable on drafts only), `orderDate` (calendar date, default today in the store's timezone),
  `expectedDate` (on or after `orderDate`), `vendorReference` (≤50), `notes` (≤1000, printed for
  the vendor), `lines` (1-200, each variant once: `variantId`, `quantity`, optional `unitCost`
  defaulting to the variant's cost price, else `UNIT_COST_REQUIRED`, optional `note` ≤200).
  PATCH replaces all lines when `lines` is sent, so clients resend every line's `unitCost` (a
  line without one would pick up the current cost price). Inactive products/variants and untracked goods
  are allowed; services are `VARIANT_NOT_PURCHASABLE`.
- **Estimated VAT** per line: when the vendor is `vat_registered` and the product `standard`,
  subtotal × the product's rate (or the organization's default); otherwise 0 (`overseas`: reverse
  charge). Recomputed whenever the lines or vendor are saved, and again at issue. Rounded per
  line; totals are sums.
- **Vendor copy:** from issue, the PO shows the vendor's name, legal name, TRN and VAT treatment
  as they were at issue; only `isActive` stays live. The estimate is recomputed against that copy
  at issue, and edits after issue use the copied VAT treatment, so the VAT never contradicts it.
- **Safety:** create needs an `Idempotency-Key` (same middleware as stock). Every change to an
  existing PO sends `version` (body; query string on DELETE) and gets 409
  `PURCHASE_ORDER_VERSION_CONFLICT` (`meta.currentVersion`) when it is stale: the first optimistic
  concurrency check in the API. The version is checked before the status, so a retried
  successful action (a second click on Issue) is a version conflict too: clients reload on any
  409. A deactivated vendor blocks create and issue, not edits, cancel or
  close of issued POs. Wrong-status actions are 409 `PURCHASE_ORDER_STATUS_CONFLICT`
  (`meta: { status, allowed }`).
- **Routes (changed in the tech-lead review):** everything that touches one PO is under
  `/stores/{storeId}/…`, so `scopeToStore` verifies the store before `authorize` checks the
  store-level permission, as for stock adjustments. A `storeId` in the body, or one resolved from
  the PO, would have meant new authorization code (`authorize` deliberately never trusts a
  caller-supplied store). Read, cancel and close use `scopeToStoreAllowInactive`.
- **Reads:** `purchase:read` for the store (store role there, or an organization role). The
  cross-store `GET /purchase-orders` takes `purchase:read` held anywhere and is narrowed to the
  caller's stores; both lists filter by `vendorId`, `status` (comma list), `from`/`to` on
  `orderDate` and `search` on number or vendor reference (plus `storeId` on the cross-store one).
  Writes: `purchase:order` for the store; a deactivated store's POs can still be read, cancelled
  and closed. No access to the store is 403 (as everywhere); a PO not in that store is 404.
- **Delete rules (documented now, enforced with the implementation):** a vendor with any PO
  (deleted drafts excluded) is `VENDOR_IN_USE`; a product or variant on an open PO (draft, issued,
  partially received) is `PRODUCT_IN_USE` / `VARIANT_IN_USE`.
- **Permissions:** `purchase:order` (store scope), seeded on org_admin and store_manager. The
  accountant and inventory clerk keep read-only access.
- **Error codes:** `PURCHASE_ORDER_NOT_FOUND`, `PURCHASE_ORDER_VERSION_CONFLICT`,
  `PURCHASE_ORDER_STATUS_CONFLICT`, `VARIANT_NOT_PURCHASABLE`, `UNIT_COST_REQUIRED`, plus the
  existing `VENDOR_NOT_FOUND`, `VENDOR_INACTIVE`, `VARIANT_NOT_FOUND`, `STORE_NOT_FOUND`, money and
  idempotency codes.
- The stock docs' idempotency helpers (`IDEMPOTENCY`, `REPLAY_HEADERS`, `idempotency409`,
  `QUANTITY_RULE`) are now exported for reuse.

For the implementation (from the tech-lead review, not contract changes):

- Version checks as a conditional `findOneAndUpdate({ _id, version })` inside the transaction,
  never read-then-compare.
- PO numbers from an atomic `$inc` counter inside the create transaction, with a unique index on
  `{ organizationId, number }`.
- Escape the `search` prefix before building the regex.
- Put the blocking PO number(s) in `PRODUCT_IN_USE` / `VARIANT_IN_USE` meta (a forgotten draft
  blocks deletion, which is acceptable).
- Decide whether a product on an open PO may switch from goods to service (refusing is simplest).
- Vendor delete vs. PO create is claim-style from the start (the 3a plan: `findOneAndUpdate` on a
  vendor `hasDocuments` flag), so no PO can attach to a deleted vendor. The product
  deleted-while-a-PO-is-saved race waits for go-live, with the deferred catalog delete races.
- 3c: a receiving permission for the inventory clerk, and what a receipt does for untracked goods.

### Deploy note

Run `npm run migrate` (it includes `sync:system-roles`) so existing organizations' org_admin and
store_manager roles receive `purchase:order`.

Testing: `tests/unit/purchaseOrderValidator.test.ts` pins the contract (Swagger examples parse,
line, date, text and status-change rules, `version` handling);
`tests/integration/purchaseOrderContract.test.ts` covers role seeding and the sync for existing
organizations, role scope rules for the new key, the 404 preview routes and the OpenAPI document.
994 tests pass.
