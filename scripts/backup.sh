#!/usr/bin/env bash
# Nightly Postgres backup for Sprout Automator — phase-5 §5.5.
#
# Runs on the HOST (not inside a container) and calls into the running postgres
# container, so it needs Docker and nothing else. Produces a custom-format
# pg_dump (restoreable with scripts/restore.sh), gzip-compressed, written to
# $BACKUP_DIR (default ~/backups), and prunes files older than $RETENTION_DAYS.
#
# Install as a host crontab (03:00 Asia/Manila, per §5.5):
#   crontab -e
#   TZ=Asia/Manila
#   0 3 * * *  /path/to/sprout-automator/scripts/backup.sh >> "$HOME/backups/backup.log" 2>&1
#
# Overridable env: BACKUP_DIR, RETENTION_DAYS, POSTGRES_USER, POSTGRES_DB,
# SPROUT_POSTGRES_CONTAINER (default sprout-postgres).

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_USER="${POSTGRES_USER:-sprout}"
PG_DB="${POSTGRES_DB:-sprout}"
CONTAINER="${SPROUT_POSTGRES_CONTAINER:-sprout-postgres}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/sprout-$STAMP.dump.gz"

mkdir -p "$BACKUP_DIR"

docker exec "$CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc \
  | gzip > "$DEST"

find "$BACKUP_DIR" -name 'sprout-*.dump.gz' -mtime "+$RETENTION_DAYS" -delete

echo "backup written to $DEST"
