# syntax=docker/dockerfile:1
# Noty 운영 이미지 (빌드 컨텍스트: 저장소 루트)
# 하나의 이미지로 어드민(설치 마법사 포함), 메인 API(웹 화면 포함), 협업 서버를 모두 실행한다.

FROM node:22.22.2-bookworm-slim AS deps
WORKDIR /app
# devDependencies 의 electron 이 데스크톱 바이너리를 내려받지 않게 한다.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/admin/package.json apps/admin/
RUN npm ci

FROM deps AS build
COPY . .
RUN npx tsc -b && npm run build:web && npm run build:admin \
    && node scripts/generate-notices.mjs THIRD_PARTY_NOTICES.txt @noty/server @noty/admin @noty/web

FROM node:22.22.2-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    NOTY_UPLOADS_DIR=/app/server-data/uploads \
    NOTY_WEB_DIST=/app/apps/web/dist \
    NOTY_CONFIG_DIR=/app/config
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/admin/package.json apps/admin/
RUN npm ci --omit=dev --workspace @noty/server --workspace @noty/admin && npm cache clean --force
COPY . .
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/admin/web/dist ./apps/admin/web/dist
COPY --from=build /app/THIRD_PARTY_NOTICES.txt ./THIRD_PARTY_NOTICES.txt
RUN mkdir -p /app/server-data/uploads /app/config && chown -R node:node /app/server-data /app/config
USER node
EXPOSE 4000 4001 4010
CMD ["npx", "tsx", "apps/admin/server/index.ts"]
