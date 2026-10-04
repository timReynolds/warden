# PostgreSQL 18 deployment and upgrade

Both Compose deployments use PostgreSQL 18 and mount storage at
`/var/lib/postgresql`. PostgreSQL stores its cluster in `18/docker` beneath that
mount. The production volume keeps its existing name by default; set
`WARDEN_POSTGRES_VOLUME` to choose a different named volume during an upgrade.
Local development also supports `WARDEN_POSTGRES_DATA_DIR` for a bind mount.

An existing PostgreSQL 17 cluster requires a database upgrade. Changing the image
and mount path does not migrate it: the PostgreSQL 18 entrypoint refuses the old
cluster rather than initializing an empty replacement. Do not remove the old
volume, change `PGDATA` to bypass that check, or run `docker compose down -v`.

## Upgrade the bundled production database

This backup-and-restore procedure requires maintenance downtime, disk space for
both clusters and the backup, and Docker Compose 2.24.4 or newer for `!override`.
It assumes the bundled `warden` database and role and the same production
configuration, project name, and credentials throughout. If you use an external
`DATABASE_URL`, upgrade that database through its own administration process
instead. Additional databases or custom roles need their own backups and restore
plan.

1. Stop every application process that can write to the database. Keep the
   currently selected production volume unchanged while taking the backup.
   The temporary override starts the existing cluster with PostgreSQL 17 and its
   original mount location:

   ```sh
   docker compose -f compose.production.yml --profile split stop app api worker
   cat > /tmp/warden-postgres17.yml <<'YAML'
   services:
     postgres:
       image: postgres:17.9-alpine
       volumes: !override [warden-data:/var/lib/postgresql/data]
   YAML
   docker compose -f compose.production.yml -f /tmp/warden-postgres17.yml up -d --wait postgres
   (umask 077; docker compose -f compose.production.yml -f /tmp/warden-postgres17.yml exec -T postgres pg_dump -U warden -d warden -Fc > warden-pg17.dump)
   test -s warden-pg17.dump
   docker compose -f compose.production.yml -f /tmp/warden-postgres17.yml exec -T postgres pg_restore --list < warden-pg17.dump > /dev/null
   docker compose -f compose.production.yml -f /tmp/warden-postgres17.yml stop postgres
   ```

   Proceed only if the dump and archive-list commands both succeed. Record the
   old volume name and keep the backup in a secure location. A restore rehearsal
   is the strongest check that the backup is usable.

2. Choose a unique, unused replacement volume. Verify that the name does not
   already exist before starting PostgreSQL 18. Save this selection in the
   production environment configuration so later deployments use the same
   volume; do not rely only on a temporary shell export.

   ```sh
   export WARDEN_POSTGRES_VOLUME=warden-production-pg18
   # This command must report that the volume does not exist.
   docker volume inspect "$WARDEN_POSTGRES_VOLUME"
   docker compose -f compose.production.yml up -d --wait postgres
   docker compose -f compose.production.yml exec -T postgres pg_restore -U warden -d warden --exit-on-error < warden-pg17.dump
   docker compose -f compose.production.yml exec -T postgres psql -U warden -d warden -v ON_ERROR_STOP=1 -c 'SELECT version();' -c '\dt' -c 'SELECT count(*) FROM warden_deliveries;'
   ```

   Stop on any restore error. Check the schema and history against the source
   database before enabling application writes. The original PostgreSQL 17 volume
   remains available if the restore needs to be repeated into another fresh
   volume.

3. Start the normal combined app, or the `split` profile used by your deployment:

   ```sh
   docker compose -f compose.production.yml up -d --build app
   # For a split deployment, use this instead:
   # docker compose -f compose.production.yml --profile split up -d --build api worker
   ```

   Verify `/ready`, signed webhook processing, and retained delivery history.
   Retain the old volume and backup until the upgraded deployment is accepted.
   Once PostgreSQL 18 has accepted new writes, restarting the old cluster would
   lose those writes; recovery then requires a deliberate reconciliation or
   restore plan.

Fresh local/demo deployments can create new PostgreSQL 18 storage immediately.
To retain local PostgreSQL 17 history, use the same backup-and-restore procedure
and select a fresh `WARDEN_POSTGRES_DATA_DIR` or a Compose volume override.

## Verify the upgrade safeguards

Run `sh scripts/test-postgres-upgrade.sh`. It creates disposable PostgreSQL 17 and
18 clusters, verifies that the new mount refuses unmigrated data, restores a
backup, checks restart persistence, and confirms the source cluster still has
its data. Cleanup removes only resources created by that test run. CI runs this
check alongside the application integration suite against PostgreSQL 18.

The image's data-directory change is described in the
[official PostgreSQL image documentation](https://hub.docker.com/_/postgres).
