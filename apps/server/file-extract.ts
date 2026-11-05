import { createRequire } from "node:module";
import path from "node:path";

/**
 * 첨부파일 텍스트 추출.
 * 결과는 구간(segment) 배열로 돌려준다. 구간 라벨은 검색 결과에서 위치를 알려주는 데 쓴다.
 *   PDF → 쪽, PPTX → 슬라이드, XLSX → 시트, HWPX → 구역, 나머지 → 라벨 없음
 */

export interface ExtractedSegment {
  label: string | null;
  text: string;
}

export type ExtractResult =
  | { status: "done"; segments: ExtractedSegment[] }
  | { status: "empty"; message: string }
  | { status: "unsupported"; message: string };

/** 파일 하나에서 뽑는 텍스트 상한 (너무 큰 파일이 임베딩 큐를 독점하지 않도록) */
export const MAX_EXTRACTED_CHARS = 200_000;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml", ".xml", ".html", ".htm",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".kt", ".kts", ".go", ".rs", ".rb", ".php", ".cs",
  ".c", ".h", ".cpp", ".hpp", ".swift", ".scala", ".sql", ".sh", ".css", ".scss", ".ini", ".toml", ".conf",
]);

const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xlsm", ".xls", ".ods"]);

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** UTF-8 로 읽고, 깨진 글자가 많으면 한국어 레거시 인코딩(CP949/EUC-KR)으로 다시 읽는다. */
function decodeTextFile(buffer: Buffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  const broken = (utf8.match(/�/g) || []).length;
  if (broken > 0 && broken / Math.max(1, utf8.length) > 0.001) {
    try {
      return new TextDecoder("euc-kr").decode(buffer);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

/** <w:t>, <a:t>, <hp:t> 같은 텍스트 태그를 문단(<…:p>) 단위로 모은다. */
function extractXmlText(xml: string, textTag: string, paragraphTag: string): string {
  const paragraphs = xml.split(new RegExp(`</${paragraphTag}>`));
  const textPattern = new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>`, "g");
  return paragraphs
    .map((paragraph) => Array.from(paragraph.matchAll(textPattern), (m) => decodeXmlEntities(m[1])).join(""))
    .filter((line) => line.trim())
    .join("\n");
}

function numberedEntries(files: string[], pattern: RegExp): string[] {
  return files
    .map((name) => ({ name, match: name.match(pattern) }))
    .filter((item): item is { name: string; match: RegExpMatchArray } => Boolean(item.match))
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((item) => item.name);
}

/**
 * 한국어 PDF 는 대부분 CID 글꼴이라 문자 매핑(CMap) 파일이 있어야 한글이 추출된다.
 * unpdf 기본(serverless) 빌드에는 CMap 이 없어서 공식 pdfjs-dist 빌드와 그 CMap 을 쓴다.
 */
let pdfjsReady: Promise<void> | null = null;
function ensurePdfjs(): Promise<void> {
  pdfjsReady ??= (async () => {
    const { definePDFJSModule } = await import("unpdf");
    await definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs") as any);
  })();
  return pdfjsReady;
}

function pdfjsAssetDir(name: "cmaps" | "standard_fonts"): string {
  const pkg = createRequire(import.meta.url).resolve("pdfjs-dist/package.json");
  return `${path.join(path.dirname(pkg), name)}${path.sep}`;
}

async function extractPdf(buffer: Buffer): Promise<ExtractedSegment[]> {
  await ensurePdfjs();
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer), {
    cMapUrl: pdfjsAssetDir("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: pdfjsAssetDir("standard_fonts"),
    verbosity: 0,
  });
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((pageText, index) => ({ label: `${index + 1}쪽`, text: pageText }));
  } finally {
    // 문서와 워커 자원을 해제한다 (loadingTask.destroy 가 문서 전체를 정리함).
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

async function extractDocx(buffer: Buffer): Promise<ExtractedSegment[]> {
  const mammoth = await import("mammoth");
  const result = await (mammoth.default ?? mammoth).extractRawText({ buffer });
  return [{ label: null, text: result.value }];
}

async function extractSpreadsheet(buffer: Buffer): Promise<ExtractedSegment[]> {
  const XLSX = await import("xlsx");
  const lib = (XLSX as any).default ?? XLSX;
  const workbook = lib.read(buffer, { type: "buffer", cellDates: true, dense: true });
  return workbook.SheetNames.map((sheetName: string) => {
    // 빈 행은 빼고 셀을 " | " 로 이어서 행 단위 텍스트로 만든다. (CSV 따옴표 없이)
    const rows: unknown[][] = lib.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      blankrows: false,
      defval: "",
      raw: false,
    });
    const text = rows
      .map((row) => row.map((cell) => String(cell ?? "").trim()).join(" | ").replace(/( \| )+$/, ""))
      .filter((line) => line.replace(/[ |]/g, ""))
      .join("\n");
    return { label: `시트 ${sheetName}`, text };
  });
}

async function loadZip(buffer: Buffer) {
  const JSZip = (await import("jszip")).default;
  return JSZip.loadAsync(buffer);
}

async function extractPptx(buffer: Buffer): Promise<ExtractedSegment[]> {
  const zip = await loadZip(buffer);
  const slides = numberedEntries(Object.keys(zip.files), /^ppt\/slides\/slide(\d+)\.xml$/);
  const segments: ExtractedSegment[] = [];
  for (const [index, name] of slides.entries()) {
    const xml = await zip.file(name)!.async("string");
    let text = extractXmlText(xml, "a:t", "a:p");
    // 발표자 노트도 함께 넣는다.
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${name.match(/slide(\d+)\.xml$/)![1]}.xml`);
    if (notesFile) {
      const notes = extractXmlText(await notesFile.async("string"), "a:t", "a:p");
      if (notes.trim()) text += `\n[노트] ${notes}`;
    }
    segments.push({ label: `슬라이드 ${index + 1}`, text });
  }
  return segments;
}

async function extractHwpx(buffer: Buffer): Promise<ExtractedSegment[]> {
  const zip = await loadZip(buffer);
  const sections = numberedEntries(Object.keys(zip.files), /^Contents\/section(\d+)\.xml$/i);
  const segments: ExtractedSegment[] = [];
  for (const [index, name] of sections.entries()) {
    const xml = await zip.file(name)!.async("string");
    segments.push({ label: sections.length > 1 ? `구역 ${index + 1}` : null, text: extractXmlText(xml, "hp:t", "hp:p") });
  }
  return segments;
}

function extractHtml(text: string): string {
  return decodeXmlEntities(
    text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

/** 상한을 넘으면 뒤쪽 구간부터 잘라낸다. */
function capSegments(segments: ExtractedSegment[]): ExtractedSegment[] {
  const result: ExtractedSegment[] = [];
  let total = 0;
  for (const segment of segments) {
    const text = normalizeText(segment.text);
    if (!text) continue;
    const remaining = MAX_EXTRACTED_CHARS - total;
    if (remaining <= 0) break;
    result.push({ label: segment.label, text: text.slice(0, remaining) });
    total += Math.min(text.length, remaining);
  }
  return result;
}

export async function extractFileText(buffer: Buffer, fileName: string, mime = ""): Promise<ExtractResult> {
  const ext = path.extname(fileName).toLowerCase();
  let segments: ExtractedSegment[];

  if (ext === ".pdf" || mime === "application/pdf") {
    segments = await extractPdf(buffer);
    const result = capSegments(segments);
    return result.length
      ? { status: "done", segments: result }
      : { status: "empty", message: "텍스트가 없는 PDF입니다. (스캔 문서는 OCR 지원 후 인덱싱됩니다)" };
  }
  if (ext === ".docx") segments = await extractDocx(buffer);
  else if (SPREADSHEET_EXTENSIONS.has(ext)) segments = await extractSpreadsheet(buffer);
  else if (ext === ".pptx") segments = await extractPptx(buffer);
  else if (ext === ".hwpx") segments = await extractHwpx(buffer);
  else if (ext === ".html" || ext === ".htm") segments = [{ label: null, text: extractHtml(decodeTextFile(buffer)) }];
  else if (TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/")) segments = [{ label: null, text: decodeTextFile(buffer) }];
  else if (ext === ".hwp") return { status: "unsupported", message: "HWP(바이너리) 형식은 아직 지원하지 않습니다. HWPX로 저장하면 인덱싱됩니다." };
  else if (mime.startsWith("image/")) return { status: "unsupported", message: "이미지는 OCR 지원 후 인덱싱됩니다." };
  else return { status: "unsupported", message: `지원하지 않는 형식입니다 (${ext || mime || "알 수 없음"}).` };

  const result = capSegments(segments);
  return result.length ? { status: "done", segments: result } : { status: "empty", message: "추출할 텍스트가 없습니다." };
}
