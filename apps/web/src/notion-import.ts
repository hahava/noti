import JSZip from "jszip";
import { MULTI_VALUE_SEPARATOR, createDefaultCollectionData } from "@noty/shared/collection-schema";
import type { CollectionData, CollectionProperty, CollectionRow } from "@noty/shared/collection-types";

/**
 * Notion 내보내기(ZIP, "Markdown & CSV") 가져오기.
 *
 * 브라우저에서 ZIP 을 풀고, 이미 있는 API(페이지 만들기·본문 저장·첨부 올리기·데이터베이스)로 넣는다.
 * 모두 새로 만드는 페이지라 협업(Yjs) 상태가 없고, 처음 여는 사람이 저장된 본문으로 Yjs 를 시드한다.
 *
 * 구조 (Notion 내보내기 형식)
 *   "제목 <32자리 id>.md"         페이지. 같은 이름의 폴더에 하위 페이지·첨부가 들어 있다.
 *   "DB <id>.csv" / "_all.csv"    데이터베이스 (_all 이 모든 행). 같은 이름 폴더의 .md 가 행 페이지.
 *   ZIP 안에 ZIP 이 또 들어 있을 수 있다 (큰 내보내기는 Part-1.zip … 으로 나뉜다).
 *
 * 변환
 *   - 가져온 것은 모두 "Notion 가져오기 (날짜)" 페이지 아래에 둔다 (한 번에 지우거나 옮기기 쉽게).
 *   - 데이터베이스마다 페이지를 하나 만들고 그 안에 데이터베이스 블록을 둔다. 행 페이지는 그 페이지 아래로.
 *   - 페이지끼리의 링크는 Noty 페이지 링크로, 링크만 있는 줄은 하위 페이지 블록으로 바꾼다.
 *   - 이미지·첨부는 Noty 첨부로 올린다. <aside> 는 콜아웃으로.
 */

export interface NotionImportDeps {
  /** 마크다운 → BlockNote 블록 (앱의 블록 스키마로) */
  parseMarkdown: (markdown: string) => any[];
  createPage: (parentId: string | null, title: string) => Promise<string>;
  saveBlocks: (pageId: string, blocks: unknown[], title: string) => Promise<void>;
  uploadFile: (name: string, type: string, bytes: Uint8Array) => Promise<string>;
  ensureCollection: (id: string, ownerPageId: string, data: CollectionData) => Promise<void>;
  onProgress: (progress: NotionImportProgress) => void;
  /** true 를 돌려주면 다음 단계에서 멈춘다 */
  isCancelled?: () => boolean;
}

export interface NotionImportProgress {
  phase: "unzip" | "pages" | "content" | "done";
  done: number;
  total: number;
  current?: string;
}

export interface NotionImportReport {
  rootPageId: string;
  pages: number;
  databases: number;
  rows: number;
  files: number;
  warnings: string[];
  cancelled: boolean;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 서버 요청 한도(30MB, base64 로 커진다) 안쪽
const ID_SUFFIX = /^(.*?)\s*([0-9a-f]{32})$/i;

/* ------------------------------------------------------------------ 경로·이름 */

export const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const stripExt = (path: string) => path.replace(/\.[^./]+$/, "");

/** "제목 1234…(32자리).md" → "제목" */
export function titleFromFileName(path: string): string {
  const name = stripExt(basename(path)).replace(/_all$/, "");
  const match = name.match(ID_SUFFIX);
  return (match ? match[1] : name).trim() || "제목 없음";
}

/** 마크다운 안 상대 주소 → ZIP 안 경로 (../ 와 %20 처리) */
export function resolveRelative(fromFile: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split("#")[0].split("?")[0]);
  } catch {
    decoded = href;
  }
  const parts = (dirname(fromFile) ? dirname(fromFile).split("/") : []).concat(decoded.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/* ------------------------------------------------------------------ CSV */

/** RFC 4180 CSV (따옴표 안 쉼표·줄바꿈·"" 처리, BOM 제거) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Notion 날짜("November 9, 2026", "2026/11/09", "2026-11-09 …", 범위는 앞쪽) → YYYY-MM-DD, 아니면 null */
export function toIsoDate(value: string): string | null {
  const v = value.split("→")[0].trim();
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = v.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (m) {
    const month = MONTHS.findIndex((name) => name.startsWith(m![1].toLowerCase()) && m![1].length >= 3);
    if (month >= 0) return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  m = v.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return null;
}

/** 관계(relation) 칸: "행 제목 (행%20제목%20id.md), …" → "행 제목, …" */
const cleanRelation = (value: string) => value.replace(/\s*\([^)]*\.md\)/g, "");

export function inferColumnType(values: string[]): CollectionProperty["type"] {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (filled.length === 0) return "text";
  if (filled.every((v) => v === "Yes" || v === "No")) return "checkbox";
  if (filled.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return "number";
  if (filled.every((v) => toIsoDate(v))) return "date";
  if (filled.every((v) => /^https?:\/\/\S+$/i.test(v))) return "url";
  if (filled.every((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return "email";
  if (filled.some((v) => /\.md\)/.test(v))) return "text";
  const avgLength = filled.reduce((sum, v) => sum + v.length, 0) / filled.length;
  if (avgLength > 40) return "text";
  const tokens = filled.flatMap((v) => v.split(", ").map((t) => t.trim()).filter(Boolean));
  const distinctTokens = new Set(tokens).size;
  const limit = Math.max(8, Math.ceil(filled.length * 0.5));
  if (filled.some((v) => v.includes(", ")) && distinctTokens <= Math.max(limit, 12) && distinctTokens < tokens.length) return "multi_select";
  if (new Set(filled).size <= limit && new Set(filled).size < filled.length) return "select";
  return "text";
}

/** CSV → Noty 데이터베이스. 첫 칸이 제목(Notion 의 Name). rowPageIds: 행 제목 → 행 페이지 id 목록 */
export function csvToCollection(
  title: string,
  csv: string[][],
  collectionId: string,
  rowPageIds: Map<string, string[]>,
): CollectionData {
  const [header = ["Name"], ...body] = csv;
  const data = createDefaultCollectionData(title);
  data.collectionId = collectionId;
  const properties: CollectionProperty[] = header.slice(1).map((name, index) => {
    const column = body.map((row) => cleanRelation(row[index + 1] ?? ""));
    const type = inferColumnType(column);
    const property: CollectionProperty = { id: `prop-${index + 1}`, name: name.trim() || `속성 ${index + 1}`, type };
    if (type === "select") property.options = [...new Set(column.map((v) => v.trim()).filter(Boolean))];
    if (type === "multi_select") property.options = [...new Set(column.flatMap((v) => v.split(", ").map((t) => t.trim())).filter(Boolean))];
    return property;
  });
  const used = new Map<string, number>();
  const rows: CollectionRow[] = body.map((row, rowIndex) => {
    const rowTitle = (row[0] ?? "").trim();
    const candidates = rowPageIds.get(rowTitle) ?? [];
    const nth = used.get(rowTitle) ?? 0;
    used.set(rowTitle, nth + 1);
    const values: Record<string, string | boolean> = {};
    properties.forEach((property, index) => {
      const raw = cleanRelation(row[index + 1] ?? "").trim();
      if (!raw) return;
      if (property.type === "checkbox") values[property.id] = raw === "Yes";
      else if (property.type === "date") values[property.id] = toIsoDate(raw) ?? raw;
      else if (property.type === "multi_select") values[property.id] = raw.split(", ").map((t) => t.trim()).filter(Boolean).join(MULTI_VALUE_SEPARATOR);
      else values[property.id] = raw;
    });
    return {
      id: `row-${rowIndex + 1}`,
      title: rowTitle,
      ...(candidates[nth] ? { linkedPageId: candidates[nth] } : {}),
      values,
    };
  });
  return { ...data, properties, rows };
}

/* ------------------------------------------------------------------ 마크다운 전처리 */

/** 행 페이지 맨 위의 "속성: 값" 줄(CSV 와 중복)을 뺀다 */
export function stripPropertyLines(markdown: string, propertyNames: readonly string[]): string {
  if (propertyNames.length === 0) return markdown;
  const lines = markdown.split("\n");
  let i = lines[0]?.startsWith("# ") ? 1 : 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  const start = i;
  while (i < lines.length && propertyNames.some((name) => lines[i].startsWith(`${name}: `) || lines[i] === `${name}:`)) i += 1;
  return i > start ? [...lines.slice(0, start), ...lines.slice(i)].join("\n") : markdown;
}

/** <aside> … </aside> (Notion 콜아웃) → 표시 문단. 나중에 콜아웃 블록으로 바꾼다 */
export function extractAsides(markdown: string): { markdown: string; asides: string[] } {
  const asides: string[] = [];
  const out = markdown.replace(/<aside>([\s\S]*?)<\/aside>/g, (_all, inner: string) => {
    asides.push(inner.trim());
    return `\n\nNOTYASIDE${asides.length - 1}\n\n`;
  });
  return { markdown: out, asides };
}

/** Notion 콜아웃은 아이콘(이모지)을 글 앞에 둔다 → Noty 콜아웃 종류로 바꾸고 글에서는 뺀다 */
const CALLOUT_BY_EMOJI: Record<string, string> = { "💡": "info", "ℹ️": "info", "⚠️": "warning", "⚠": "warning", "🚨": "danger", "❗": "danger", "❌": "danger", "✅": "tip", "👍": "tip", "📝": "note", "📌": "note", "✨": "idea", "🔥": "idea" };
export function calloutFromAside(text: string): { variant: string; text: string } {
  const match = text.match(/^(\p{Extended_Pictographic}\uFE0F?)\s*/u);
  if (!match) return { variant: "info", text };
  return { variant: CALLOUT_BY_EMOJI[match[1]] ?? "info", text: text.slice(match[0].length) };
}

/* ------------------------------------------------------------------ 가져오기 */

interface Entry {
  path: string;
  file: JSZip.JSZipObject;
}

async function readZip(source: Blob | Uint8Array, depth = 0): Promise<Entry[]> {
  const zip = await JSZip.loadAsync(source);
  const entries: Entry[] = [];
  for (const file of Object.values(zip.files)) {
    if (file.dir || basename(file.name).startsWith(".") || file.name.startsWith("__MACOSX/")) continue;
    if (/\.zip$/i.test(file.name) && depth < 2) {
      entries.push(...(await readZip(await file.async("uint8array"), depth + 1)));
    } else {
      entries.push({ path: file.name.normalize("NFC"), file });
    }
  }
  return entries;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

type Item =
  | { kind: "page"; key: string; title: string; parentKey: string | null; mdPath: string; rowOf?: string }
  | { kind: "database"; key: string; title: string; parentKey: string | null; csvPath: string };

const newCollectionId = () => `collection-import-${(crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/-/g, "").slice(0, 16)}`;

export async function importNotionZip(source: Blob, rootTitle: string, deps: NotionImportDeps): Promise<NotionImportReport> {
  const warnings: string[] = [];
  deps.onProgress({ phase: "unzip", done: 0, total: 1 });
  const entries = await readZip(source);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const mdPaths = entries.filter((e) => /\.md$/i.test(e.path)).map((e) => e.path);
  if (mdPaths.length === 0 && !entries.some((e) => /\.csv$/i.test(e.path))) {
    throw new Error("Notion 내보내기 파일이 아닙니다. Notion 에서 '마크다운 & CSV' 형식으로 내보낸 ZIP 을 올려 주세요.");
  }

  // 데이터베이스: 같은 이름의 _all.csv 가 있으면 그쪽(모든 행)을 쓴다
  const dbByFolder = new Map<string, string>(); // 행 페이지 폴더 → csv 경로
  for (const entry of entries) {
    if (!/\.csv$/i.test(entry.path)) continue;
    const folder = entry.path.replace(/(_all)?\.csv$/i, "");
    if (!dbByFolder.has(folder) || /_all\.csv$/i.test(entry.path)) dbByFolder.set(folder, entry.path);
  }

  const pageKeyForFolder = (folder: string): string | null => {
    if (!folder) return null;
    if (byPath.has(`${folder}.md`)) return `${folder}.md`;
    if (dbByFolder.has(folder)) return `db:${folder}`;
    return pageKeyForFolder(dirname(folder)); // 중간 폴더만 있는 경우 (드묾) 더 위로
  };

  const items: Item[] = [];
  for (const [folder, csvPath] of dbByFolder) {
    items.push({ kind: "database", key: `db:${folder}`, title: titleFromFileName(csvPath), parentKey: pageKeyForFolder(dirname(folder)), csvPath });
  }
  for (const mdPath of mdPaths) {
    const folder = dirname(mdPath);
    const rowOf = dbByFolder.has(folder) ? `db:${folder}` : undefined;
    items.push({ kind: "page", key: mdPath, title: titleFromFileName(mdPath), parentKey: pageKeyForFolder(folder), mdPath, rowOf });
  }
  // 부모가 먼저 만들어지도록 경로 깊이 순으로
  const depth = (item: Item) => (item.kind === "page" ? item.mdPath : item.csvPath).split("/").length + (item.kind === "page" && item.rowOf ? 0.5 : 0);
  items.sort((a, b) => depth(a) - depth(b));

  /* 1. 페이지 만들기 */
  const total = items.length;
  const rootPageId = await deps.createPage(null, rootTitle);
  const idByKey = new Map<string, string>();
  const report: NotionImportReport = { rootPageId, pages: 0, databases: 0, rows: 0, files: 0, warnings, cancelled: false };
  let done = 0;
  for (const item of items) {
    if (deps.isCancelled?.()) return { ...report, cancelled: true };
    deps.onProgress({ phase: "pages", done, total, current: item.title });
    const parentId = (item.parentKey && idByKey.get(item.parentKey)) || rootPageId;
    idByKey.set(item.key, await deps.createPage(parentId, item.title));
    done += 1;
  }

  const childrenOf = new Map<string, string[]>(); // 부모 key → 자식 key (만든 순서)
  for (const item of items) {
    const parent = item.parentKey && idByKey.has(item.parentKey) ? item.parentKey : "root";
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), item.key]);
  }

  /* 2. 본문 변환·저장 */
  const uploaded = new Map<string, string>();
  const upload = async (path: string): Promise<string | null> => {
    if (uploaded.has(path)) return uploaded.get(path)!;
    const entry = byPath.get(path);
    if (!entry) return null;
    const bytes = await entry.file.async("uint8array");
    if (bytes.length > MAX_UPLOAD_BYTES) {
      warnings.push(`첨부가 너무 커서 건너뜀 (${Math.round(bytes.length / 1024 / 1024)}MB): ${path}`);
      return null;
    }
    try {
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const url = await deps.uploadFile(basename(path), MIME[ext] ?? "application/octet-stream", bytes);
      uploaded.set(path, url);
      report.files += 1;
      return url;
    } catch (error) {
      warnings.push(`첨부를 올리지 못함: ${path} (${error instanceof Error ? error.message : error})`);
      return null;
    }
  };

  const itemByKey = new Map(items.map((item) => [item.key, item]));
  /** ZIP 안 경로 → 그 경로가 가리키는 항목 key (페이지 .md 또는 데이터베이스 .csv) */
  const keyForTarget = (path: string): string | null => {
    if (itemByKey.has(path)) return path;
    if (/\.csv$/i.test(path)) {
      const folder = path.replace(/(_all)?\.csv$/i, "");
      return itemByKey.has(`db:${folder}`) ? `db:${folder}` : null;
    }
    return null;
  };

  const csvHeaders = new Map<string, string[]>(); // db key → 헤더 (행 페이지 속성 줄 지우기용)
  const csvRows = new Map<string, string[][]>();
  for (const item of items) {
    if (item.kind !== "database") continue;
    const rows = parseCsv(await byPath.get(item.csvPath)!.file.async("string"));
    csvRows.set(item.key, rows);
    csvHeaders.set(item.key, rows[0] ?? []);
  }

  const inlineText = (content: any): string =>
    Array.isArray(content) ? content.map((c: any) => (typeof c === "string" ? c : c?.text ?? inlineText(c?.content))).join("") : typeof content === "string" ? content : "";

  done = 0;
  for (const item of items) {
    if (deps.isCancelled?.()) return { ...report, cancelled: true };
    deps.onProgress({ phase: "content", done, total, current: item.title });
    const pageId = idByKey.get(item.key)!;
    const myChildren = childrenOf.get(item.key) ?? [];
    const placed = new Set<string>();
    let blocks: any[] = [];

    if (item.kind === "page") {
      let markdown = await byPath.get(item.mdPath)!.file.async("string");
      if (item.rowOf) markdown = stripPropertyLines(markdown, (csvHeaders.get(item.rowOf) ?? []).slice(1));
      const { markdown: withMarkers, asides } = extractAsides(markdown);
      let parsed: any[] = [];
      try {
        parsed = deps.parseMarkdown(withMarkers);
      } catch (error) {
        warnings.push(`본문을 변환하지 못해 글자로 넣음: ${item.mdPath}`);
        parsed = [{ type: "paragraph", content: markdown.slice(0, 20000) }];
      }

      const convertInline = async (content: any): Promise<any> => {
        if (!Array.isArray(content)) return content;
        const out: any[] = [];
        for (const piece of content) {
          if (piece?.type === "link" && typeof piece.href === "string") {
            const target = resolveRelative(item.mdPath, piece.href);
            const key = target ? keyForTarget(target) : null;
            if (key && idByKey.has(key)) {
              out.push({ type: "pageLink", props: { pageId: idByKey.get(key) } });
              continue;
            }
            if (target && byPath.has(target)) {
              const url = await upload(target);
              out.push(url ? { ...piece, href: url } : { type: "text", text: inlineText(piece.content), styles: {} });
              continue;
            }
          }
          out.push(piece);
        }
        return out;
      };

      const convertBlocks = async (list: any[]): Promise<any[]> => {
        const out: any[] = [];
        for (const block of list) {
          const { id: _id, ...rest } = block;
          const text = inlineText(rest.content).trim();
          // <aside> 자리 → 콜아웃
          const aside = text.match(/^NOTYASIDE(\d+)$/);
          if (rest.type === "paragraph" && aside) {
            const { variant, text: inner } = calloutFromAside(asides[Number(aside[1])] ?? "");
            const innerBlocks = deps.parseMarkdown(inner);
            out.push({ type: "callout", props: { variant }, content: await convertInline(innerBlocks[0]?.content ?? inner) });
            const extra = await convertBlocks(innerBlocks.slice(1));
            out.push(...extra);
            continue;
          }
          // 링크 하나만 있는 줄: 하위 페이지·데이터베이스면 페이지 블록으로
          const links = Array.isArray(rest.content) ? rest.content.filter((c: any) => !(c?.type === "text" && !c.text.trim())) : [];
          if (rest.type === "paragraph" && links.length === 1 && links[0]?.type === "link") {
            const target = resolveRelative(item.mdPath, links[0].href);
            const key = target ? keyForTarget(target) : null;
            if (key && myChildren.includes(key) && !placed.has(key)) {
              placed.add(key);
              out.push({ type: "page", props: { pageId: idByKey.get(key) } });
              continue;
            }
          }
          // 이미지·파일: ZIP 안 파일이면 올린다
          if (["image", "file", "video", "audio"].includes(rest.type) && typeof rest.props?.url === "string") {
            const target = resolveRelative(item.mdPath, rest.props.url);
            if (target) {
              const url = byPath.has(target) ? await upload(target) : null;
              if (url) out.push({ ...rest, props: { ...rest.props, url } });
              else warnings.push(`찾을 수 없는 첨부: ${target} (${item.title})`);
              continue;
            }
          }
          const next: any = { ...rest };
          if (Array.isArray(rest.content)) next.content = await convertInline(rest.content);
          if (Array.isArray(rest.children) && rest.children.length) next.children = await convertBlocks(rest.children);
          out.push(next);
        }
        return out;
      };
      blocks = await convertBlocks(parsed);
    } else {
      /* 데이터베이스 페이지: 데이터베이스 블록 + 행 페이지는 아래 (자식) */
      const rowPageIds = new Map<string, string[]>();
      for (const childKey of myChildren) {
        const child = itemByKey.get(childKey);
        if (child?.kind === "page" && child.rowOf === item.key) {
          rowPageIds.set(child.title, [...(rowPageIds.get(child.title) ?? []), idByKey.get(childKey)!]);
        }
      }
      const data = csvToCollection(item.title, csvRows.get(item.key) ?? [], newCollectionId(), rowPageIds);
      // 행 페이지도 이 페이지의 하위 페이지라 서버가 본문 끝에 페이지 블록으로 둔다 (앱에서 만든 행 페이지와 같음)
      blocks = [
        { type: "heading", props: { level: 1 }, content: item.title },
        { type: "collection", props: { dataJson: JSON.stringify(data) } },
        ...myChildren.map((key) => ({ type: "page", props: { pageId: idByKey.get(key) } })),
      ];
      try {
        await deps.saveBlocks(pageId, blocks, item.title);
        await deps.ensureCollection(data.collectionId!, pageId, data);
      } catch (error) {
        warnings.push(`데이터베이스를 저장하지 못함: ${item.title} (${error instanceof Error ? error.message : error})`);
      }
      report.databases += 1;
      report.rows += data.rows.length;
      done += 1;
      continue;
    }

    // 첫 블록은 페이지 제목(H1)이어야 한다
    if (!(blocks[0]?.type === "heading" && blocks[0]?.props?.level === 1)) {
      blocks.unshift({ type: "heading", props: { level: 1 }, content: item.title });
    }
    // 본문에 링크가 없던 하위 페이지·데이터베이스는 끝에 붙인다
    for (const childKey of myChildren) {
      if (!placed.has(childKey)) blocks.push({ type: "page", props: { pageId: idByKey.get(childKey) } });
    }
    try {
      await deps.saveBlocks(pageId, blocks, item.title);
    } catch (error) {
      warnings.push(`페이지를 저장하지 못함: ${item.title} (${error instanceof Error ? error.message : error})`);
    }
    report.pages += 1;
    done += 1;
  }

  // 가져오기 페이지: 맨 위 항목들을 하위 페이지로 나열
  const topKeys = childrenOf.get("root") ?? [];
  await deps.saveBlocks(
    rootPageId,
    [
      { type: "heading", props: { level: 1 }, content: rootTitle },
      { type: "paragraph", content: `Notion 에서 가져온 페이지 ${report.pages}개, 데이터베이스 ${report.databases}개` },
      ...topKeys.map((key) => ({ type: "page", props: { pageId: idByKey.get(key) } })),
    ],
    rootTitle,
  );
  deps.onProgress({ phase: "done", done: total, total });
  return report;
}
