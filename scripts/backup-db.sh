#!/usr/bin/env bash
# Nightly PostgreSQL backup for LapseIQ
# Keeps last 7 daily backups. Run via cron: 0 3 * * * /opt/lapseiq/scripts/backup-db.sh
set -euo pipefail

BACKUP_DIR="/opt/lapseiq/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="lapseiq_${TIMESTAMP}.sql.gz"
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR"

# Dump and compress
docker exec lapseiq-postgres pg_dump \
  -U "${POSTGRES_USER:-lapseiq}" \
  "${POSTGRES_DB:-lapseiq}" \
  | gzip > "${BACKUP_DIR}/${FILENAME}"

echo "✓ Backup saved: ${BACKUP_DIR}/${FILENAME}"

# Prune backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "lapseiq_*.sql.gz" -mtime +${KEEP_DAYS} -delete
echo "✓ Old backups pruned (kept last ${KEEP_DAYS} days)"
