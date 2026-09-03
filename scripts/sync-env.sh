#!/usr/bin/env bash
# Push the local .env.local to the droplet over rsync, then restart the stack.
# Secrets never enter git or the Docker build context; Compose injects them at run time.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@64.227.146.141}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/automata}"
LOCAL_ENV="${1:-.env.local}"

[ -f "$LOCAL_ENV" ] || { echo "missing $LOCAL_ENV" >&2; exit 1; }

rsync -avz "$LOCAL_ENV" "$HOST:$REMOTE_DIR/.env.local"
ssh "$HOST" "chmod 600 $REMOTE_DIR/.env.local"

if [ "${RESTART:-1}" = "1" ]; then
  ssh "$HOST" "cd $REMOTE_DIR && docker compose --env-file .env.local up -d --build && docker compose ps"
fi
