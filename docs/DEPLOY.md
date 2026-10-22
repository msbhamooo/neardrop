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
