# PostgreSQL 17 + pgvector + PGroonga (한국어 전문 검색)
# pgvector 공식 이미지(Debian bookworm, PGDG 패키지 기반)에 PGroonga 를 추가한다.
FROM pgvector/pgvector:pg17

ARG PG_MAJOR=17

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates lsb-release wget; \
    codename="$(lsb_release --codename --short)"; \
    wget -q -O /tmp/groonga-apt-source.deb "https://packages.groonga.org/debian/groonga-apt-source-latest-${codename}.deb"; \
    apt-get install -y --no-install-recommends /tmp/groonga-apt-source.deb; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}-pgdg-pgroonga"; \
    rm -f /tmp/groonga-apt-source.deb; \
    apt-get purge -y --auto-remove wget lsb-release; \
    rm -rf /var/lib/apt/lists/*
