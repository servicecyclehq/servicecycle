#!/usr/bin/env bash
# restore-drill.sh - prove a ServiceCycle pg_dump actually restores.
#
# A backup you have never restored is a hope, not a backup. This script restores
# a dump into a throwaway scratch database INSIDE the Postgres container, runs a
# few smoke queries against it, then drops the scratch DB. It never touches the
# live database.
#
# Usage (run on the droplet):
#   ./restore-drill.sh                       # uses newest /root/predeploy-*.sql.gz
#   ./restore-drill.sh /root/backup.sql.gz   # restore a specific gzipped dump
#   DB_CONTAINER=servicecycle-db DB_USER=servicecycle ./restore-drill.sh
#
# Exit 0 = restore + smoke checks passed; non-zero = drill failed (investigate
# the backup BEFORE you need it). Safe to wire into cron with alerting.

set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-servicecycle-db}"
DB_USER="${DB_USER:-servicecycle}"
SCRATCH="restore_drill_$(date +%Y%m%d_%H%M%S)"

DUMP="${1:-}"
if [ -z "${DUMP}" ]; then
  DUMP="$(ls -1t /root/predeploy-*.sql.gz 2>/dev/null | head -n1 || true)"
fi
if [ -z "${DUMP}" ] || [ ! -f "${DUMP}" ]; then
  echo "FAIL: no dump file found (pass a path or place one at /root/predeploy-*.sql.gz)" >&2
  exit 2
fi

echo "== restore-drill =="
echo "dump:      ${DUMP}"
echo "container: ${DB_CONTAINER}  user: ${DB_USER}  scratch db: ${SCRATCH}"

cleanup() {
  docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d postgres \
    -c "DROP DATABASE IF EXISTS \"${SCRATCH}\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "-- creating scratch database"
docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d postgres \
  -c "CREATE DATABASE \"${SCRATCH}\";" >/dev/null

echo "-- restoring dump into scratch (this can take a minute)"
# Stream the gzipped dump into psql inside the container.
gunzip -c "${DUMP}" | docker exec -i "${DB_CONTAINER}" \
  psql -v ON_ERROR_STOP=1 -U "${DB_USER}" -d "${SCRATCH}" >/dev/null

echo "-- smoke queries against the restored copy"
SMOKE=$(docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${SCRATCH}" -tA -c "
  SELECT 'accounts='        || (SELECT count(*) FROM accounts)
      || ' users='          || (SELECT count(*) FROM users)
      || ' assets='         || (SELECT count(*) FROM assets)
      || ' activity_logs='  || (SELECT count(*) FROM activity_logs);
")
echo "   ${SMOKE}"

# Require at least one account + one user to call the restore usable.
ACCOUNTS=$(docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${SCRATCH}" -tA -c "SELECT count(*) FROM accounts;")
if [ "${ACCOUNTS}" -lt 1 ]; then
  echo "FAIL: restored database has 0 accounts - dump looks empty/corrupt" >&2
  exit 1
fi

echo "PASS: dump restored and smoke checks succeeded."