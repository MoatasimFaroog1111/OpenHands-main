# Railway Production Lifecycle Gate

Run this gate only against the deployed Railway Sandbox Gateway after the normal build/test pipeline is green.

It is intentionally executed **inside the gateway Railway service** so it can reuse the service's existing `GATEWAY_API_KEY` and `GATEWAY_PUBLIC_BASE_URL`. Do not copy either secret into chat, GitHub Actions, or a local shell.

## Run

Open the Railway Console for `railway-sandbox-gateway` and run:

```bash
npm run smoke:production
```

The command creates disposable smoke runtimes whose IDs start with `railwaySmoke`, exercises the lifecycle, and removes them even when an assertion fails.

Default behavior runs two complete iterations. Optional overrides can be set as Railway service variables when required:

```text
RAILWAY_SMOKE_IMAGE=ghcr.io/openhands/agent-server:1.29.0-python
RAILWAY_SMOKE_RUN_AS_USER=42421
RAILWAY_SMOKE_RUN_AS_GROUP=42421
RAILWAY_SMOKE_ITERATIONS=2
RAILWAY_SMOKE_LIFECYCLE_TIMEOUT_MS=420000
RAILWAY_SMOKE_COMMAND_TIMEOUT_SECONDS=30
```

`RAILWAY_SMOKE_GATEWAY_URL` and `RAILWAY_SMOKE_GATEWAY_API_KEY` are supported for isolated environments, but production should normally reuse `GATEWAY_PUBLIC_BASE_URL` and `GATEWAY_API_KEY` already present on the gateway service.

## What it proves

For every smoke runtime the gate verifies:

1. Gateway `/healthz` responds successfully.
2. `POST /start` creates a running Railway remote runtime using the official OpenHands agent-server image.
3. Agent-server `/health` succeeds through the authenticated reverse tunnel.
4. Protected Agent Server API calls succeed with the current `X-Session-API-Key`.
5. A marker is written to and read from `/workspace` through the real Agent Server bash API.
6. `RAILWAY_TOKEN`, `RAILWAY_API_TOKEN`, and `GATEWAY_API_KEY` are absent from the agent-server environment.
7. Worker routes `work-1` / port 12000 and `work-2` / port 12001 carry HTTP traffic through the reverse tunnel.
8. The VS Code route / port 60001 is reachable through the reverse tunnel.
9. `POST /pause` checkpoints and destroys the live Sandbox runtime.
10. `POST /resume` restores the runtime and rotates the session API key.
11. The pre-resume session API key is rejected after resume.
12. The `/workspace` marker survives checkpoint/restore.
13. Worker and VS Code routes recover after resume.
14. `POST /stop` removes the runtime and checkpoint from the gateway contract.
15. `/sessions/:id` returns 404 after stop and `/list` contains no smoke-runtime leak.
16. Multiple sequential lifecycle iterations succeed without leaving `railwaySmoke*` runtimes behind.

The gate never logs the gateway API key or the session API key. Query-string `tkn` values are redacted from request-error URLs.

## Expected success output

The final line is:

```text
[production-gate] PASS: Railway remote sandbox lifecycle is healthy
```

Any failed assertion exits non-zero after best-effort runtime cleanup.

## Still separate from this gate

A PASS does **not** replace two operational soak tests:

- gateway process restart/redeploy while a runtime is active, proving registry persistence and reverse-tunnel reconnection from `/data`;
- a keepalive soak longer than `SANDBOX_IDLE_TIMEOUT_MINUTES`, proving an actively managed Sandbox does not expire when normal traffic only traverses the reverse tunnel.

Keep the Azure fallback until those operational checks also pass.
