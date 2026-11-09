import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * 북마크 블록용 링크 정보 (제목·설명·대표 이미지·사이트 아이콘).
 *
 * 서버가 사용자가 준 주소에 접속하므로 내부망을 찌르는 데 쓰이지 않게 막는다 (SSRF):
 *  - http(s) 와 기본 포트(80·443)만, 사용자 이름·비밀번호가 든 주소는 거절
 *  - 접속하는 순간 실제 IP 를 확인해 사설·루프백·링크 로컬 등 내부 주소면 거절 (DNS 를 바꿔치는 공격도 막힌다)
 *  - 리디렉션은 3번까지, 매번 같은 검사를 다시 한다
 *  - 5초 시간 제한, HTML 만, 최대 512KB 까지만 읽는다
 */

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string;
  icon: string;
  siteName: string;
}

export class LinkPreviewError extends Error {}

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

/** 내부망·특수 용도 주소인지 */
export function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // 링크 로컬 (클라우드 메타데이터 포함)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // 멀티캐스트·예약
    );
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") || // 고유 로컬
      /^fe[89ab]/.test(lower) || // 링크 로컬
      lower.startsWith("ff") // 멀티캐스트
    );
  }
  return true;
}

/** 접속할 때 쓰는 DNS 조회: 내부 주소가 하나라도 나오면 거절한다 */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const list = addresses as dns.LookupAddress[];
    const blocked = list.find((entry) => isBlockedAddress(entry.address));
    if (blocked || list.length === 0) {
      return callback(new LinkPreviewError("내부 네트워크 주소는 가져올 수 없습니다."), "", 0);
    }
    if ((options as dns.LookupOptions).all) return (callback as any)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LinkPreviewError("주소 형식이 올바르지 않습니다.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new LinkPreviewError("http(s) 주소만 가져올 수 있습니다.");
  if (url.username || url.password) throw new LinkPreviewError("계정 정보가 든 주소는 가져올 수 없습니다.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new LinkPreviewError("기본 포트(80·443) 주소만 가져올 수 있습니다.");
  // IP 를 직접 쓴 주소도 같은 기준으로 막는다 (lookup 을 거치지 않으므로)
  const bareHost = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bareHost) && isBlockedAddress(bareHost)) throw new LinkPreviewError("내부 네트워크 주소는 가져올 수 없습니다.");
  return url;
}

function fetchOnce(url: URL): Promise<{ status: number; location?: string; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(
      url,
      {
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: { "User-Agent": "NotyLinkPreview/1.0", Accept: "text/html,application/xhtml+xml" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, location: res.headers.location, contentType, body: Buffer.alloc(0) });
        }
        if (!/text\/html|application\/xhtml/i.test(contentType)) {
          res.resume();
          return resolve({ status, contentType, body: Buffer.alloc(0) });
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BYTES) {
            // 앞부분(<head>)만 있으면 충분하다
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (total - MAX_BYTES))));
            res.destroy();
            return resolve({ status, contentType, body: Buffer.concat(chunks) });
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new LinkPreviewError("사이트가 시간 안에 응답하지 않았습니다.")));
    req.on("error", reject);
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

const clean = (text: string | undefined, max: number) => decodeEntities(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** HTML 에서 링크 정보를 뽑는다 (Open Graph → 일반 meta → <title> 순) */
export function parseLinkPreview(html: string, pageUrl: string): LinkPreview {
  const head = html.slice(0, MAX_BYTES);
  const metas = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    const key = attr("property") ?? attr("name");
    const content = attr("content");
    if (!key || !content) continue;
    const k = (key[2] ?? key[3] ?? key[4] ?? "").toLowerCase();
    if (k && !metas.has(k)) metas.set(k, content[2] ?? content[3] ?? content[4] ?? "");
  }
  const absolute = (value: string | undefined) => {
    if (!value) return "";
    try {
      const resolved = new URL(decodeEntities(value.trim()), pageUrl);
      return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : "";
    } catch {
      return "";
    }
  };
  let icon = "";
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    if (/\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag)) {
      const href = tag.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (href) {
        icon = absolute(href[2] ?? href[3] ?? href[4]);
        if (icon) break;
      }
    }
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const host = new URL(pageUrl).hostname.replace(/^www\./, "");
  return {
    url: pageUrl,
    title: clean(metas.get("og:title") ?? metas.get("twitter:title") ?? titleTag, 300) || host,
    description: clean(metas.get("og:description") ?? metas.get("twitter:description") ?? metas.get("description"), 500),
    image: absolute(metas.get("og:image") ?? metas.get("og:image:url") ?? metas.get("twitter:image")),
    icon: icon || absolute("/favicon.ico"),
    siteName: clean(metas.get("og:site_name"), 100) || host,
  };
}

function decodeBody(body: Buffer, contentType: string): string {
  const fromHeader = contentType.match(/charset=([\w-]+)/i)?.[1];
  const fromMeta = body.subarray(0, 2048).toString("latin1").match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  const charset = (fromHeader || fromMeta || "utf-8").toLowerCase();
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return body.toString("utf8");
  }
}

export async function fetchLinkPreview(raw: string): Promise<LinkPreview> {
  let url = validateUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetchOnce(url);
    if (res.location) {
      url = validateUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status >= 400) throw new LinkPreviewError(`사이트가 오류로 응답했습니다 (${res.status}).`);
    if (res.body.length === 0) {
      // HTML 이 아닌 주소 (파일·이미지 등): 주소만으로 카드를 만든다
      const host = url.hostname.replace(/^www\./, "");
      return { url: url.toString(), title: decodeURIComponent(url.pathname.split("/").pop() || host), description: "", image: "", icon: "", siteName: host };
    }
    return parseLinkPreview(decodeBody(res.body, res.contentType), url.toString());
  }
  throw new LinkPreviewError("리디렉션이 너무 많습니다.");
}
