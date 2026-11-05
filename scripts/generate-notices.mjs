#!/usr/bin/env node
/**
 * 배포물에 들어가는 오픈소스 라이브러리의 라이선스 고지(THIRD_PARTY_NOTICES.txt)를 만든다.
 *
 *   node scripts/generate-notices.mjs <출력 파일> <워크스페이스...>
 *   예) node scripts/generate-notices.mjs apps/desktop/renderer/THIRD_PARTY_NOTICES.txt @noty/web
 *
 * 각 워크스페이스의 실행용 의존성(devDependencies 제외)을 따라가며 이름·버전·라이선스와
 * LICENSE 파일 원문을 모은다. 우리 워크스페이스(@noty/*)는 뺀다.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [output, ...workspaces] = process.argv.slice(2);
if (!output || workspaces.length === 0) {
  console.error("사용법: node scripts/generate-notices.mjs <출력 파일> <워크스페이스...>");
  process.exit(1);
}

const tree = JSON.parse(
  execFileSync("npm", ["ls", "--all", "--omit=dev", "--json", ...workspaces.flatMap((w) => ["--workspace", w])], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
);

const found = new Map(); // name@version → { name, version, dir }
function walk(deps) {
  for (const [name, info] of Object.entries(deps || {})) {
    if (!info || info.missing || !info.version) continue; // 설치되지 않은 선택 의존성
    const key = `${name}@${info.version}`;
    if (!name.startsWith("@noty/") && !found.has(key)) {
      const dir = info.path || path.join(ROOT, "node_modules", name);
      found.set(key, { name, version: info.version, dir });
    }
    walk(info.dependencies);
  }
}
walk(tree.dependencies);

function licenseText(dir) {
  if (!existsSync(dir)) return "";
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(f));
  return file ? readFileSync(path.join(dir, file), "utf8").trim() : "";
}

const entries = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
const sections = entries.map(({ name, version, dir }) => {
  let license = "UNKNOWN";
  let homepage = "";
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type || (pkg.licenses || []).map((l) => l.type || l).join(" OR ") || license;
    homepage = pkg.homepage || (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url) || "";
  } catch {
    // package.json 을 못 읽으면 이름·버전만 남긴다
  }
  const text = licenseText(dir);
  return [
    "-".repeat(78),
    `${name}@${version}`,
    `License: ${license}${homepage ? `\nSource: ${homepage}` : ""}`,
    "",
    text || "(라이선스 원문 파일이 패키지에 없습니다. 위 라이선스 식별자를 따릅니다.)",
  ].join("\n");
});

const header = `Noty — Third-party notices
이 배포물에는 아래 오픈소스 소프트웨어가 포함되어 있습니다. 각 라이선스 조건을 따릅니다.
대상: ${workspaces.join(", ")} · 패키지 ${entries.length}개 · 생성: ${new Date().toISOString().slice(0, 10)}
`;
mkdirSync(path.dirname(path.resolve(ROOT, output)), { recursive: true });
writeFileSync(path.resolve(ROOT, output), `${header}\n${sections.join("\n\n")}\n`);
console.log(`[notices] ${output}: ${entries.length}개 패키지`);
