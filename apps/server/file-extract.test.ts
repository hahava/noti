import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extractFileText } from "./file-extract.js";

/**
 * 첨부 파일 텍스트 추출 (검색·AI 참고용). 운영 이미지에서 의존성이 빠지면 여기서 깨진다.
 * 샘플 파일은 테스트 안에서 직접 만든다.
 */

function textOf(result: Awaited<ReturnType<typeof extractFileText>>): string {
  assert.equal(result.status, "done", JSON.stringify(result).slice(0, 200));
  return result.status === "done" ? result.segments.map((s) => s.text).join("\n") : "";
}

/** 텍스트 한 줄짜리 최소 PDF */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function minimalDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

test("extracts text from PDF", async () => {
  const text = textOf(await extractFileText(minimalPdf("Noty PDF probe"), "probe.pdf", "application/pdf"));
  assert.match(text, /Noty PDF probe/);
});

test("extracts text from DOCX", async () => {
  const text = textOf(await extractFileText(await minimalDocx("워드 문서 확인"), "probe.docx"));
  assert.match(text, /워드 문서 확인/);
});

test("extracts text from XLSX", async () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["항목", "값"], ["엑셀 확인", 42]]), "시트1");
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const text = textOf(await extractFileText(buffer, "probe.xlsx"));
  assert.match(text, /엑셀 확인/);
});

test("plain text and unsupported files", async () => {
  assert.match(textOf(await extractFileText(Buffer.from("메모 내용"), "memo.txt", "text/plain")), /메모 내용/);
  const unsupported = await extractFileText(Buffer.from([0, 1, 2]), "photo.heic", "image/heic");
  assert.notEqual(unsupported.status, "done");
});
