/**
 * 협업(WebSocket) 서버 주소.
 * - VITE_COLLABORATION_URL 이 있으면 그대로 쓴다.
 * - 그 외에는 API 서버 주소의 /collab 경로로 붙는다. API 서버가 협업 서버로 넘겨 주므로
 *   개발(:4000), LAN 직접 접속, 리버스 프록시 뒤 운영(https://…) 모두 같은 규칙이다.
 */
export const COLLABORATION_PATH = "/collab";

export function resolveCollaborationWsUrl(serverHost: string): string {
  const configured = import.meta.env?.VITE_COLLABORATION_URL;
  if (configured) return configured;
  let parsed: URL;
  try {
    parsed = new URL(serverHost);
  } catch {
    parsed = new URL(window.location.origin);
  }
  const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const basePath = parsed.pathname.replace(/\/+$/, "");
  return `${protocol}//${parsed.host}${basePath}${COLLABORATION_PATH}`;
}
