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

Browser
  -> Gateway public HTTPS domain /<runtime-id>/...
       -> HTTP/WebSocket reverse proxy
            -> sandbox private IPv6
                 -> agent-server / VSCode / worker ports
```

The gateway never passes `RAILWAY_TOKEN`, `RAILWAY_API_TOKEN`, `GATEWAY_API_KEY`, or application secrets into a sandbox. Only the environment supplied by OpenHands for the agent-server is written to the nested runtime container.

## Why the proxy exists

Railway Sandboxes can join the environment private network, but they do not have a normal service DNS name. The gateway discovers the sandbox ULA IPv6 address after boot and keeps it private. Browser traffic goes through the gateway's public HTTPS domain, while the gateway forwards HTTP and WebSocket traffic over Railway's private network.

## Lifecycle compatibility

The legacy RemoteRuntime contract expects `pause` and `resume`. Railway's Sandbox SDK exposes create/connect/checkpoint/destroy rather than a direct pause API, so the adapter implements:

```text
pause  = stop nested agent container -> checkpoint sandbox disk -> destroy VM
resume = create sandbox from checkpoint -> rotate session API key -> recreate agent container
```

`/workspace` is bind-mounted from the Railway Sandbox VM into the nested agent-server container. The checkpoint therefore preserves conversation/workspace files while the agent process is recreated with a fresh session key.

## Control API

All endpoints except `/healthz` and runtime proxy routes require `X-API-Key: <GATEWAY_API_KEY>`.

- `POST /start`
- `GET /sessions/:session_id`
- `GET /sessions/batch?ids=...`
- `GET /list`
- `POST /pause`
- `POST /resume`
- `POST /stop`
- `GET /healthz`

Runtime traffic is exposed as `/<runtime-id>/...` so OpenHands' existing path-mode URL builder can derive VSCode and worker URLs without changes.

## Railway service configuration

Create a **second Railway service** from the same repository and set its root directory to:

```text
/integrations/railway-sandbox-gateway
```

Attach a persistent volume at `/data`.

Required variables:

```text
GATEWAY_API_KEY=<random-long-secret>
RAILWAY_TOKEN=<project-token-with-sandbox-access>
RAILWAY_ENVIRONMENT_ID=<environment-id>
GATEWAY_PUBLIC_BASE_URL=https://<gateway-public-domain>
RUNTIME_REGISTRY_PATH=/data/railway-sandbox-gateway/runtimes.json
SANDBOX_IDLE_TIMEOUT_MINUTES=60
SANDBOX_STARTUP_TIMEOUT_MS=120000
```

The gateway itself receives `PORT` from Railway.

Configure the OpenHands service with:

```text
RUNTIME=remote
SANDBOX_USER_ID=42421
SANDBOX_REMOTE_RUNTIME_API_URL=http://<gateway-service>.railway.internal:<gateway-port>
SANDBOX_API_KEY=<same value as GATEWAY_API_KEY>
```

`SANDBOX_REMOTE_RUNTIME_API_URL` may use Railway private networking for control traffic. `GATEWAY_PUBLIC_BASE_URL` must remain the gateway's public HTTPS domain because browsers use the returned runtime URLs.

## Deployment gate

Do not remove Azure until a real Railway environment passes all of these checks:

1. Gateway `/healthz` is healthy.
2. `POST /start` provisions a PRIVATE Railway Sandbox.
3. The sandbox private IPv6 is reachable from the gateway.
4. Docker starts the configured OpenHands agent-server image.
5. `/health` succeeds through the private IPv6 path.
6. Browser HTTP and WebSocket traffic works through `/<runtime-id>/...`.
7. Agent creates and reads a file under `/workspace`.
8. Pause/resume preserves that file and rotates the session API key.
9. Gateway restart preserves runtime registry state from `/data`.
10. The sandbox cannot read the gateway/OpenHands Railway service environment.
11. Stop destroys the sandbox and associated checkpoint.

Railway Sandboxes and their TypeScript SDK are still beta/priority-boarded capabilities; pinning `railway@3.10.0` is intentional until the live contract is validated.
