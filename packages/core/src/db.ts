import pg from "pg";
import { readInstallConfig } from "./config.js";

const { Pool } = pg;

const DEV_DATABASE_URL = "postgresql://notion:notion@127.0.0.1:5434/notion_like";

/**
 * 메인 API·협업 서버·어드민 서버가 함께 쓰는 PostgreSQL 연결.
 * 우선순위: DATABASE_URL 환경변수 → 설치 설정 파일 → 개발 기본값.
 * 어드민의 설치 마법사가 DB 를 만든 뒤 reconfigureDatabase() 로 연결을 바꾼다.
 * (pool, DATABASE_URL 은 live binding 이라 바꾼 값이 가져다 쓰는 쪽에도 바로 보인다)
 */
export let DATABASE_URL = process.env.DATABASE_URL || readInstallConfig()?.database.url || DEV_DATABASE_URL;

function createPool(connectionString: string): pg.Pool {
  const next = new Pool({ connectionString });
  // DB 재시작 등으로 놀고 있던 연결이 끊기면 pool 이 'error' 를 낸다.
  // 처리하지 않으면 프로세스 전체가 종료되므로 기록만 하고, 다음 요청에서 새 연결을 맺게 둔다.
  next.on("error", (error) => {
    console.error("[db] 유휴 연결 오류 (자동 재연결):", error.message);
  });
  return next;
}

export let pool = createPool(DATABASE_URL);

export async function reconfigureDatabase(connectionString: string): Promise<void> {
  if (connectionString === DATABASE_URL) return;
  const previous = pool;
  DATABASE_URL = connectionString;
  pool = createPool(connectionString);
  await previous.end().catch(() => undefined);
}
