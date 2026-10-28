# Deploying NearDrop

The deployable unit is one host running:
- the **web bundle** (static: `apps/web/dist/`) on :443, and
- the **signaling server** (`apps/server`) on an internal port, reverse-proxied on the same origin — same-origin WebSocket avoids mixed-content and CORS entirely.

## Build

```bash
pnpm install
pnpm build   # → packages/core/dist, apps/server/dist, apps/web/dist
```

## Docker

`Dockerfile` (repo root):

```dockerfile
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3001 TRUST_PROXY=1
COPY --from=build /app/apps/server/dist ./server
COPY --from=build /app/apps/web/dist ./web
COPY --from=build /app/node_modules/.pnpm/ws@*/node_modules/ws ./node_modules/ws 2>/dev/null || true
EXPOSE 3000 3001
CMD ["node", "server/index.js"]
```

(For a single-container build, serve `web/` statically from the signaling server's HTTP handler — the production script `scripts/prod.mjs` already does exactly this: web on :3000, ws on :3001.)

## Reverse proxy (same-origin WebSocket)

Caddy (matches the sandbox gateway pattern):

```caddyfile
near-drop.example.com {
    @ws path /ws
    handle @ws {
        reverse_proxy localhost:3001 {
            header_up X-Forwarded-For {remote_host}
        }
    }
    handle {
        # app itself (scripts/prod.mjs serves the web build on :3000)
        reverse_proxy localhost:3000 {
            header_up X-Forwarded-For {remote_host}
        }
    }
}
```

If you prefer a dedicated WS path (as above), set `VITE_SIGNALING_URL=wss://near-drop.example.com/ws` at build time. The client also auto-derives `wss://<host>/?XTransformPort=3001` when behind a port-rewriting gateway.

nginx equivalent:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 30s;   # server heartbeats at 15s
}
```

**Always set `TRUST_PROXY=1`** when behind a proxy that sets `X-Forwarded-For`, otherwise room grouping sees the proxy IP and everyone lands in one room; never enable it without a trusted proxy in front.

## Fly.io

```toml
# fly.toml
app = "neardrop"
primary_region = "fra"

[build]

[env]
PORT = "3001"
TRUST_PROXY = "1"

[[services]]
internal_port = 3000
protocol = "tcp"
[[services.ports]]
handlers = ["http", "tls"]
port = 443
```

Scale note: WebSockets + Fly machines work fine, but in-memory rooms mean discovery is per-machine. For multi-region, put Redis pub/sub between the room registry (`apps/server/src/rooms.ts` is deliberately isolated for this) or use Consul-style sticky routing by client IP.

## Railway

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": {
    "startCommand": "node server/index.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 60,
    "restartPolicyType": "ON_FAILURE"
  }
}
```

## Health & observability

- `GET /health` → `{"ok":true,"peers":N,"uptime":s}`
- `LOG=1` logs join/leave counts with truncated device ids only — SDP contents are never logged.
- Rate limits: 40 messages burst, 12/s refill per socket, 3 strikes → terminate.

## TURN (optional, cross-network transfers)

The product is LAN-first; files must never relay through servers, so TURN is **off by default**. If you deliberately want cross-network transfers at relay cost, set for the web build:

```
VITE_TURN_URL=turn:turn.example.com:3478
VITE_TURN_USER=neardrop
VITE_TURN_CRED=<secret>
```

and run coturn:

```
turnserver -n --listening-port=3478 --fingerprint --lt-cred-mech --user=neardrop:<secret> --realm=neardrop --no-tlsv1 --no-tlsv1=0
```

### Server-side TURN (recommended for cross-network)

The signaling server publishes ICE servers at `GET /api/ice`; clients fetch them at startup. Direct P2P is always tried first, TURN is used only when nothing else connects. Set on the server:

```
TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349   # comma-separated
TURN_SECRET=<coturn static-auth-secret>      # time-limited credentials (preferred)
# or: TURN_USER=... TURN_CRED=...
```

## Cloudflare (Worker + Durable Object) — one service for app and signaling

The PWA is served as static assets and signaling runs in a Durable Object (`apps/edge`), reusing the
same `HttpSignalHub` as the Node server. File bytes never touch it.

Dashboard (Workers & Pages -> Create -> Import a repository):

| Field | Value |
|---|---|
| Build command | `npm run build:web` |
| Deploy command | `npx wrangler deploy` |
| Root directory | (leave empty) |

Optional TURN for cross-network transfers (Settings -> Variables and secrets):
`TURN_URL` (comma-separated `turn:`/`turns:` URLs) and `TURN_SECRET` (coturn static-auth-secret), or
`TURN_USER` + `TURN_CRED`.

Local: `npm run build:web && npx wrangler dev` (http://localhost:8787). CLI deploy: `npm run deploy:edge`.

Notes: signaling uses HTTP long-polling, so each connected, idle device holds a short request open and
the Durable Object bills for that wall-clock time; fine for testing and moderate traffic. Moving the
client to WebSocket Hibernation is the cost optimisation for large scale. Durable Objects need the
Workers Paid plan or the free plan's SQLite-backed objects (configured in `wrangler.jsonc`).

## Usage stats and the private /admin dashboard

Events are stored in D1 (lifetime retention; Workers Analytics Engine only keeps 90 days).

1. `npx wrangler d1 create neardrop-events`, then put the printed `database_id` in `wrangler.jsonc` (`d1_databases`).
2. `npx wrangler d1 migrations apply neardrop-events --remote` (creates the `events` table).
3. Zero Trust, Access, Applications, add a self-hosted application for `<your-domain>/admin` and `<your-domain>/admin/*`
   with one Allow policy: your email only.
4. Set the Worker variables in `wrangler.jsonc` (`vars`): `ACCESS_TEAM_DOMAIN` (e.g. `myteam.cloudflareaccess.com`),
   `ACCESS_AUD` (the application's Audience tag) and `OWNER_EMAIL`. The Worker also verifies the
   `Cf-Access-Jwt-Assertion` JWT itself and returns 403 if any of these is unset, so a misconfigured Access
   policy cannot expose the dashboard.
5. `npm run deploy:edge`, then open `/admin`.

No API token is needed: the dashboard queries D1 through the Worker binding, so nothing secret reaches the browser.
`POST /api/events` is limited to 30 requests per minute per IP by the `RATE` rate-limit binding.
Local test: `npx wrangler dev --local` with `wrangler d1 migrations apply neardrop-events --local`.
