#!/usr/bin/env bash
# 백업 하나를 되살린다. 지금 DB 와 첨부 파일을 덮어쓰므로 먼저 backup.sh 를 한 번 더 돌려 둘 것.
#   deploy/restore.sh deploy/backups/20261105-033000
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?백업 폴더를 지정하세요}"
COMPOSE=(docker compose -f deploy/docker-compose.yml --env-file deploy/.env)

( cd "$SRC" && sha256sum -c SHA256SUMS )
read -r -p "현재 데이터를 $SRC 로 덮어씁니다. 계속할까요? (yes) " answer
[[ "$answer" == "yes" ]] || exit 1

"${COMPOSE[@]}" stop api collab admin
"${COMPOSE[@]}" exec -T db pg_restore -U noty -d noty --clean --if-exists --no-owner < "$SRC/noty.dump"
"${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh api -c 'rm -rf /app/server-data/uploads && tar -C /app/server-data -xz' < "$SRC/uploads.tar.gz"
"${COMPOSE[@]}" start api collab admin
echo "[restore] done"
