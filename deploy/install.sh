#!/usr/bin/env bash
# Noty 설치 시작: 이미지를 빌드하고 어드민(설치 마법사)만 띄운다.
# 나머지(DB, Ollama, 서비스, 첫 관리자)는 브라우저의 설치 마법사에서 고른다.
#
#   deploy/install.sh
#   → 브라우저로 http://127.0.0.1:4010 (원격 서버면: ssh -L 4010:127.0.0.1:4010 <서버>)
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${NOTY_APP_IMAGE:-noty-app:latest}"
PORT="${NOTY_ADMIN_PORT:-4010}"
SOCKET=/var/run/docker.sock

echo "[1/3] 이미지 빌드: $IMAGE"
docker build -f deploy/Dockerfile --target app -t "$IMAGE" .

echo "[2/3] 어드민 컨테이너 시작 (127.0.0.1:$PORT)"
docker rm -f noty-admin >/dev/null 2>&1 || true
docker volume create noty_config >/dev/null
docker run -d --name noty-admin --restart unless-stopped --network host \
  --label dev.noty.managed=true \
  --group-add "$(stat -c %g "$SOCKET")" \
  -v "$SOCKET:$SOCKET" \
  -v noty_config:/app/config \
  -e ADMIN_HOST=127.0.0.1 -e ADMIN_PORT="$PORT" -e NOTY_APP_IMAGE="$IMAGE" \
  "$IMAGE" npx tsx apps/admin/server/index.ts >/dev/null

echo "[3/3] 설치 코드 확인"
for _ in $(seq 1 30); do
  if docker logs noty-admin 2>&1 | grep -q "설치 코드\|공유 DB"; then break; fi
  sleep 1
done
docker logs noty-admin 2>&1 | grep -E "설치 코드|Admin\]" || true
cat <<MSG

브라우저로 http://127.0.0.1:$PORT 를 열고 설치 코드를 입력하세요.
다른 컴퓨터에서 열려면: ssh -L $PORT:127.0.0.1:$PORT <이 서버>
MSG
