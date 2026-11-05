import { Database } from "@hocuspocus/extension-database";
import { Redis } from "@hocuspocus/extension-redis";
import { Server } from "@hocuspocus/server";
import type { PoolClient } from "pg";
import { canEditContent, ensureSchema, getUserBySessionToken, pool } from "./db.js";
import { PAGE_STRUCTURE_CHANGED_CHANNEL } from "./collaboration-page-structure.js";
import { syncCollaborationPageReferences } from "./collaboration-page-sync.js";
import {
  assertCollaborationDocumentExists,
  loadCollaborationState,
  storeCollaborationState,
} from "./collaboration-store.js";
import { collaborationConfig } from "./collaboration-config.js";

function createRedisExtension(redisUrl: string): Redis {
  const parsed = new URL(redisUrl);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }

  const database = parsed.pathname.replace(/^\//, "");
  return new Redis({
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    identifier: collaborationConfig.instanceName,
    prefix: collaborationConfig.redisPrefix,
    options: {
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      db: database ? Number(database) : undefined,
      tls: parsed.protocol === "rediss:" ? {} : undefined,
    },
  });
}

async function bootstrap() {
  await ensureSchema();

  const extensions = [];
  if (collaborationConfig.redisUrl) {
    extensions.push(createRedisExtension(collaborationConfig.redisUrl));
  }
  extensions.push(
    new Database({
      fetch: ({ documentName }) => loadCollaborationState(documentName),
      store: ({ documentName, state }) =>
        storeCollaborationState(documentName, state),
    }),
  );

  const server = new Server({
    name: collaborationConfig.instanceName,
    port: collaborationConfig.port,
    address: collaborationConfig.host,
    timeout: 60_000,
    extensions,
    debounce: collaborationConfig.debounce,
    maxDebounce: collaborationConfig.maxDebounce,
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const user = token ? await getUserBySessionToken(token) : null;
      if (!user) {
        throw new Error("Unauthorized: 유효한 로그인 세션 토큰이 필요합니다.");
      }
      // 읽기 전용 계정은 문서를 받아 보기만 하고, 보내는 변경은 서버가 무시한다.
      if (!canEditContent(user.role)) connectionConfig.readOnly = true;
      // 로그인한 사용자는 모든 페이지를 함께 편집할 수 있다 (REST 와 같은 기준).
      const { pageId } = await assertCollaborationDocumentExists(documentName);
      return {
        user,
        pageId,
      };
    },
    async afterLoadDocument({ document, documentName }) {
      const pageId = documentName.startsWith("page:") ? documentName.slice(5) : null;
      if (pageId) await syncCollaborationPageReferences(document, pageId);
    },
  });

  let notificationClient: PoolClient | null = null;
  let notificationRetry: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;
  const pendingPages = new Set<string>();
  let processing = false;

  const processNotifications = async () => {
    if (processing) return;
    processing = true;
    try {
      while (pendingPages.size > 0 && !shuttingDown) {
        const pageId = pendingPages.values().next().value as string;
        pendingPages.delete(pageId);
        // 별도 협업 인스턴스가 같은 DB를 보더라도, 이 인스턴스에 열린 문서만 수정한다.
        // 닫힌 문서는 afterLoadDocument에서 정리한다. 여기서 열면 오래된 스냅샷이
        // 다른 인스턴스의 아직 저장되지 않은 실시간 편집을 덮을 수 있다.
        if (!server.hocuspocus.documents.has(`page:${pageId}`)) continue;
        let connection: Awaited<ReturnType<typeof server.hocuspocus.openDirectConnection>> | null = null;
        try {
          connection = await server.hocuspocus.openDirectConnection(`page:${pageId}`);
          if (connection.document) {
            await syncCollaborationPageReferences(connection.document, pageId);
          }
        } catch (error) {
          console.error(`[Collaboration] Failed to sync page references for ${pageId}`, error);
        } finally {
          await connection?.disconnect().catch((error) => {
            console.error(`[Collaboration] Failed to store page ${pageId}`, error);
          });
        }
      }
    } finally {
      processing = false;
    }
  };

  const connectNotificationListener = async () => {
    if (shuttingDown) return;
    let client: PoolClient | null = null;
    let released = false;
    const release = () => {
      if (released || !client) return;
      released = true;
      if (notificationClient === client) notificationClient = null;
      client.release(true);
    };
    const reconnect = () => {
      release();
      if (shuttingDown || notificationRetry) return;
      notificationRetry = setTimeout(() => {
        notificationRetry = undefined;
        void connectNotificationListener();
      }, 2000);
    };
    try {
      client = await pool.connect();
      if (shuttingDown) {
        release();
        return;
      }
      notificationClient = client;
      client.on("notification", (message) => {
        const pageId = message.payload;
        if (!pageId || !/^[a-zA-Z0-9_-]+$/.test(pageId)) return;
        pendingPages.add(pageId);
        void processNotifications();
      });
      client.on("error", (error) => {
        console.error("[Collaboration] Page change listener disconnected", error);
        reconnect();
      });
      client.on("end", reconnect);
      await client.query(`LISTEN ${PAGE_STRUCTURE_CHANGED_CHANNEL}`);
    } catch (error) {
      console.error("[Collaboration] Failed to listen for page changes", error);
      reconnect();
    }
  };

  const shutdown = async (signal: string) => {
    shuttingDown = true;
    clearTimeout(notificationRetry);
    notificationClient?.release();
    console.log(`[Collaboration] ${signal}; flushing documents and shutting down`);
    await server.destroy();
    await pool.end();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await server.listen();
  await connectNotificationListener();
  console.log(
    `[Collaboration] ${collaborationConfig.instanceName} listening on ws://${collaborationConfig.host}:${collaborationConfig.port} (${collaborationConfig.mode})`,
  );
}

bootstrap().catch(async (error) => {
  console.error("[Collaboration] Failed to start", error);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
