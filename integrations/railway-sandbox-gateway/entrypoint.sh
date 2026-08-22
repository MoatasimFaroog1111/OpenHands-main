#!/bin/sh
set -eu

registry_path="${RUNTIME_REGISTRY_PATH:-/data/railway-sandbox-gateway/runtimes.json}"

case "$registry_path" in
  /data/railway-sandbox-gateway/*) ;;
  *)
    echo "RUNTIME_REGISTRY_PATH must stay under /data/railway-sandbox-gateway" >&2
    exit 1
    ;;
esac

case "/$registry_path/" in
  *"/../"*|*"/./"*)
    echo "RUNTIME_REGISTRY_PATH must not contain relative path segments" >&2
    exit 1
    ;;
esac

mkdir -p /data/railway-sandbox-gateway
chown node:node /data/railway-sandbox-gateway
chmod 0700 /data/railway-sandbox-gateway

exec gosu node "$@"
