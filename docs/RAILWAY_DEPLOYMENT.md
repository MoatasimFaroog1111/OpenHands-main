# Deploy OpenHands on Railway

Railway can host the OpenHands **application server**, but it must not execute
agent-generated code inside the same service. This repository therefore treats
Railway as a remote-sandbox-only deployment target.

## Architecture

```text
Browser
  |
  v
Railway OpenHands app service
  |  HTTPS + X-API-Key
  v
Isolated Remote Runtime API
  |
  v
Sandbox / agent-server instances
```

The Railway app service must use:

```text
RUNTIME=remote
```

`RUNTIME=process`, `RUNTIME=local`, and Railway-hosted Docker sandboxes are
rejected at startup. The remote runtime URL must not point to localhost or a
loopback address.

The remote runtime is a separate trust boundary and must implement the HTTP
protocol consumed by `RemoteSandboxService` (`/start`, `/stop`, `/list`,
`/sessions/...`) with `X-API-Key` authentication.

## Required Railway variables

Set these variables on the OpenHands service:

```text
RUNTIME=remote
SANDBOX_REMOTE_RUNTIME_API_URL=https://your-isolated-runtime.example.com
SANDBOX_API_KEY=replace-with-a-strong-secret
SANDBOX_USER_ID=42421
```

Also configure the LLM/provider credentials required by your deployment.

Do **not** set:

```text
NO_SETUP=true
```

for the standard Railway deployment. The entrypoint intentionally starts with
setup privileges, prepares the mounted volume, and then launches the OpenHands
application as the non-root `enduser` identified by `SANDBOX_USER_ID`.

## Public URL and CORS

Railway injects `RAILWAY_PUBLIC_DOMAIN`. At startup the entrypoint derives these
values unless you explicitly override them:

```text
OH_WEB_URL=https://${RAILWAY_PUBLIC_DOMAIN}
OH_PERMITTED_CORS_ORIGINS_0=https://${RAILWAY_PUBLIC_DOMAIN}
```

Railway also injects `PORT`; the root Dockerfile already starts Uvicorn on that
port.

## Persistent volume

Attach one Railway volume to the OpenHands service and mount it at:

```text
/data
```

At container startup Railway exposes the mount path as
`RAILWAY_VOLUME_MOUNT_PATH`. The entrypoint derives these defaults:

```text
OH_PERSISTENCE_DIR=${RAILWAY_VOLUME_MOUNT_PATH}/.openhands
FILE_STORE_PATH=${RAILWAY_VOLUME_MOUNT_PATH}/.openhands
TMPDIR=${RAILWAY_VOLUME_MOUNT_PATH}/tmp
```

The volume is mounted as root. The entrypoint creates the application data
directories, transfers those directories to `enduser`, and only then starts the
OpenHands application as the non-root user. Do not bypass this initialization
when a Railway volume is attached.

## Railway service setup

1. Create a Railway service from this GitHub repository.
2. Use the repository root as the service root.
3. Use `railway.json` as config-as-code; it builds the root `Dockerfile`.
4. Generate a public domain for the app service.
5. Attach a volume at `/data` if persistence is required.
6. Configure all required variables above.
7. Configure the isolated Remote Runtime API and verify it is reachable from the
   Railway service.
8. Deploy the service.

## Validation gate

A Railway deployment is not approved for production until all of the following
checks pass:

1. The Railway health check succeeds and the web UI loads.
2. Startup logs show `Running as enduser`.
3. The Uvicorn application process has a non-zero UID.
4. A deployment with `RUNTIME=process` is rejected.
5. A deployment with a loopback remote runtime URL is rejected.
6. A real conversation can start an isolated remote sandbox.
7. The agent can create a small file inside that sandbox and the result is
   visible in the conversation.
8. Redeploying the Railway app keeps application persistence when the `/data`
   volume is attached.

The repository CI covers items 3-5 plus image startup and volume-write access.
Items 6-8 require a connected Railway service and a real Remote Runtime API.

## Azure migration policy

The existing Azure VM deployment remains the production fallback and is not
removed by the Railway work.

Do not remove the Azure workflow until Railway has passed the full validation
gate above with a real isolated runtime. Once that is proven, Azure removal must
be a separate change so rollback remains possible.

## Why the old process-sandbox Railway draft is not used

The previous Railway draft ran `RUNTIME=process`. That places agent-generated
commands in the same container that holds application credentials and persisted
state. The hosted runtime security policy now rejects that architecture, so it
must not be revived for production deployment.
