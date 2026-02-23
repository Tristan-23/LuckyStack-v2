# Developer Guide

> Getting started with LuckyStack development.

---

## Quick Start

### 1. Setup

```bash
# Install dependencies
npm install

# Copy config templates
cp configTemplate.txt config.ts
cp envTemplate.txt .env

# Edit .env with your credentials
# Edit config.ts with your settings
```

### 2. Start Development

```bash
# Terminal 1: Start backend
npm run server

# Terminal 2: Start frontend (Vite)
npm run client
```

### 3. Create Your First API

```typescript
// src/mypage/_api/hello_v1.ts
import { AuthProps, SessionLayout } from "config";
import { Functions, ApiResponse } from "src/_sockets/apiTypes.generated";

export const auth: AuthProps = { login: false, additional: [] };

export interface ApiParams {
  data: { name: string };
  user: SessionLayout;
  functions: Functions;
}

export const main = async ({ data }: ApiParams): Promise<ApiResponse> => {
  return {
    status: "success",
    message: `Hello, ${data.name}!`,
  };
};
```

Types are auto-generated! Just save the file and use:

```typescript
const result = await apiRequest({ name: "hello", version: "v1", data: { name: "World" } });
```

---

## Project Structure

```
luckystack/
├── src/                    # Frontend (React)
│   ├── _components/        # Shared UI components
│   ├── _functions/         # Client utilities
│   ├── _providers/         # React context providers
│   ├── _sockets/           # Socket client utilities
│   ├── _locales/           # i18n translations
│   ├── admin/              # Admin pages
│   └── {page}/             # Feature pages
│       ├── page.tsx        # Main page component
│       ├── _components/    # Page-specific components
│       ├── _api/           # API handlers for this page
│       └── _sync/          # Sync handlers for this page
│
├── server/                 # Backend (Node.js)
│   ├── auth/               # Authentication logic
│   ├── sockets/            # Socket event handlers
│   ├── functions/          # Server-only functions
│   ├── utils/              # Server utilities
│   ├── dev/                # Hot reload & type generation
│   └── server.ts           # Entry point
│
├── shared/                 # Isomorphic functions (client + server)
│
├── docs/                   # Architecture documentation
├── config.ts               # App configuration
└── .env                    # Environment variables
```

---

## Paths and Aliases

- Runtime/server path constants are centralized in `server/utils/paths.ts`.
- Use these constants for filesystem paths (uploads, public, generated files, server functions) instead of hardcoding `process.cwd()` joins.
- Alias resolution source of truth is TypeScript config paths (`tsconfig.server.json` and `tsconfig.app.json`).
- `vite.config.ts` uses `vite-tsconfig-paths`, and server runtime type resolution reuses those same tsconfig path mappings.

---

## Common Patterns

### Page with API and Sync

```
src/game/
├── page.tsx                # Main game UI
├── _components/
│   ├── Board.tsx
│   └── ScoreBoard.tsx
├── _api/
│   ├── createGame_v1.ts       # POST - create new game
│   ├── getGameState_v1.ts     # GET - fetch game state
│   └── deleteGame_v1.ts       # DELETE - end game
└── _sync/
    ├── movePlayer_server_v1.ts  # Server validates move
    └── movePlayer_client_v1.ts  # Client processes move
```

### Using in Components

```tsx
import { apiRequest } from "src/_sockets/apiRequest";
import { syncRequest, useSyncEvents } from "src/_sockets/syncRequest";

function GameBoard() {
  const [state, setState] = useState(null);
  const { upsertSyncEventCallback } = useSyncEvents();

  // Fetch initial state
  useEffect(() => {
    apiRequest({ name: "getGameState", version: "v1", data: { gameId } }).then((result) =>
      setState(result),
    );
  }, [gameId]);

  // Listen for moves
  useEffect(() => {
    upsertSyncEventCallback({
      name: "game/movePlayer",
      version: "v1",
      callback: ({ serverOutput }) => {
        setState((prev) => ({ ...prev, ...serverOutput }));
      },
    });
  }, []);

  // Send a move
  const handleMove = (move) => {
    syncRequest({ name: "game/movePlayer", version: "v1", data: move });
  };

  return <Board onMove={handleMove} {...state} />;
}
```

---

## Hot Reload

The dev server watches for file changes and automatically:

1. **API files** (`_api/*.ts`) - Regenerates types in `apiTypes.generated.ts`
2. **Sync files** (`_sync/*.ts`) - Injects templates and updates types
3. **Function files** (`server/functions/*.ts`, `shared/*.ts`) - Reloads functions and regenerates `apiTypes.generated.ts`
4. **Components** - Vite HMR handles the rest

Just save and your types are updated!

---

## Testing APIs

### Via HTTP (curl/Postman)

```bash
# GET-style API
curl http://localhost/api/mypage/getGameState/v1?gameId=123

# POST-style API
curl -X POST http://localhost/api/mypage/createGame/v1 \
  -H "Content-Type: application/json" \
  -d '{"name": "My Game"}'

# With auth
curl http://localhost/api/mypage/getGameState/v1?gameId=123 \
  -H "Authorization: Bearer your-token-here"

# Optional translated error messages
curl http://localhost/api/mypage/getGameState/v1?gameId=123 \
  -H "Cookie: token=your-token-here" \
  -H "Accept-Language: en"
```

### Via Browser Console

```javascript
// If socket is connected
socket.emit("apiRequest", {
  name: "api/mypage/hello",
  data: { name: "Test" },
  responseIndex: 999,
});

socket.on("apiResponse-999", console.log);
```

---

## Debugging

### Server Logs

Colorized console output:

- **Blue** - API calls
- **Green** - Success
- **Red** - Errors
- **Yellow** - Warnings
- **Magenta** - HTTP requests

### Dev REPL

In server terminal, type commands directly:

```
> session.get('token-123')  // Check session
> io.sockets.sockets.size   // Connected sockets
```

### Sentry Integration

Errors are automatically captured if `SENTRY_DSN` is set in `.env`.

---

## Best Practices

1. **Keep APIs small** - One responsibility per file
2. **Use type inference** - Don't manually type API responses
3. **Handle errors** - Always return `{ status: 'error', errorCode, errorParams? }` on failure
4. **Clean up callbacks** - Remove sync callbacks when component unmounts
5. **Use rooms** - Don't broadcast to everyone, use targeted rooms

See architecture deep dives:

- `docs/ARCHITECTURE_API.md`
- `docs/ARCHITECTURE_SYNC.md`
- `docs/ARCHITECTURE_SOCKET.md`
