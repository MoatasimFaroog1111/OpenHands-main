# Railway Sandbox Gateway for OpenHands

This service adapts the existing OpenHands `RemoteSandboxService` HTTP contract to Railway Sandboxes without coupling OpenHands domain/application code to Railway.

## Architecture

```text
Browser
  -> OpenHands Railway service (RUNTIME=remote)
       -> Gateway control API (X-API-Key)
            -> Railway Sandbox SDK
                 -> PRIVATE Railway Sandbox VM
                      -> Docker
                           -> OpenHands agent-server container
                           -> sandbox tunnel sidecar
                                -> outbound authenticated WebSocket
                                     -> Gateway loopback tunnel listeners

Browser
  -> Gateway public HTTPS domain /<runtime-id>/...
       -> HTTP/WebSocket reverse proxy
            -> Gateway loopback tunnel listener
                 -> multiplexed reverse tunnel
                      -> sandbox loopback
                           -> agent-server / VSCode / worker ports
```

The sandbox initiates the runtime data connection back to the gateway. This avoids treating a Railway Sandbox private IPv6 address as a stable inbound service endpoint while preserving the existing OpenHands path-mode HTTP/WebSocket contract.

The gateway never passes `RAILWAY_TOKEN`, `RAILWAY_API_TOKEN`, or `GATEWAY_API_KEY` into a sandbox. It derives a separate per-runtime tunnel credential with HMAC. That credential rotates on resume and is delivered only to the isolated tunnel sidecar through a temporary Docker env file that is removed from the Sandbox host immediately after the sidecar starts.

The environment supplied by OpenHands for the agent-server is needed for runtime compatibility, so the persistent registry is encrypted with AES-256-GCM using a key derived from `GATEWAY_API_KEY`; the runtime env file inside the sandbox is mode `0600` and deleted after the nested container starts.

## Why the reverse tunnel exists

Railway Sandboxes can join an environment private network for sandbox-initiated traffic. Railway's interactive port-forwarding feature is designed to expose a service inside a sandbox through a forwarding session. The gateway instead needs a persistent, non-interactive transport that works for both HTTP and WebSocket traffic without installing an account SSH key in the service.

For each runtime, the gateway therefore opens four loopback-only listeners and multiplexes them over one authenticated WebSocket initiated by the sandbox tunnel sidecar:

```text
60000  agent-server
60001  VS Code
12000  worker 1
12001  worker 2
```

The agent-server ports are published only on `127.0.0.1` inside the Sandbox VM. They are not exposed as raw Sandbox VM ingress ports.

## Lifecycle compatibility

The legacy RemoteRuntime contract expects `pause` and `resume`. Railway's Sandbox SDK exposes create/connect/checkpoint/destroy rather than a direct pause API, so the adapter implements:

```text
pause  = close tunnel -> stop nested containers -> checkpoint sandbox disk -> destroy VM
resume = create sandbox from checkpoint -> rotate session + tunnel keys -> recreate agent container -> recreate tunnel -> health check
```

`/workspace` is bind-mounted from the Railway Sandbox VM into the nested agent-server container. The checkpoint therefore preserves conversation/workspace files while the agent process is recreated with fresh credentials.

The gateway also performs a small SDK `exec('true')` keepalive against running sandboxes. This is intentionally separate from browser proxy traffic so the Railway Sandbox idle timer is kept active even when normal traffic only traverses the reverse tunnel.

When the gateway itself restarts, it decrypts the persisted runtime registry, recreates local tunnel listeners for running runtimes, and accepts the sandbox tunnel client's automatic reconnect.

## Control API

All control endpoints require `X-API-Key: <GATEWAY_API_KEY>`. `/healthz` is public for Railway health checks. Runtime proxy routes preserve the agent-server's own session-key authentication.

- `POST /start`
- `GET /sessions/:session_id`
- `GET /sessions/batch?ids=...`
- `GET /list`
- `POST /pause`
- `POST /resume`
- `POST /stop`
- `GET /healthz`

Runtime traffic is exposed as `/<runtime-id>/...` so OpenHands' existing path-mode URL builder can derive VS Code and worker URLs without changes.

`/tunnel/<runtime-id>` is reserved for authenticated WebSocket upgrades from the sandbox tunnel sidecar. The tunnel credential is sent as the first WebSocket frame rather than in the URL, keeping it out of ordinary request URLs and network logs.

## Railway service configuration

Create a **second Railway service** from the same repository and set its root directory to:

```text
/integrations/railway-sandbox-gateway
```

Attach a persistent volume at `/data`. The container entrypoint creates the registry directory as root and then drops permanently to the unprivileged `node` user before starting the gateway.

Required variables:

```text
GATEWAY_API_KEY=<cryptographically-random-secret-of-at-least-32-characters>
RAILWAY_TOKEN=<project-token-with-sandbox-access>
RAILWAY_ENVIRONMENT_ID=<environment-id>
GATEWAY_PUBLIC_BASE_URL=https://<gateway-public-domain>
RUNTIME_REGISTRY_PATH=/data/railway-sandbox-gateway/runtimes.json
SANDBOX_IDLE_TIMEOUT_MINUTES=60
SANDBOX_KEEPALIVE_SECONDS=240
SANDBOX_STARTUP_TIMEOUT_MS=120000
```

`GATEWAY_TUNNEL_BASE_URL` is optional. It defaults to `GATEWAY_PUBLIC_BASE_URL`, which gives the sandbox a normal outbound `wss://` route to the gateway. An explicit Railway private `http://...railway.internal:<port>` value is also accepted when private routing is preferred and validated in the target environment.

The official Railway SDK accepts either `RAILWAY_TOKEN` (recommended project token on-platform) or `RAILWAY_API_TOKEN`. The gateway itself receives `PORT` from Railway.

Configure the OpenHands service with:

```text
RUNTIME=remote
SANDBOX_USER_ID=42421
SANDBOX_REMOTE_RUNTIME_API_URL=http://<gateway-service>.railway.internal:<gateway-port>
SANDBOX_API_KEY=<same value as GATEWAY_API_KEY>
```

`SANDBOX_REMOTE_RUNTIME_API_URL` may use Railway private networking for control traffic. `GATEWAY_PUBLIC_BASE_URL` must remain the gateway's public HTTPS domain because browsers use the returned runtime URLs.

## Security boundaries

- Railway credentials and the gateway control secret stay in the gateway service only.
- The sandbox receives a separate HMAC-derived per-runtime tunnel credential, never `GATEWAY_API_KEY`.
- Tunnel credentials rotate whenever a paused runtime resumes.
- The tunnel credential is supplied only to the tunnel sidecar, never the agent-server container.
- Agent-server, VS Code, and worker ports bind only to Sandbox VM loopback.
- The tunnel sidecar is read-only, drops Linux capabilities, and uses `no-new-privileges`.
- Agent-server environment is encrypted at rest in the registry.
- Gateway control API uses constant-time API-key comparison.
- Runtime IDs are restricted to a safe path/shell character set.
- UID/GID inputs are validated before they reach shell commands.
- Runtime environment names and values are validated; newline/NUL injection is rejected.
- The gateway runtime process runs as a non-root user.

## Automated production lifecycle gate

After deploying a candidate gateway build, open the Railway Console for the gateway service and run:

```bash
npm run smoke:production
```

The gate reuses the gateway service's existing secrets and public URL; no secret needs to be copied elsewhere. It performs two complete disposable runtime lifecycles by default, including Agent Server health, authenticated API traffic, `/workspace` write/read, worker routes, VS Code, secret-boundary checks, pause/resume persistence, session-key rotation, old-key rejection, stop, and leak detection.

See [`PRODUCTION_GATE.md`](./PRODUCTION_GATE.md) for the exact assertions and optional overrides.

## Deployment gate

Do not remove Azure until a real Railway environment passes all of these checks:

1. Gateway `/healthz` is healthy.
2. `POST /start` provisions a PRIVATE Railway Sandbox.
3. Docker starts the configured OpenHands agent-server image with ports bound to Sandbox loopback only.
4. The sandbox tunnel sidecar authenticates back to the gateway without receiving Railway credentials or `GATEWAY_API_KEY`.
5. Agent-server `/health` succeeds through the reverse tunnel.
6. Browser HTTP and WebSocket traffic works through `/<runtime-id>/...`.
7. Agent creates and reads a file under `/workspace`.
8. Pause/resume preserves that file and rotates both the session API key and tunnel credential.
9. Gateway restart preserves/decrypts runtime registry state from `/data` and the sandbox tunnel reconnects.
10. Keepalive prevents an actively managed sandbox from expiring solely because browser traffic is proxied.
11. The sandbox cannot read the gateway/OpenHands Railway service environment.
12. Stop destroys the sandbox and associated checkpoint.

The automated production lifecycle gate covers most of these checks. Gateway restart/reconnect and a keepalive soak longer than the configured idle timeout remain explicit operational tests before Azure can be removed.

Railway Sandboxes and their TypeScript SDK are still evolving capabilities; pinning `railway@3.10.0` is intentional until the live contract is validated.
