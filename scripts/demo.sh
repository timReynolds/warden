#!/bin/sh
set -eu
# Isolation protects any existing Warden database. No automatic volume removal.
WARDEN_DEMO_PROJECT=${WARDEN_DEMO_PROJECT:-warden-demo-$(date +%s)}
WARDEN_PORT=${WARDEN_PORT:-3100}
export WARDEN_DEMO_PROJECT WARDEN_PORT
# A service/development data path must never become fresh demo storage.
unset WARDEN_POSTGRES_DATA_DIR
if [ -n "${WARDEN_DEMO_DATA_ROOT:-}" ]; then
  WARDEN_POSTGRES_DATA_DIR="$WARDEN_DEMO_DATA_ROOT/$WARDEN_DEMO_PROJECT"
  if [ -e "$WARDEN_POSTGRES_DATA_DIR" ]; then
    printf 'Refusing to reuse demo data directory: %s\n' "$WARDEN_POSTGRES_DATA_DIR" >&2
    exit 1
  fi
  mkdir -p "$WARDEN_POSTGRES_DATA_DIR"
  export WARDEN_POSTGRES_DATA_DIR
fi
compose() { docker compose --env-file /dev/null -p "$WARDEN_DEMO_PROJECT" -f compose.yml "$@"; }
trap 'compose stop worker api github postgres >/dev/null 2>&1 || true' EXIT
compose up -d --build postgres migrate github api worker
compose run --rm --build --no-deps demo
compose stop worker
compose run --rm --no-deps demo bun run demo:assert prepare-restart
compose start worker
compose run --rm --no-deps demo bun run demo:assert verify-restart
printf 'Demo passed. Retained history: project %s (data %s).\n' "$WARDEN_DEMO_PROJECT" "${WARDEN_POSTGRES_DATA_DIR:-${WARDEN_DEMO_PROJECT}_warden-data}"
