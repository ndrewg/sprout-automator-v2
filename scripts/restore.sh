#!/usr/bin/env bash
# Restore a Sprout Automator backup into a SCRATCH database — phase-5 §5.5.
#
# The restore path is deliberately a scratch database, never the live one: it
# proves a backup restores without touching production data. The `--clean
# --if-exists` flags (mandated by the spec) drop whatever is in the scratch DB
# first, so re-running against the same name is safe.
#
# Usage:
#   scripts/restore.sh /path/to/sprout-<stamp>.dump.gz [scratch-db-name]
#
# The scratch database defaults to sprout_restore_<epoch>. After it finishes,
# verify and drop it:
#   docker exec sprout-postgres psql -U sprout -d <scratch> -c '\dt'
#   docker exec sprout-postgres dropdb -U sprout <scratch>

set -euo pipefail

BACKUP_FILE="${1:?usage: restore.sh <backup.dump.gz> [scratch-db-name]}"
SCRATCH_DB="${2:-sprout_restore_$(date +%s)}"
PG_USER="${POSTGRES_USER:-sprout}"
CONTAINER="${SPROUT_POSTGRES_CONTAINER:-sprout-postgres}"

docker exec "$CONTAINER" dropdb -U "$PG_USER" --if-exists "$SCRATCH_DB"
docker exec "$CONTAINER" createdb -U "$PG_USER" "$SCRATCH_DB"

gzip -dc "$BACKUP_FILE" \
  | docker exec -i "$CONTAINER" pg_restore -U "$PG_USER" -d "$SCRATCH_DB" --clean --if-exists

echo "restored $BACKUP_FILE into scratch database $SCRATCH_DB"
echo "verify: docker exec $CONTAINER psql -U $PG_USER -d $SCRATCH_DB -c '\\dt'"
echo "cleanup: docker exec $CONTAINER dropdb -U $PG_USER $SCRATCH_DB"
