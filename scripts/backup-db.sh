#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OPTIONAL standalone PostgreSQL backup for ServiceCycle.
#
# ⚠ DO NOT run this alongside the default deployment. The app ALREADY runs an
#   in-process nightly pg_dump cron (02:00, 30-day retention) into ./backups on
#   the host (see DEPLOY_RUNBOOK §9 / §11). Enabling this script as a second
#   cron creates a DUPLICATE, on-box-only backup at a DIFFERENT path and gives
#   false confidence — neither this nor the in-app default is offsite unless you
#   configure `BACKUP_DEST=s3` (+ `BACKUP_S3_*`) in the server .env.
#
# Use this script ONLY if you have intentionally disabled the in-app backup cron
# and want a host-level cron instead. If you do:
#   - Point BACKUP_DIR at the directory you actually sync off-box.
#   - The documented droplet path is /root/ServiceCycle (NOT /opt/servicecycle);
#     BACKUP_DIR below is overridable via the BACKUP_DIR env var for that reason.
#   - Cron example (adjust the absolute path to wherever you placed this file):
#       0 3 * * * BACKUP_DIR=/root/ServiceCycle/backups /root/ServiceCycle/scripts/backup-db.sh
#
# Keeps last 7 daily backups.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Overridable; defaults to the in-app backup dir under the documented deploy path.
BACKUP_DIR="${BACKUP_DIR:-/root/ServiceCycle/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="servicecycle_${TIMESTAMP}.sql.gz"
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR"

# Dump and compress
docker exec servicecycle-db pg_dump \
  -U "${POSTGRES_USER:-servicecycle}" \
  "${POSTGRES_DB:-servicecycle}" \
  | gzip > "${BACKUP_DIR}/${FILENAME}"

echo "✓ Backup saved: ${BACKUP_DIR}/${FILENAME}"

# Prune backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "servicecycle_*.sql.gz" -mtime +${KEEP_DAYS} -delete
echo "✓ Old backups pruned (kept last ${KEEP_DAYS} days)"
