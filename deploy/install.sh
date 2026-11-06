#!/usr/bin/env bash
# Noty 설치 시작: 이미지를 준비하고 어드민(설치 마법사)만 띄운다.
# 나머지(DB, Ollama, 서비스, 첫 관리자)는 브라우저의 설치 마법사에서 고른다.
#
#   소스 없이 (서버):   curl -fsSL https://raw.githubusercontent.com/hahava/noti/main/deploy/install.sh | bash
#                       → 배포된 이미지(ghcr.io/hahava/noty)를 받아서 실행
#   저장소 안에서:      deploy/install.sh            → 소스로 이미지를 빌드해서 실행
#   버전 지정:          NOTY_IMAGE=ghcr.io/hahava/noty:1.0.0 ... (저장소 안에서도 이 값이 있으면 받아서 실행)
#
# Linux 의 Docker Engine 은 host 네트워크(서버의 127.0.0.1 을 그대로 공유),
# Docker Desktop(macOS·Windows)은 Docker 네트워크 + 포트 공개 방식으로 자동 선택한다.
# 직접 고르려면: NOTY_DOCKER_NETWORK=host|bridge deploy/install.sh
set -euo pipefail

DEFAULT_IMAGE="ghcr.io/hahava/noty:latest"
# 저장소 안에서 실행했는지 (curl | bash 로 실행하면 스크립트 파일이 없다)
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
REPO_DIR=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && -f "$(dirname "$SCRIPT_PATH")/Dockerfile" ]]; then
  REPO_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
fi
if [[ -n "${NOTY_IMAGE:-}" || -z "$REPO_DIR" ]]; then
  IMAGE="${NOTY_IMAGE:-$DEFAULT_IMAGE}"
  SOURCE=pull
else
  IMAGE="${NOTY_APP_IMAGE:-noty-app:latest}"
  SOURCE=build
fi
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

if [[ "$SOURCE" == pull ]]; then
  echo "[1/3] 이미지 받기: $IMAGE"
  docker pull "$IMAGE"
else
  echo "[1/3] 이미지 빌드 (소스): $IMAGE"
  docker build -f "$REPO_DIR/deploy/Dockerfile" --target app -t "$IMAGE" "$REPO_DIR"
fi

docker rm -f noty-admin >/dev/null 2>&1 || true
# 어드민 포트가 쓰는 중이면(예: 개발용 어드민) 다음 빈 포트를 고른다. NOTY_ADMIN_PORT 로 직접 정할 수도 있다.
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if [[ -z "${NOTY_ADMIN_PORT:-}" ]]; then
  for candidate in 4010 4011 4012 4013 4014 4015 4110 4210; do
    if ! port_in_use "$candidate"; then PORT="$candidate"; break; fi
  done
elif port_in_use "$PORT"; then
  echo "127.0.0.1:$PORT 포트를 이미 다른 프로그램이 쓰고 있습니다. NOTY_ADMIN_PORT 로 다른 포트를 정하세요." >&2
  exit 1
fi
[[ "$PORT" != "4010" ]] && echo "      (4010 포트가 사용 중이라 $PORT 를 씁니다)"

echo "[2/3] 어드민 컨테이너 시작 (http://127.0.0.1:$PORT, 네트워크: $MODE)"
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
CODE="$(docker logs noty-admin 2>&1 | grep -oE "설치 코드: [A-Z0-9-]+" | awk '{print $3}' | tail -1)"
if [[ -n "$CODE" ]]; then
  cat <<MSG

설치 코드: $CODE
브라우저로 아래 링크를 열면 바로 설치 마법사가 시작됩니다:

  http://127.0.0.1:$PORT/?code=$CODE

다른 컴퓨터에서 열려면 먼저: ssh -L $PORT:127.0.0.1:$PORT <이 서버>
MSG
else
  docker logs noty-admin 2>&1 | grep -E "Admin\]" || true
  echo
  echo "이미 설치된 상태입니다. 브라우저로 http://127.0.0.1:$PORT 에서 관리자 계정으로 로그인하세요."
fi
