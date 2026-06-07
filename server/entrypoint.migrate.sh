#!/bin/sh
# S4-FN-01 (v0.75.x): migrate-only entrypoint -- runs as an init container.
# Exits 0 on success, non-zero on failure. The API container depends on this
# service completing successfully (service_completed_successfully), so a
# failed migration leaves the API un-started instead of crash-looping.
#
# S6-FN-03: identity probe before migrate deploy catches copy-paste staging URLs.
set -e

echo "[migrate] ===== LapseIQ database migration entrypoint ====="

# S6-FN-03: psql probe -- show which DB we are about to migrate.
# postgresql-client is installed in the server image (used by lib/backup.js).
echo "[migrate] Probing database identity..."
psql "$DATABASE_URL" -c "SELECT current_database() AS db, current_schema() AS schema, COALESCE(inet_server_addr()::text,'local') AS host, COALESCE(inet_server_port()::text,'n/a') AS port;" || {
  echo "[migrate] FATAL: cannot connect to DATABASE_URL"
  exit 1
}

echo "[migrate] Applying pending migrations (npx prisma migrate deploy)..."
npx prisma migrate deploy

echo "[migrate] Done. Exiting 0."