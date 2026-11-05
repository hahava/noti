#!/usr/bin/env bash
# DB + 첨부 파일 백업. cron 예시 (매일 03:30):
#   30 3 * * * cd /srv/noty && deploy/backup.sh >> deploy/backups/backup.log 2>&1
# BACKUP_REMOTE 를 주면(rsync 대상, 예: nas:/volume1/backup/noty) 서버 밖으로도 복사한다.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f deploy/docker-compose.yml --env-file deploy/.env)
BACKUP_DIR="${BACKUP_DIR:-deploy/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/$STAMP"
mkdir -p "$TARGET"

"${COMPOSE[@]}" exec -T db pg_dump -U noty -d noty -Fc > "$TARGET/noty.dump"
"${COMPOSE[@]}" exec -T api tar -C /app/server-data -cz uploads > "$TARGET/uploads.tar.gz"
( cd "$TARGET" && sha256sum noty.dump uploads.tar.gz > SHA256SUMS )
echo "[backup] $TARGET ($(du -sh "$TARGET" | cut -f1))"

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} +

if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  rsync -a --delete "$BACKUP_DIR/" "$BACKUP_REMOTE/"
  echo "[backup] copied to $BACKUP_REMOTE"
fi
