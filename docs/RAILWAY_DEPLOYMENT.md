# Deploy OpenHands on Railway

This repository is configured to build and run the complete OpenHands web application on Railway.

## Architecture

Railway services are non-privileged and cannot mount the host Docker socket or run Docker-in-Docker. The Railway image therefore defaults to:

```text
RUNTIME=process
```

In this mode, OpenHands starts each agent server as a child process inside the same Railway service. This works without Docker, but it does **not** provide container isolation: agent commands can access the service filesystem and environment variables.

For stronger production isolation, override the default with:

```text
RUNTIME=remote
SANDBOX_REMOTE_RUNTIME_API_URL=https://your-sandbox-api.example.com
SANDBOX_API_KEY=your-secret-key
```

## Railway setup

1. Create a Railway project from this GitHub repository.
2. Select the `main` branch and keep the repository root as the service root.
3. Generate a public domain under **Settings → Networking**.
4. Attach a Railway volume mounted at:

```text
/data
```

The volume persists OpenHands settings, the local database, conversations, and process-sandbox workspaces.

## Variables

Railway injects `PORT` automatically. The image also derives `OH_WEB_URL` and the CORS origin from `RAILWAY_PUBLIC_DOMAIN`.

Add the model configuration required for your provider, for example:

```text
LLM_MODEL=openai/gpt-5.6
LLM_API_KEY=replace-with-your-provider-key
```

The image provides these defaults:

```text
RUNTIME=process
OH_PERSISTENCE_DIR=/data/.openhands
FILE_STORE_PATH=/data/.openhands
TMPDIR=/data/tmp
```

You may override any of them in Railway's Variables tab.

## Validation

After deployment:

1. Open the generated Railway domain and confirm the OpenHands interface loads.
2. Configure the LLM provider in the OpenHands settings.
3. Start one small conversation and ask the agent to create a text file.
4. Redeploy the service and confirm the conversation and file remain available.

## Security

Do not expose a process-sandbox deployment to untrusted users. The agent executes commands in the same service that holds application secrets. Use a remote sandbox provider when isolation is required.
