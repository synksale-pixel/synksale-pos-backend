# Organization Onboarding: Frontend Integration Guide

Organizations cannot use the system right after signing up. They apply, and a Super Admin must approve the application before anyone in that organization can log in.

## Overview

```
signup ─► pending ──approve──► approved ──(suspended by admin)──► suspended
             │
             └──reject──► rejected
```

| Status | Meaning | Can log in? |
|---|---|---|
| `pending` | Application submitted, awaiting review | No (403) |
| `approved` | Approved by a Super Admin | Yes |
| `rejected` | Application declined | No (403) |

**Conventions**
- Base URL: `{{base_url}}/api/v1` (ask the backend developer for the dev/staging URL).
- Every response uses the shape `{ statusCode, data, message, success }`.
- Interactive API docs (Swagger UI, non-production only): `{{base_url}}/api-docs`. The raw spec is at `{{base_url}}/api-docs.json`.
- The backend's CORS allow-list must include the frontend origin, or the browser will block requests.

---

## 1. Signup screen (public)

`POST /auth/signup`

```json
{
  "organizationName": "Acme Traders",
  "contactEmail": "contact@acme.com",
  "contactPhone": "+919876543210",
  "adminFirstName": "John",
  "adminLastName": "Doe",
  "adminEmail": "john@acme.com",
  "adminPassword": "min8chars"
}
```

| Field | Required | Rules |
|---|---|---|
| `organizationName` | Yes | 2–100 characters |
| `contactEmail` | No | Valid email. If omitted, `adminEmail` is used |
| `contactPhone` | Yes | 7–20 characters: optional leading `+`, digits, spaces, `-`, `()` |
| `adminFirstName` | Yes | 1–50 characters |
| `adminLastName` | Yes | 1–50 characters |
| `adminEmail` | Yes | Valid email |
| `adminPassword` | Yes | At least 8 characters |

Sending an empty string for `contactEmail` fails validation. Omit the field instead.

**Success: `201`**
```json
{
  "statusCode": 201,
  "data": {
    "organization": {
      "id": "…",
      "name": "Acme Traders",
      "slug": "acme-traders",
      "approvalStatus": "pending"
    }
  },
  "message": "Application received. You will be notified once your organization is approved.",
  "success": true
}
```

- **No tokens are returned.** Show an "Application received, awaiting approval" screen.
- Show the `slug` to the user. They need it to log in.

**Errors**

| Status | When | What to show |
|---|---|---|
| `400` | Validation failed | Field-level errors |
| `409` | This admin email already has a pending or approved application | "An application with this email already exists" |

---

## 2. Login screen

`POST /auth/login`

```json
{ "orgSlug": "acme-traders", "email": "john@acme.com", "password": "min8chars" }
```

**Success: `200`**
```json
{
  "data": {
    "accessToken": "…",
    "refreshToken": "…",
    "user": { },
    "organization": { "id": "…", "name": "…", "slug": "…" }
  }
}
```

**Errors**

| Status | Meaning | What to show |
|---|---|---|
| `401` | Wrong slug, email, or password | A generic "Invalid credentials". The backend deliberately does not say which one is wrong |
| `403` | Credentials are correct, but the account is not allowed in | Show `message` as-is |

The `403` message is one of:
- "Your organization application is still pending review."
- "Your organization application was not approved."
- "Access Denied: Your organization account has been suspended."
- "Access Denied: Your user account has been deactivated."

A `403` is only returned after the password is verified. Wrong credentials always get `401`.

---

## 3. Token handling (tenant users)

| Token | Lifetime |
|---|---|
| Access token | 15 minutes |
| Refresh token | 7 days |

- Send `Authorization: Bearer <accessToken>` on protected requests.
- On a `401`, refresh: `POST /auth/refresh` with `{ "refreshToken": "…" }`.
- **Refresh tokens rotate.** Each refresh returns a new access token and a new refresh token, and the old refresh token stops working. Always store both new values.
- If the refresh call fails, clear the stored tokens and send the user to the login screen.
- Logout: `POST /auth/logout` (single device) or `POST /auth/logout-all`.
- Current user and permissions: `GET /auth/me`. Pass `?storeId=…` to include store-specific permissions.

---

## 4. Super Admin panel

Super Admins are created by the backend team (CLI script). There is no signup for them. Their tokens are separate from tenant tokens: a platform token does not work on tenant routes, and a tenant token does not work on platform routes.

### Authentication

`POST /platform/auth/login` with `{ "email": "…", "password": "…" }`

| Token | Lifetime |
|---|---|
| Access token | 10 minutes |
| Refresh token | 3 days |

- Refresh: `POST /platform/auth/refresh` with `{ "refreshToken": "…" }` (tokens rotate, same as above).
- Logout: `POST /platform/auth/logout`.
- Send `Authorization: Bearer <platformAccessToken>` on all requests below.
- Store the platform tokens separately from tenant tokens.

### Application review

Base path: `/platform/organizations`

| Endpoint | Purpose |
|---|---|
| `GET /platform/organizations?status=pending&page=1&limit=20` | List applications. `status` is optional (`pending`, `approved`, `rejected`). `limit` is at most 100 |
| `GET /platform/organizations/:id` | Full detail of one application |
| `POST /platform/organizations/:id/approve` | Approve. Optional body `{ "slug": "new-slug" }` to correct the slug |
| `POST /platform/organizations/:id/reject` | Reject. Body `{ "reason": "5–500 characters" }` |

**List response**
```json
{
  "data": {
    "organizations": [ ],
    "pagination": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 }
  }
}
```

Each organization includes `name`, `slug`, `contactEmail`, `contactPhone`, `applicantEmail` (the admin's email), `approvalStatus`, `createdAt`, and the approval or rejection details (`approvedAt`, `rejectedAt`, `rejectionReason`).

**Approve: errors**

| Status | Reason |
|---|---|
| `400` | Already approved |
| `404` | Organization not found |
| `409` | The same applicant has another pending or approved organization, or the requested slug is already taken |

Approving a previously rejected application is allowed (re-review).

**Reject: errors**

| Status | Reason |
|---|---|
| `400` | Only pending applications can be rejected |
| `404` | Organization not found |

Suggested UI: a "Pending" tab as the default view, a detail page showing the applicant's contact details, and Approve / Reject buttons. Reject should open a dialog with a required reason (5–500 characters).

---

## Things to know

- **No notifications yet.** There is no email service, so applicants are not told when they are approved or rejected. Until that exists, the Super Admin must tell them, and the applicant will otherwise only find out by trying to log in.
- **Slug can change at approval.** If the Super Admin edits the slug when approving, the slug shown to the applicant at signup is out of date. The approve response contains the final slug.
- **Re-applying.** A rejected applicant can sign up again with the same admin email. A proper re-apply flow is planned but not built yet.
- **Same email, different roles.** A Super Admin's email does not block a tenant signup with the same email. The two accounts are separate.
- **Error format.** Validation errors (`400`) come back through the global error handler. Check the Swagger docs for the exact shape of the field errors.
