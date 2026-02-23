# API Architecture

> Type-safe API request system with WebSocket-first architecture and HTTP fallback.

---

## Quick Reference

```typescript
// Full route-name API call
const result = await apiRequest({
  name: "examples/getUserData",
  version: "v1",
  data: { userId: "123" },
  abortable: true, // Optional: auto-cancels if called again before response
});

// Nested page API call
const nestedResult = await apiRequest({
  name: "test/nestedTest/info",
  version: "v1",
});

// Root-level API call (no prefix)
const session = await apiRequest({ name: "session", version: "v1" });

// HTTP fallback (same API, no WebSocket needed)
// GET /api/examples/getUserData/v1?userId=123
// POST /api/examples/getUserData/v1 with JSON body
```

---

## File Structure

```
src/
├── _api/                       # Root-level APIs (callable from any page)
│   ├── session_v1.ts           # → api/session/v1
│   └── logout_v1.ts            # → api/logout/v1
├── {page}/_api/
│   ├── {apiName}_v1.ts         # → api/{page}/{apiName}/v1
│   └── {subfolder}/            # Nested: api/{page}/{subfolder}/{apiName}/v1
│       └── {apiName}_v1.ts
└── _sockets/
    ├── apiRequest.ts           # Client-side API caller
    └── apiTypes.generated.ts   # Auto-generated types
```

---

## Creating an API

### 1. Create the file

Template is injected automatically for empty files.

```typescript
// src/examples/_api/getUserData_v1.ts
import { AuthProps, SessionLayout } from "config";
import { Functions, ApiResponse } from "src/_sockets/apiTypes.generated";

// Rate limit: requests per minute (false = use global config)
export const rateLimit: number | false = 60;

// HTTP method (optional - inferred from name if not set)
// export const httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET';

export const auth: AuthProps = {
  login: true, // Require authentication
  additional: [], // Extra requirements: 'admin', etc.
};

export interface ApiParams {
  data: {
    userId: string; // Input from client
  };
  user: SessionLayout;
  functions: Functions;
}

export const main = async ({
  data,
  user,
  functions,
}: ApiParams): Promise<ApiResponse> => {
  const userData = await functions.db.prisma.user.findUnique({
    where: { id: data.userId },
  });

  return {
    status: "success",
    // Optional per-response HTTP status (for network response)
    // httpStatus: 201,
    userData,
  };
};

// Error shape is strict:
// { status: 'error', errorCode: string, errorParams?: { key: string; value: string | number | boolean }[], httpStatus?: number }
// Message is resolved server-side from errorCode + errorParams using i18n.

// Success shape is strict too:
// Must include status: 'success' and may include any additional payload keys.
```

### 2. Use from client

```typescript
// Types are auto-generated - full autocomplete!
const result = await apiRequest({
  name: "examples/getUserData",
  version: "v1",
  data: { userId: "123" },
});

if (result.status === "success") {
  console.log(result.userData); // Typed correctly
}
```

---

## HTTP API Access

APIs are accessible via HTTP for testing, webhooks, or non-socket clients.

### RESTful Routes

Examples:

- `GET /api/examples/getUserData/v1?userId=123`
- `POST /api/examples/createUser/v1`
- `PUT /api/settings/updateProfile/v1`
- `DELETE /api/examples/deleteUser/v1`

### Versioning Rules

- API filenames are required to end with `_v{number}.ts`.
- URLs are required to end with `/{version}`.
- Invalid unversioned API filenames do not get route templates injected.

### Method Inference

If `httpMethod` is not exported, it's inferred from the API name:

| Name Prefix                  | Inferred Method |
| ---------------------------- | --------------- |
| `get*`, `fetch*`, `list*`    | GET             |
| `delete*`, `remove*`         | DELETE          |
| `update*`, `edit*`, `patch*` | PUT             |
| Everything else              | POST            |

### Authentication

Include token via:

- **Cookie**: `token=your-token` (set automatically on login)
- **Header**: `Authorization: Bearer your-token`

For translated error responses over HTTP, send one of:

- `Accept-Language: en`
- `X-Language: en`

### Response Contract

- API handlers must return exactly one of:
  - success: `{ status: 'success', ...payload }`
  - error: `{ status: 'error', errorCode: string, errorParams?: [...], httpStatus?: number }`
- HTTP responses normalize errors to include localized `message` and final `httpStatus`.

---

## Abort Controller

GET-style APIs automatically use abort controllers to cancel in-flight requests.

```typescript
// These automatically cancel previous calls if called again:
await apiRequest({ name: 'examples/getUserData', version: 'v1', data: {...} });

// Explicit control:
await apiRequest({ name: 'examples/createUser', version: 'v1', data: {...}, abortable: true });  // Force
await apiRequest({ name: 'examples/getUser', version: 'v1', data: {...}, abortable: false });    // Disable
```

## Offline Request Queue

When the socket is disconnected or the browser is offline, `apiRequest` automatically queues requests in memory. The queue flushes on reconnect or when the browser comes back online. Aborted requests are removed from the queue.

## Rate Limiting

Configure globally in `config.ts`:

```typescript
rateLimiting: {
  defaultApiLimit: 60,   // Requests per minute per user
  defaultIpLimit: 100,   // Per-IP limit (unauthenticated)
  windowMs: 60000,       // 1 minute window
}
```

Or per-API:

```typescript
// In any _api/*.ts file
export const rateLimit = 30; // Override global
export const rateLimit = false; // Disable for this API
```

---

## Runtime Function Reference

| File | Function | Purpose |
| ---- | -------- | ------- |
| `server/sockets/handleApiRequest.ts` | `default export` | Handles websocket API requests (`apiRequest`), validates auth/rate-limit, executes API module, emits response. |
| `server/sockets/handleHttpApiRequest.ts` | `handleHttpApiRequest` | Handles HTTP API calls (`/api/...`) with shared auth/validation/error-normalization behavior. |
| `server/utils/runtimeTypeValidation.ts` | `validateInputByType` | Validates request payloads against extracted runtime input types with path-level error messages. |
| `server/utils/runtimeTypeResolver.ts` | `resolveRuntimeTypeText` | Resolves local/imported/re-exported type aliases and expands utility wrappers (`Partial`, `Required`, `Pick`, `Omit`, `Record`) before validation. |
| `server/utils/responseNormalizer.ts` | `normalizeErrorResponse` | Normalizes `errorCode/errorParams` into localized error responses. |
| `server/utils/rateLimiter.ts` | `checkRateLimit` | Applies configured rate-limit windows and limits. |
| `src/_sockets/apiRequest.ts` | `apiRequest` | Typed client request API with queueing and abort-controller support. |
