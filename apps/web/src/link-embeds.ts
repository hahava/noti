/**
 * 임베드할 수 있는 주소 → iframe 주소.
 * 허용 목록에 있는 사이트만 임베드하고, 나머지는 null (북마크로 보여 준다).
 * 사이트를 더하면 데스크톱 앱 CSP(apps/desktop/csp.cjs 의 frame-src)에도 넣어야 한다.
 */
export interface EmbedTarget {
  provider: string;
  src: string;
  /** 기본 높이(px) — 영상은 16:9 로 따로 맞춘다 */
  height: number;
  video?: boolean;
}

function parse(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

const host = (url: URL) => url.hostname.replace(/^www\./, "").replace(/^m\./, "");
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function toEmbed(raw: string): EmbedTarget | null {
  const url = parse(raw);
  if (!url) return null;
  const h = host(url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (h === "youtube.com" || h === "youtu.be" || h === "youtube-nocookie.com") {
    const id =
      h === "youtu.be" ? parts[0] : parts[0] === "watch" ? url.searchParams.get("v") : ["shorts", "embed", "live"].includes(parts[0]) ? parts[1] : null;
    if (!id || !SAFE_ID.test(id)) return null;
    const start = Number.parseInt(url.searchParams.get("t") ?? url.searchParams.get("start") ?? "", 10);
    return {
      provider: "YouTube",
      src: `https://www.youtube-nocookie.com/embed/${id}${Number.isFinite(start) && start > 0 ? `?start=${start}` : ""}`,
      height: 360,
      video: true,
    };
  }
  if (h === "vimeo.com" && parts[0] && /^\d+$/.test(parts[0])) {
    return { provider: "Vimeo", src: `https://player.vimeo.com/video/${parts[0]}`, height: 360, video: true };
  }
  if (h === "loom.com" && (parts[0] === "share" || parts[0] === "embed") && parts[1] && SAFE_ID.test(parts[1])) {
    return { provider: "Loom", src: `https://www.loom.com/embed/${parts[1]}`, height: 360, video: true };
  }
  if (h === "figma.com" && ["file", "design", "proto", "board", "slides"].includes(parts[0] ?? "")) {
    return { provider: "Figma", src: `https://www.figma.com/embed?embed_host=noty&url=${encodeURIComponent(url.toString())}`, height: 450 };
  }
  if (h === "docs.google.com" && ["document", "spreadsheets", "presentation", "forms"].includes(parts[0] ?? "") && parts[1] === "d" && parts[2]) {
    const id = parts[2];
    if (!SAFE_ID.test(id)) return null;
    const tail = parts[0] === "forms" ? "viewform?embedded=true" : parts[0] === "presentation" ? "embed" : "preview";
    return { provider: "Google 문서", src: `https://docs.google.com/${parts[0]}/d/${id}/${tail}`, height: 480 };
  }
  if ((h === "google.com" || h === "maps.google.com") && url.pathname.startsWith("/maps/embed")) {
    return { provider: "Google 지도", src: url.toString(), height: 400 };
  }
  if (h === "codepen.io" && parts[1] === "pen" && parts[0] && parts[2] && SAFE_ID.test(parts[0]) && SAFE_ID.test(parts[2])) {
    return { provider: "CodePen", src: `https://codepen.io/${parts[0]}/embed/${parts[2]}?default-tab=result`, height: 400 };
  }
  if (h === "open.spotify.com" && ["track", "album", "playlist", "episode", "show"].includes(parts[0] ?? "") && parts[1] && SAFE_ID.test(parts[1])) {
    return { provider: "Spotify", src: `https://open.spotify.com/embed/${parts[0]}/${parts[1]}`, height: parts[0] === "track" || parts[0] === "episode" ? 152 : 380 };
  }
  return null;
}

export const EMBED_PROVIDERS = ["YouTube", "Vimeo", "Loom", "Figma", "Google 문서·지도", "CodePen", "Spotify"];

/** http(s) 주소만 통과 (북마크 링크·이미지에 쓴다) */
export function safeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  return parse(raw)?.toString() ?? null;
}
