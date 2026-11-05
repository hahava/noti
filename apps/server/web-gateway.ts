import { readFile, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/**
 * 메인 API 가 한 포트에서 함께 맡는 것들.
 * - /collab* WebSocket → 협업 서버(127.0.0.1:COLLAB_PORT)로 그대로 넘긴다. (개발·운영 공통)
 * - NOTY_WEB_DIST 가 있으면(운영 이미지) 빌드된 웹 화면을 제공한다. 개발에서는 Vite 가 맡는다.
 */

export const COLLAB_PATH = "/collab";
const COLLAB_UPSTREAM_HOST = process.env.COLLAB_UPSTREAM_HOST || "127.0.0.1";
const COLLAB_UPSTREAM_PORT = Number(process.env.COLLAB_PORT || 4001);
const WEB_DIST = process.env.NOTY_WEB_DIST ? path.resolve(process.env.NOTY_WEB_DIST) : null;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function isCollabPath(pathname: string): boolean {
  return pathname === COLLAB_PATH || pathname.startsWith(`${COLLAB_PATH}/`) || pathname.startsWith(`${COLLAB_PATH}?`);
}

/** /collab 업그레이드 요청을 협업 서버로 TCP 째로 넘긴다. */
export function attachCollaborationProxy(server: Server): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url || "/";
    const pathname = url.split("?")[0];
    if (!isCollabPath(pathname)) {
      socket.destroy();
      return;
    }
    const upstreamPath = url.slice(COLLAB_PATH.length) || "/";
    const upstream = net.connect(COLLAB_UPSTREAM_PORT, COLLAB_UPSTREAM_HOST, () => {
      const headerLines: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${req.method} ${upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`} HTTP/${req.httpVersion}\r\n${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", (error) => {
      console.error("[collab proxy] 협업 서버에 연결하지 못했습니다:", error.message);
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      close();
    });
    socket.on("error", close);
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
}

/** 운영에서 웹 화면 파일을 보낸다. 처리했으면 true. */
export async function serveWebApp(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!WEB_DIST || (req.method !== "GET" && req.method !== "HEAD")) return false;
  if (pathname.startsWith("/api/") || pathname.startsWith("/uploads/") || isCollabPath(pathname)) return false;

  let relative: string;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return false;
  }
  let filePath = path.resolve(WEB_DIST, relative || "index.html");
  if (!filePath.startsWith(WEB_DIST + path.sep) && filePath !== WEB_DIST) return false;

  const isFile = await stat(filePath).then((s) => s.isFile()).catch(() => false);
  if (!isFile) {
    // 확장자가 있는 경로(없는 정적 파일)는 404, 나머지는 화면 경로라 index.html 을 준다.
    if (path.extname(relative)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return true;
    }
    filePath = path.join(WEB_DIST, "index.html");
  }
  const body = await readFile(filePath);
  const isAsset = relative.startsWith("assets/");
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
