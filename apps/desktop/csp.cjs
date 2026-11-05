/**
 * 빌드된 화면(file://)에 붙이는 Content-Security-Policy.
 * - 스크립트는 앱에 들어 있는 파일만 실행한다 (인라인·eval 금지).
 * - 서버 주소는 사용자가 로그인 화면에서 고르므로 http(s)/ws(s) 연결은 열어 둔다.
 * - 개발 서버(Vite) 화면은 인라인 스크립트를 쓰므로 붙이지 않는다 (file: 만 대상).
 */
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https: app-asset:",
  "media-src 'self' blob: http: https: app-asset:",
  "font-src 'self' data:",
  "connect-src 'self' http: https: ws: wss: app-asset:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

function applyRendererCsp(targetSession) {
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith("file:")) return callback({ responseHeaders: details.responseHeaders });
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [RENDERER_CSP] } });
  });
}

module.exports = { RENDERER_CSP, applyRendererCsp };
