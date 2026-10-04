#!/bin/sh
set -eu

# All containers, volumes, and backups belong to this disposable test run.
upgrade_case="warden-pg-upgrade-$(date +%s)-$$"
upgrade_backup=$(mktemp -d)
old_container="$upgrade_case-17"
new_container="$upgrade_case-18"
probe_container="$upgrade_case-probe"
old_volume="$upgrade_case-old"
new_volume="$upgrade_case-new"
cleanup() {
  docker rm -f "$old_container" "$new_container" "$probe_container" >/dev/null 2>&1 || true
  docker volume rm "$old_volume" "$new_volume" >/dev/null 2>&1 || true
  rm -rf "$upgrade_backup"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

ready() {
  upgrade_attempt=0
  until docker exec "$1" pg_isready -h 127.0.0.1 -U warden -d warden >/dev/null 2>&1; do
    upgrade_attempt=$((upgrade_attempt + 1))
    if [ "$upgrade_attempt" -ge 60 ]; then
      docker logs "$1" >&2
      return 1
    fi
    sleep 1
  done
}
query() {
  docker exec "$1" psql -U warden -d warden -v ON_ERROR_STOP=1 -Atc "$2"
}

docker volume create "$old_volume" >/dev/null
docker volume create "$new_volume" >/dev/null
docker run -d --name "$old_container" \
  -e POSTGRES_USER=warden -e POSTGRES_PASSWORD=upgrade-test -e POSTGRES_DB=warden \
  --mount "type=volume,src=$old_volume,dst=/var/lib/postgresql/data" \
  postgres:17.9-alpine >/dev/null
ready "$old_container"
query "$old_container" "CREATE TABLE upgrade_evidence (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO upgrade_evidence VALUES (1, 'durable Warden history');" >/dev/null
docker exec "$old_container" pg_dump -U warden -d warden -Fc > "$upgrade_backup/warden.dump"
docker stop "$old_container" >/dev/null

# The new parent-directory mount must refuse the old cluster instead of
# silently creating an empty PostgreSQL 18 database alongside it.
docker run -d --name "$probe_container" \
  -e POSTGRES_USER=warden -e POSTGRES_PASSWORD=upgrade-test -e POSTGRES_DB=warden \
  --mount "type=volume,src=$old_volume,dst=/var/lib/postgresql" \
  postgres:18.6-alpine >/dev/null
probe_attempt=0
while [ "$(docker inspect --format '{{.State.Running}}' "$probe_container")" = true ]; do
  probe_attempt=$((probe_attempt + 1))
  if [ "$probe_attempt" -ge 30 ]; then
    docker logs "$probe_container" >&2
    printf '%s\n' 'PostgreSQL 18 did not refuse the old cluster within 30 seconds.' >&2
    exit 1
  fi
  sleep 1
done
probe_status=$(docker wait "$probe_container")
test "$probe_status" -ne 0
probe_log=$(docker logs "$probe_container" 2>&1)
case "$probe_log" in
  *"upgrading the underlying database"*) ;;
  *) printf '%s\n' "$probe_log" >&2; exit 1 ;;
esac
docker run --rm --entrypoint sh \
  --mount "type=volume,src=$old_volume,dst=/var/lib/postgresql,readonly" \
  postgres:18.6-alpine -ec \
  'test "$(cat /var/lib/postgresql/PG_VERSION)" = 17; test ! -e /var/lib/postgresql/18/docker/PG_VERSION'
printf '%s\n' 'PostgreSQL 18 refuses unmigrated PostgreSQL 17 data.'

docker run -d --name "$new_container" \
  -e POSTGRES_USER=warden -e POSTGRES_PASSWORD=upgrade-test -e POSTGRES_DB=warden \
  --mount "type=volume,src=$new_volume,dst=/var/lib/postgresql" \
  postgres:18.6-alpine >/dev/null
ready "$new_container"
docker exec -i "$new_container" pg_restore -U warden -d warden --exit-on-error < "$upgrade_backup/warden.dump"
test "$(query "$new_container" 'SELECT value FROM upgrade_evidence WHERE id=1')" = 'durable Warden history'
test "$(query "$new_container" 'SHOW data_directory')" = /var/lib/postgresql/18/docker
docker restart "$new_container" >/dev/null
ready "$new_container"
test "$(query "$new_container" 'SELECT value FROM upgrade_evidence WHERE id=1')" = 'durable Warden history'
docker start "$old_container" >/dev/null
ready "$old_container"
test "$(query "$old_container" 'SELECT value FROM upgrade_evidence WHERE id=1')" = 'durable Warden history'
printf '%s\n' 'Backup restore and PostgreSQL 18 restart preserve data; the PostgreSQL 17 source remains intact.'
