#!/usr/bin/env bash
# Noty 설치 시작: 이미지를 빌드하고 어드민(설치 마법사)만 띄운다.
# 나머지(DB, Ollama, 서비스, 첫 관리자)는 브라우저의 설치 마법사에서 고른다.
#
#   deploy/install.sh
#   → 브라우저로 http://127.0.0.1:4010 (원격 서버면: ssh -L 4010:127.0.0.1:4010 <서버>)
#
# Linux 의 Docker Engine 은 host 네트워크(서버의 127.0.0.1 을 그대로 공유),
# Docker Desktop(macOS·Windows)은 Docker 네트워크 + 포트 공개 방식으로 자동 선택한다.
# 직접 고르려면: NOTY_DOCKER_NETWORK=host|bridge deploy/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${NOTY_APP_IMAGE:-noty-app:latest}"
PORT="${NOTY_ADMIN_PORT:-4010}"
SOCKET=/var/run/docker.sock

if ! docker info >/dev/null 2>&1; then
  echo "Docker 에 연결할 수 없습니다. Docker 가 실행 중인지 확인하세요." >&2
  exit 1
fi

MODE="${NOTY_DOCKER_NETWORK:-}"
if [[ -z "$MODE" ]]; then
  if docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi "docker desktop"; then MODE=bridge; else MODE=host; fi
fi

echo "[1/3] 이미지 빌드: $IMAGE"
docker build -f deploy/Dockerfile --target app -t "$IMAGE" .

echo "[2/3] 어드민 컨테이너 시작 (http://127.0.0.1:$PORT, 네트워크: $MODE)"
docker rm -f noty-admin >/dev/null 2>&1 || true
docker volume create noty_config >/dev/null
COMMON=(
  --name noty-admin --restart unless-stopped
  --label dev.noty.managed=true
  -v "$SOCKET:$SOCKET"
  -v noty_config:/app/config
  -e NOTY_APP_IMAGE="$IMAGE"
  -e NOTY_DOCKER_NETWORK="$MODE"
)
if [[ "$MODE" == "host" ]]; then
  # 소켓 그룹 권한으로 Docker 를 제어한다 (root 로 돌리지 않는다).
  GID="$(stat -c %g "$SOCKET" 2>/dev/null || stat -f %g "$SOCKET")"
  docker run -d "${COMMON[@]}" --network host --group-add "$GID" \
    -e ADMIN_HOST=127.0.0.1 -e ADMIN_PORT="$PORT" \
    "$IMAGE" npx tsx apps/admin/server/index.ts >/dev/null
else
  # Docker Desktop: 마법사가 만드는 컨테이너와 같은 네트워크에서 이름으로 찾고, 어드민 포트만 이 컴퓨터에 연다.
  # (Docker Desktop 의 소켓은 root 전용이라 어드민을 root 로 실행한다. 이 소켓 자체가 Docker Desktop VM 의 root 권한이다.)
  docker network create noty >/dev/null 2>&1 || true
  docker run -d "${COMMON[@]}" --network noty -p "127.0.0.1:$PORT:4010" --user root \
    --add-host host.docker.internal:host-gateway \
    -e ADMIN_HOST=0.0.0.0 -e ADMIN_PORT=4010 \
    "$IMAGE" npx tsx apps/admin/server/index.ts >/dev/null
fi

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
