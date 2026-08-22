# Deploy OpenHands on Railway

Railway can host the OpenHands web application, but it must **not** execute agent code inside the same service. Production Railway deployments therefore use the remote sandbox adapter exclusively.

## Architecture

```text
Browser
  -> Railway OpenHands web/app service
      -> Remote Sandbox API
          -> isolated agent sandbox/container
```

The Railway service owns application state, authentication, settings, and the web/API surface. Agent-generated commands execute only behind the remote sandbox boundary.

The deployment contract is:

```text
RUNTIME=remote
SANDBOX_USER_ID=42421
SANDBOX_REMOTE_RUNTIME_API_URL=https://your-isolated-sandbox-api.example.com
SANDBOX_API_KEY=<secret>
```

`RUNTIME=process` and `RUNTIME=local` are intentionally rejected for hosted deployments. Railway also rejects a root application user through the runtime security gate.

## Railway setup

1. Create a Railway service from this repository and select the branch you intend to deploy.
2. Keep the repository root as the service root. `railway.json` builds the root `Dockerfile`.
3. Generate a public Railway domain.
4. Attach a persistent Railway volume at `/data`.
5. Configure the required remote sandbox variables below.
6. Configure the LLM provider credentials required by your deployment.

## Required variables

Set these explicitly in Railway:

```text
RUNTIME=remote
SANDBOX_USER_ID=42421
SANDBOX_REMOTE_RUNTIME_API_URL=https://your-isolated-sandbox-api.example.com
SANDBOX_API_KEY=<secret>
```

The entrypoint fails fast if Railway selects any non-remote runtime, if the remote sandbox credentials are missing, or if `SANDBOX_USER_ID=0`.

Railway provides `PORT` automatically. When `RAILWAY_PUBLIC_DOMAIN` is present, the entrypoint derives these values unless you override them:

```text
OH_WEB_URL=https://<RAILWAY_PUBLIC_DOMAIN>
OH_PERMITTED_CORS_ORIGINS_0=https://<RAILWAY_PUBLIC_DOMAIN>
```

The entrypoint also supplies these Railway persistence defaults:

```text
OH_PERSISTENCE_DIR=/data/.openhands
FILE_STORE_PATH=/data/.openhands
TMPDIR=/data/tmp
```

A volume mounted at `/data` is required if application state must survive redeployments.

## Remote sandbox requirements

The remote sandbox service is a separate trust boundary. It must:

- expose the API configured by `SANDBOX_REMOTE_RUNTIME_API_URL`;
- authenticate requests using `SANDBOX_API_KEY`;
- execute agent workloads in isolated sandboxes/containers rather than in the Railway app container;
- be reachable from the Railway service over TLS;
- have its own resource, network, filesystem, and secret isolation appropriate for untrusted agent commands.

Do not put model-provider keys, database credentials, or Railway application secrets inside agent sandboxes unless the product explicitly requires them.

## Validation before cutover

Do not remove the existing Azure deployment until all of the following have passed against a real Railway service:

1. Railway builds the root Dockerfile successfully.
2. The web application health check succeeds on the generated public domain.
3. Startup logs confirm the application drops to the configured non-root UID.
4. A conversation can create a remote sandbox successfully.
5. A simple agent task can create/read a file inside the remote sandbox.
6. The agent cannot read the Railway application container filesystem or environment secrets.
7. Redeploying Railway preserves conversations/settings stored under `/data`.
8. Remote sandbox cleanup/reconnect behavior works after a Railway redeploy.
9. The same commit passes repository CI (lint, unit tests, Docker build, and critical coverage).

Until those checks are completed, Azure remains the retained deployment path and Railway is an additional candidate, not a replacement.

## Azure status

This Railway configuration does **not** delete or modify `.github/workflows/deploy-openhands-azure-vm.yml`. Azure remains available while Railway is validated end to end.
