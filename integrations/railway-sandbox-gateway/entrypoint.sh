#!/bin/sh
set -eu

registry_path="${RUNTIME_REGISTRY_PATH:-/data/railway-sandbox-gateway/runtimes.json}"
registry_dir="$(dirname "$registry_path")"

case "$registry_dir" in
  /data|/data/*)
    mkdir -p "$registry_dir"
    chown -R node:node "$registry_dir"
    ;;
esac

exec gosu node "$@"
