# Noty

셀프 호스팅 문서 워크스페이스. 웹·데스크톱(Electron)에서 쓰고, 실시간 협업·AI 어시스턴트·한국어 검색·LLM 위키를 지원합니다.

## 구성

| 경로 | 내용 |
|---|---|
| `apps/web` | 웹 화면 (React, BlockNote) |
| `apps/server` | API + 실시간 협업 서버 (웹 화면도 함께 제공) |
| `apps/desktop` | 데스크톱 앱 (Electron) |
| `apps/admin` | 어드민: 계정·역할, AI 모델, 시스템 설정, 설치 마법사 |
| `packages/core`, `packages/shared` | 공유 코드 |
| `deploy/` | 운영 이미지·설치·백업 스크립트 |

## 개발

필요: Node.js 22, Docker

```bash
npm install
npm run db:up        # PostgreSQL (pgvector + PGroonga), 127.0.0.1:5434
npm run dev          # API + 협업 + 웹(Vite) + 데스크톱 앱
```

| 명령 | 주소 |
|---|---|
| `npm run dev` | 웹 http://127.0.0.1:5173 · API http://127.0.0.1:4000 |
| `npm run dev:web` | 데스크톱 앱 없이 브라우저용만 |
| `npm run dev:admin` | 어드민 http://127.0.0.1:5180 |

- 빈 DB에서는 첫 관리자 `admin` 이 만들어집니다. 비밀번호는 `NOTY_ADMIN_PASSWORD` 로 정하고, 비워 두면 API 로그에 한 번 출력됩니다.
- 계정 추가, 역할(관리자 / 편집자 / 읽기 전용), AI 모델 설정은 어드민에서 합니다.

## 확인

```bash
npm test                     # 단위 테스트
npm run verify               # 타입 검사·테스트·빌드 + 별도 포트에서 실제 실행 + Electron
npm run verify -- --docker   # + 운영 이미지와 설치 마법사
```

## 운영 배포 (Linux + Docker)

```bash
git clone <저장소> /srv/noty && cd /srv/noty
deploy/install.sh            # 이미지 빌드 → 어드민 실행 → 설치 코드 출력
```

1. 브라우저로 `http://127.0.0.1:4010` 접속 (원격이면 `ssh -L 4010:127.0.0.1:4010 <서버>`)
2. 설치 코드 입력 후 마법사에서 선택
   - 데이터베이스: 기존 Postgres URL / 이 서버에 Docker로 생성
   - AI: 기존 Ollama URL / Docker로 생성 / 나중에
   - 서비스: Docker로 실행 / 직접 실행
   - 첫 관리자 계정
3. 완료 후 Noty: `http://127.0.0.1:4000` (설치 때 `0.0.0.0` 을 고르면 같은 네트워크에서 바로 접속)

모든 서비스는 기본적으로 `127.0.0.1` 에만 열립니다. 외부 공개는 리버스 프록시나 VPN을 쓰세요.
Tailscale 예시: `deploy/tailscale-serve.sh`, `deploy/tailscale-acl.example.hujson`.

마법사 없이 `.env` 로 직접 운영하려면: `deploy/.env.example` → `deploy/.env` 작성 후
`docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`

### 백업 · 복구

```bash
deploy/backup.sh                                   # deploy/backups/<시각>/ (DB + 첨부 파일)
deploy/restore.sh deploy/backups/<시각>
```

매일 자동 백업: `30 3 * * * cd /srv/noty && deploy/backup.sh` (crontab). 다른 기기로도 복사하려면 `BACKUP_REMOTE=<rsync 대상>`.

### 업데이트

```bash
deploy/backup.sh && git pull
docker build -f deploy/Dockerfile --target app -t noty-app:latest .
docker restart noty-api noty-collab noty-admin
```

## 데스크톱 앱

```bash
npm run dist                 # release/ 에 dmg · 설치 파일 · AppImage
```

앱 로그인 화면에 Noty 서버 주소를 입력해 사용합니다.

## 주요 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DATABASE_URL` | 개발 DB | PostgreSQL 주소 |
| `HOST` / `PORT` | `127.0.0.1` / `4000` | API 주소 |
| `NOTY_ADMIN_PASSWORD` | 무작위 | 빈 DB의 첫 관리자 비밀번호 |
| `CORS_ALLOWED_ORIGINS` | 모두 허용 | 허용할 브라우저 주소 (Electron은 항상 허용) |
| `FILE_URL_SECRET` | DB에 저장 | 첨부 파일 서명 키 |
| `TRUST_PROXY` | 꺼짐 | 리버스 프록시 뒤에서 `1` |
| `NOTY_DATA_DIR` | `server-data/` | 첨부 파일 등 데이터 폴더 |
| `ADMIN_HOST` / `ADMIN_PORT` | `127.0.0.1` / `4010` | 어드민 주소 |
| `REDIS_URL` | 없음 | 협업 서버 여러 대 운영 시 |
