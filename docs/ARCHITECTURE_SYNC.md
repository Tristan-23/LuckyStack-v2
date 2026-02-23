# Sync Architecture

> Real-time event broadcasting between clients using rooms.

---

## Quick Reference

```typescript
// Client A sends sync event
await syncRequest({
  name: "examples/updateCounter",
  version: "v1",
  data: { amount: 5 },
  receiver: "game-room-123",
});

// Client B receives (via callback)
const { upsertSyncEventCallback } = useSyncEvents();
upsertSyncEventCallback({
  name: "examples/updateCounter",
  version: "v1",
  callback: ({ clientOutput, serverOutput }) => {
    console.log("Counter updated:", serverOutput.newValue);
  },
});

// Nested page sync
await syncRequest({
  name: "test/nestedTest/room",
  version: "v1",
  data: { step: 1, active: true },
  receiver: "game-room-123",
});
```

---

## File Structure

```
src/
├── {page}/_sync/
│   ├── {syncName}_server_v1.ts    # Runs on the server just once
│   ├── {syncName}_client_v1.ts    # Runs on the server for each client
│   └── ...
Versioned naming is required:

- `{syncName}_server_v1.ts`
- `{syncName}_client_v1.ts`

└── _sockets/
    ├── syncRequest.ts          # Client-side sync caller
    └── apiTypes.generated.ts   # Auto-generated types
```

---

## Creating a Sync Event

### 1. Server handler (optional)

```typescript
// src/examples/_sync/updateCounter_server_v1.ts
import { AuthProps, SessionLayout } from "../../../config";
import {
  Functions,
  SyncServerResponse,
} from "../../../src/_sockets/apiTypes.generated";

export const auth: AuthProps = {
  login: true,
  additional: [],
};

export interface SyncParams {
  clientInput: {
    // Define the data shape sent from the client e.g.
    amount: number;
  };
  user: SessionLayout; // session data of the user who called the sync event
  functions: Functions; // functions object
  roomCode: string; // room code
}

export const main = async ({
  clientInput,
  user,
  functions,
  roomCode,
}: SyncParams): Promise<SyncServerResponse> => {
  // THIS FILE RUNS JUST ONCE ON THE SERVER

  // Please validate clientInput here and dont just send the data back to the other clients
  // optional: database action or something else

  return {
    status: "success",
    newValue: clientInput.amount + 1,
    // Add any data you want to broadcast to clients
  };
};
```

### 2. Client handler (optional)

```typescript
import { SessionLayout } from "../../../config";
import {
  Functions,
  SyncClientResponse,
  SyncClientInput,
  SyncServerOutput,
} from "../../../src/_sockets/apiTypes.generated";

// Types are imported from the generated file based on the _server.ts definition
type PagePath = "examples";
type SyncName = "updateCounter";
export interface SyncParams {
  clientInput: SyncClientInput<PagePath, SyncName>;

  serverOutput: SyncServerOutput<PagePath, SyncName>;
  // Note: No serverOutput in client-only syncs (no _server.ts file)
  user: SessionLayout; // session data from any user that is in the room
  functions: Functions; // contains functions available from server/functions
  roomCode: string; // room code
}

export const main = async ({
  user,
  clientInput,
  serverOutput,
  functions,
  roomCode,
}: SyncParams): Promise<SyncClientResponse> => {
  // CLIENT FILTER/RULE STAGE: runs on server for each target client in the room

  // Example: Only allow users on set page to receive the event
  // if (user?.location?.pathName === '/your-page') {
  //   return { status: 'success' };
  // }

  return {
    status: "success",
    // Add any additional data to pass to the client
  };
};
```

## Receiving Sync Events

```typescript
import { useSyncEvents } from "src/_sockets/syncRequest";

const { upsertSyncEventCallback } = useSyncEvents();

upsertSyncEventCallback({
  name: "examples/updateCounter",
  version: "v1",
  callback: ({ clientOutput, serverOutput }) => {
    // clientOutput = result from _client.ts
    // serverOutput = result from _server.ts
    updateUI(serverOutput.newValue);
  },
});

// Register callback for a nested page sync
upsertSyncEventCallback({
  name: "test/nestedTest/room",
  version: "v1",
  callback: ({ serverOutput }) => {
    updateUI(serverOutput.step);
  },
});
```

## Offline Request Queue

When the socket is disconnected or the browser is offline, `syncRequest` queues requests in memory and flushes on reconnect or when the browser comes back online.

---

### Room-specific sync

```typescript
// Only users in 'game-room-123' receive this
await syncRequest({
  name: "chess/moveChessPiece",
  version: "v1",
  data: { from: "e2", to: "e4" },
  receiver: "game-room-123",
});
```

## HTTP Sync Endpoint

Sync can be triggered through HTTP:

- `POST /sync/{page}/{syncName}/{version}`

Body:

```json
{
  "data": { "some": "payload" },
  "receiver": "room-code",
  "ignoreSelf": false
}
```

Note: HTTP is only the trigger. Actual delivery still happens via Socket.io to users in the target room.

---

---

## Type System

| Property       | Source                         | Description              |
| -------------- | ------------------------------ | ------------------------ |
| `clientInput`  | `data` param in syncRequest    | What client sends        |
| `serverOutput` | `_server.ts` return            | Server processing result |
| `clientOutput` | `_client.ts` clientMain return | Client processing result |

### Error Contract

- Sync errors should return `status: 'error'` with an `errorCode` (and optional `errorParams` / `httpStatus`).
- Server resolves the final `message` through i18n using `errorCode` + `errorParams`.
- Avoid hardcoded human-readable error messages in server sync handlers.

---

## Runtime Function Reference

| File | Function | Purpose |
| ---- | -------- | ------- |
| `server/sockets/handleSyncRequest.ts` | `default export` | Handles socket sync requests (`sync` event), auth checks, executes `_server/_client`, emits responses. |
| `server/sockets/handleHttpSyncRequest.ts` | `default export` | HTTP-triggered sync entrypoint (`POST /sync/...`) that still delivers via Socket.io. |
| `server/utils/runtimeTypeValidation.ts` | `validateInputByType` | Validates sync `clientInput` payloads against extracted runtime types and returns path-first diagnostics. |
| `server/utils/runtimeTypeResolver.ts` | `resolveRuntimeTypeText` | Resolves local/imported/re-exported input type aliases and supported utility wrappers before sync validation. |
| `server/sockets/socket.ts` | `socket.on('sync', ...)` | Wires incoming sync events to the sync handler. |
| `src/_sockets/syncRequest.ts` | `syncRequest` | Typed client sender for sync events. |
| `src/_sockets/syncRequest.ts` | `useSyncEvents().upsertSyncEventCallback` | Typed callback registry for incoming sync events. |
