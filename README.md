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

## 그래프와 캔버스

- **그래프** (사이드바 `그래프`): 페이지(점)와 링크(선)를 한 화면에 보여 줍니다. 링크는 본문 속 하위 페이지·`@멘션`, 캔버스에 올린 페이지 카드입니다. 점을 누르면 그 페이지로 이동합니다.
- **캔버스** (사이드바 `새 캔버스`, 페이지 안에서 `/캔버스`): 페이지 카드·메모·이미지·링크·그룹을 놓고 선으로 잇는 화면입니다. 여러 사람이 동시에 편집합니다.
  - 기존 페이지는 사이드바에서 끌어다 놓거나 `+ 기존 페이지` 로 올립니다. 카드는 페이지를 가리킬 뿐이라 페이지 위치는 그대로입니다.
  - 캔버스에서 만든 새 페이지는 `새 페이지 위치`(기본: 캔버스와 같은 위치)에 생깁니다.
  - 페이지 카드는 본문 전체가 보이고, 더블클릭하면 카드 안에서 바로 편집합니다(↗ 로 페이지 열기).
  - 메모는 마크다운(제목·목록·체크박스·`[[페이지 제목]]` 링크)을 지원합니다. 카드 가장자리에서 선을 끌어 빈 곳에 놓으면 이어진 메모가 생깁니다.
  - 카드·선을 선택하면 색, 화살표 방향, 이름을 바꿀 수 있고, 그룹을 옮기면 안의 카드도 함께 옮겨집니다.
  - 페이지 안에 넣은 캔버스는 보기 전용 미리보기로 보이고, 누르면 캔버스가 열립니다.

## 확인

```bash
npm test                     # 단위 테스트
npm run verify               # 타입 검사·테스트·빌드 + 별도 포트에서 실제 실행 + Electron
npm run verify -- --docker   # + 운영 이미지와 설치 마법사
```

## 운영 배포 (Linux + Docker)

```bash
curl -fsSL https://raw.githubusercontent.com/hahava/noti/main/deploy/install.sh | bash
```

배포된 이미지(`ghcr.io/hahava/noty`, x86·ARM)를 받아 어드민을 띄우고 설치 코드 링크를 보여 줍니다. 소스는 필요 없습니다.
특정 버전: `NOTY_IMAGE=ghcr.io/hahava/noty:1.0.0` 을 앞에 붙입니다. 저장소 안에서 `deploy/install.sh` 를 실행하면 소스로 빌드합니다.

1. 브라우저로 `http://127.0.0.1:4010` 접속 (원격이면 `ssh -L 4010:127.0.0.1:4010 <서버>`)
2. 설치 코드 입력 후 마법사에서 선택
   - 데이터베이스: 기존 Postgres URL / 이 서버에 Docker로 생성
   - AI: 기존 Ollama URL / Docker로 생성 / 나중에
   - 접속 방법: 이 서버에서만 / 집·사내 네트워크 / 외부(VPN·터널) / 외부(도메인·HTTPS)
   - 첫 관리자 계정
3. 완료 화면에 브라우저·데스크톱 앱에 입력할 주소와 남은 할 일이 나옵니다.

외부 접속을 고르면 Noty 는 `127.0.0.1` 에만 열리고, 바깥 연결은 VPN·터널이나 리버스 프록시가 맡습니다.

마법사 없이 `.env` 로 직접 운영하려면: `deploy/.env.example` → `deploy/.env` 작성 후
`docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`

### 백업 · 복구

```bash
deploy/backup.sh                                   # deploy/backups/<시각>/ (DB + 첨부 파일)
deploy/restore.sh deploy/backups/<시각>
```

매일 자동 백업: `30 3 * * * cd /srv/noty && deploy/backup.sh` (crontab). 다른 기기로도 복사하려면 `BACKUP_REMOTE=<rsync 대상>`.

### 업데이트

어드민 화면 **시스템 → 업데이트** 에서 합니다.

1. 현재 버전·최신 버전과 변경 사항(GitHub Releases)을 확인하고 설치할 버전을 고릅니다. 낮은 버전을 고르면 되돌리기입니다.
2. `업데이트 전에 DB 백업` 을 켜 두면 Docker 로 만든 DB 를 `pg_dump` 로 설정 볼륨의 `backups/` 에 남깁니다(최근 5개).
3. 이미지를 받고 웹·API → 협업 → 어드민 순으로 새 버전으로 바꿉니다. 새 서버가 뜨지 않으면 이전 버전으로 자동 되돌립니다.

- 데이터(DB·첨부 파일·설정 볼륨)는 그대로 두고 컨테이너만 바꿉니다. DB 스키마는 추가만 하므로 되돌려도 데이터는 남습니다.
- 바꾸는 동안 몇 초간 접속이 끊길 수 있습니다.
- 배포 이미지(`ghcr.io`)로 Docker 설치한 경우에만 됩니다. 1.0.0 설치본은 이 기능이 없으므로 처음 한 번만 어드민을 바꿔 주세요:
  `curl -fsSL https://raw.githubusercontent.com/hahava/noti/main/deploy/install.sh | NOTY_IMAGE=ghcr.io/hahava/noty:<버전> bash`
- 새 버전 이미지는 `v*` 태그를 올리면 GitHub Actions 가 만듭니다. 같은 태그로 GitHub Release 를 만들면 업데이트 화면에 변경 사항이 보입니다.

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

## 라이선스

[GPL-3.0](./LICENSE). 다단 레이아웃(`@blocknote/xl-multi-column`)이 GPL-3.0 이라 전체를 GPL-3.0 으로 배포합니다.
배포물(데스크톱 앱, 서버 이미지)을 남에게 줄 때는 소스 코드도 함께 제공해야 합니다(저장소 주소 안내로 충분).
포함된 오픈소스 목록과 라이선스는 배포물 안의 `THIRD_PARTY_NOTICES.txt` 에 있습니다.
