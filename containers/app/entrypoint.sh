#!/bin/bash
set -eo pipefail

echo "Starting OpenHands..."

# Railway is a public hosted environment without a Docker socket. Keep the app
# server and agent execution in separate trust domains: Railway runs only the web
# application, while agent code executes through the remote sandbox service.
if [[ -n "${RAILWAY_PUBLIC_DOMAIN:-}" || -n "${RAILWAY_ENVIRONMENT:-}" ]]; then
  export RUNTIME="${RUNTIME:-remote}"
  export SANDBOX_USER_ID="${SANDBOX_USER_ID:-42421}"

  if [[ "$RUNTIME" != "remote" ]]; then
    echo "Railway deployments require RUNTIME=remote for sandbox isolation"
    exit 1
  fi

  if [[ -z "${SANDBOX_REMOTE_RUNTIME_API_URL:-}" || -z "${SANDBOX_API_KEY:-}" ]]; then
    echo "Railway deployments require SANDBOX_REMOTE_RUNTIME_API_URL and SANDBOX_API_KEY"
    exit 1
  fi

  if [[ "$SANDBOX_USER_ID" -eq 0 ]]; then
    echo "Railway deployments require a non-zero SANDBOX_USER_ID"
    exit 1
  fi

  if [[ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]]; then
    export OH_WEB_URL="${OH_WEB_URL:-https://${RAILWAY_PUBLIC_DOMAIN}}"
    export OH_PERMITTED_CORS_ORIGINS_0="${OH_PERMITTED_CORS_ORIGINS_0:-https://${RAILWAY_PUBLIC_DOMAIN}}"
  fi

  export OH_PERSISTENCE_DIR="${OH_PERSISTENCE_DIR:-/data/.openhands}"
  export FILE_STORE_PATH="${FILE_STORE_PATH:-${OH_PERSISTENCE_DIR}}"
  export TMPDIR="${TMPDIR:-/data/tmp}"
fi

# Enforce the application/sandbox trust boundary before any runtime setup. This
# blocks hosted process sandboxes and hosted root execution even when NO_SETUP is
# used to bypass the normal user-creation path.
python -m openhands.app_server.sandbox.runtime_security

if [[ $NO_SETUP == "true" ]]; then
  echo "Skipping setup, running as $(whoami)"
  "$@"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "The OpenHands entrypoint.sh must run as root"
  exit 1
fi

if [ -z "$SANDBOX_USER_ID" ]; then
  echo "SANDBOX_USER_ID is not set"
  exit 1
fi

# Recreate configured state directories at runtime. This is required when a
# mounted volume (for example Railway /data) hides image-build-time paths. Give
# the planned non-root application user ownership before dropping privileges.
for directory in "${OH_PERSISTENCE_DIR:-}" "${FILE_STORE_PATH:-}" "${TMPDIR:-}"; do
  if [[ -n "$directory" ]]; then
    mkdir -p "$directory"
    if [[ "$SANDBOX_USER_ID" -ne 0 ]]; then
      chown -R "$SANDBOX_USER_ID:$SANDBOX_USER_ID" "$directory"
    fi
  fi
done

if [ -z "$WORKSPACE_MOUNT_PATH" ]; then
  # This is set to /opt/workspace in the Dockerfile. But if the user isn't mounting, we want to unset it so that OpenHands doesn't mount at all
  unset WORKSPACE_BASE
fi

if [[ "$SANDBOX_USER_ID" -eq 0 ]]; then
  echo "Running OpenHands as root"
  export RUN_AS_OPENHANDS=false
  "$@"
else
  echo "Setting up enduser with id $SANDBOX_USER_ID"
  if id "enduser" &>/dev/null; then
    echo "User enduser already exists. Skipping creation."
  else
    if ! useradd -l -m -u $SANDBOX_USER_ID -s /bin/bash enduser; then
      echo "Failed to create user enduser with id $SANDBOX_USER_ID. Moving openhands user."
      incremented_id=$(($SANDBOX_USER_ID + 1))
      usermod -u $incremented_id openhands
      if ! useradd -l -m -u $SANDBOX_USER_ID -s /bin/bash enduser; then
        echo "Failed to create user enduser with id $SANDBOX_USER_ID for a second time. Exiting."
        exit 1
      fi
    fi
  fi
  usermod -aG openhands enduser

  runtime="${RUNTIME:-docker}"
  if [[ "$runtime" != "remote" && "$runtime" != "local" && "$runtime" != "process" ]]; then
    if [ ! -S /var/run/docker.sock ]; then
      echo "Docker runtime selected but /var/run/docker.sock is unavailable"
      exit 1
    fi

    # Get the user group of /var/run/docker.sock and grant the non-root runtime
    # user access only when the Docker sandbox backend actually needs it.
    DOCKER_SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)
    echo "Docker socket group id: $DOCKER_SOCKET_GID"
    if getent group $DOCKER_SOCKET_GID; then
      echo "Group with id $DOCKER_SOCKET_GID already exists"
    else
      echo "Creating group with id $DOCKER_SOCKET_GID"
      groupadd -g $DOCKER_SOCKET_GID docker
    fi
    usermod -aG $DOCKER_SOCKET_GID enduser
  fi

  mkdir -p /home/enduser/.cache/huggingface/hub/

  echo "Running as enduser"
  su enduser /bin/bash -c "${*@Q}" # This magically runs any arguments passed to the script as a command
fi
