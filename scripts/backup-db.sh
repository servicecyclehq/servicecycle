#!/usr/bin/env bash
# Nightly PostgreSQL backup for ServiceCycle
# Keeps last 7 daily backups. Run via cron: 0 3 * * * /opt/servicecycle/scripts/backup-db.sh
set -euo pipefail

BACKUP_DIR="/opt/servicecycle/backups"
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
