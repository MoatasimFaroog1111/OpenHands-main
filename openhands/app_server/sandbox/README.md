# Sandbox Management

Manages sandbox environments for secure agent execution within OpenHands.

## Overview

Since agents can do things that may harm your system, they are typically run inside a sandbox (like a Docker container). This module provides services for creating, managing, and monitoring these sandbox environments.

## Security boundary

Agent-generated code must execute outside the OpenHands application process in any
hosted deployment. Hosted deployments therefore reject `RUNTIME=local` and
`RUNTIME=process` at startup and must use an isolated Docker or remote sandbox.
The application server must also run as a non-root user when a hosted deployment
is detected.

`RUNTIME=process` is disabled by default even outside hosted deployments because
it shares the application container. Trusted local development can opt in
explicitly with `OH_ALLOW_INSECURE_PROCESS_SANDBOX=true`. This opt-in never
bypasses the hosted-deployment restriction.

For single-container cloud platforms that cannot provide Docker isolation, use
`RUNTIME=remote` with `SANDBOX_REMOTE_RUNTIME_API_URL` and `SANDBOX_API_KEY`, and
set `SANDBOX_USER_ID` to a non-zero UID.

## Key Components

- **SandboxService**: Abstract service for sandbox lifecycle management
- **DockerSandboxService**: Docker-based sandbox implementation
- **ProcessSandboxService**: Runs each agent-server as a child process on a loopback port (`RUNTIME=local`/`process`)
- **SandboxSpecService**: Manages sandbox specifications and templates
- **SandboxRouter**: FastAPI router for sandbox endpoints
- **SandboxProxyRouter**: Same origin reverse proxy that republishes loopback sandbox ports at `/runtime/{port}`

## Features

- Secure containerized execution environments
- Sandbox lifecycle management (create, start, stop, destroy)
- Multiple sandbox backend support (Docker, Remote, Local)
- User-scoped sandbox access control

## Reaching a sandbox from the browser

A `ProcessSandboxService` sandbox listens on `http://127.0.0.1:{port}`. That is
the right address for calls the app server makes itself, but the browser
usually cannot use it:

- Single port hosts (Railway, Render, Fly.io, Heroku, ...) publish only the app
  server's port, so `https://my-app.example.com:8001` does not resolve.
- The container's loopback interface is not the user's loopback interface.

Handing that URL to the web client leaves the event WebSocket permanently in
the `Disconnected` state and panels such as *Changes* stuck on loading.

To avoid this, `ExposedUrl` carries an optional `public_url` alongside the
internal `url`. For process sandboxes it is set to `/runtime/{port}`, a path
served by `sandbox_proxy_router`, which forwards both HTTP and WebSocket
traffic to the loopback port. The web client resolves the path against its own
origin, so everything travels over the one port the platform publishes.

Authentication is unchanged: the agent-server still requires the
`X-Session-API-Key` handed to the web client, and only ports inside the
sandbox allocation range are forwarded.

The proxy mounts itself whenever the resolved sandbox injector is a
`ProcessSandboxServiceInjector`. That is read from the configuration rather
than from `RUNTIME`, so it stays correct however the process runtime was
selected. The app server's own `PORT` is never proxied, since on single port
hosts it frequently lands inside the sandbox range.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `SANDBOX_PROXY_ENABLED` | on for process sandboxes | Force the proxy on or off, overriding the automatic detection |
| `OH_SANDBOX_BASE_PORT` | `8000` | First port of the sandbox allocation range the proxy is willing to forward to |
