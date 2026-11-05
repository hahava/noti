#!/usr/bin/env node
/**
 * 회귀 확인 스크립트: 구조를 바꾸거나 큰 변경을 한 뒤 기존 기능이 그대로 도는지 본다.
 *
 *   npm run verify             정적 검사 + 실행 검사 + Electron 검사
 *   npm run verify -- --docker 위에 더해 운영 이미지 빌드 + 설치 마법사 전체 설치
 *   npm run verify -- --skip-static / --skip-electron
 *
 * 실행 검사는 개발 서버와 겹치지 않게 별도 포트(4100/4101/4110)와 별도 DB(noty_verify)를 쓰고,
 * 끝나면 DB 를 지운다. 개발 DB 서버(127.0.0.1:5434, docker compose 의 db)가 떠 있어야 한다.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

/* 구조가 바뀌면 여기만 고친다. */
const LAYOUT = {
  webDist: path.join(ROOT, "apps", "web", "dist"),
  desktopDir: path.join(ROOT, "apps", "desktop"),
};

const DEV_DB = process.env.VERIFY_DB_ADMIN_URL || "postgresql://notion:notion@127.0.0.1:5434/postgres";
const TEST_DB = "noty_verify";
const TEST_DB_URL = DEV_DB.replace(/\/[^/]+$/, `/${TEST_DB}`);
const PORTS = { api: 4100, collab: 4101, admin: 4110 };
const API = `http://127.0.0.1:${PORTS.api}`;
const ADMIN = `http://127.0.0.1:${PORTS.admin}`;
const ADMIN_PASSWORD = "verify-admin-pass";

const results = [];
const children = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : "");
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function run(name, command, commandArgs, describe = () => "") {
  const started = Date.now();
  const res = spawnSync(command, commandArgs, { cwd: ROOT, encoding: "utf8", shell: false });
  const output = `${res.stdout || ""}${res.stderr || ""}`;
  const ok = res.status === 0;
  const extra = describe(output);
  record(name, ok, ok ? `${((Date.now() - started) / 1000).toFixed(1)}s${extra ? ` · ${extra}` : ""}` : output.trim().split("\n").slice(-8).join("\n"));
  return { ok, output };
}

function startService(name, script, env) {
  const child = spawn("npm", ["run", "-s", script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push({ name, child, log: () => log });
  return child;
}

function stopServices() {
  for (const { child } of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // 이미 종료
    }
  }
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // 아직
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} 가 ${timeoutMs / 1000}초 안에 응답하지 않았습니다.`);
}

async function json(url, { method = "GET", token, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

async function resetTestDb() {
  const client = new pg.Client({ connectionString: DEV_DB });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${TEST_DB}`);
  await client.end();
}

async function dropTestDb() {
  const client = new pg.Client({ connectionString: DEV_DB });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await client.end();
}

async function collabSync(token, pageId) {
  const connect = () => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${PORTS.api}/collab`, name: `page:${pageId}`, document: doc, token });
    return { doc, provider, synced: new Promise((r) => provider.on("synced", r)) };
  };
  const a = connect();
  const b = connect();
  try {
    await Promise.race([Promise.all([a.synced, b.synced]), new Promise((_, rej) => setTimeout(() => rej(new Error("동기화 시간 초과")), 10_000))]);
    const received = new Promise((r) => b.doc.getMap("probe").observe(() => r(b.doc.getMap("probe").get("v"))));
    a.doc.getMap("probe").set("v", "verify");
    const value = await Promise.race([received, new Promise((_, rej) => setTimeout(() => rej(new Error("전달 시간 초과")), 5000))]);
    expect(value === "verify", `받은 값이 다릅니다: ${value}`);
  } finally {
    a.provider.destroy();
    b.provider.destroy();
  }
}

/* ------------------------------------------------------------------ 1. 정적 검사 */
async function staticChecks() {
  console.log("\n[정적 검사]");
  run("타입 검사 (tsc -b)", "npx", ["tsc", "-b"]);
  run("서버 테스트", "npm", ["run", "-s", "test"], (out) => {
    const pass = out.match(/# pass (\d+)/)?.[1];
    const fail = out.match(/# fail (\d+)/)?.[1];
    return pass ? `pass ${pass}, fail ${fail}` : "";
  });
  run("웹 빌드", "npm", ["run", "-s", "build:web"]);
  run("어드민 빌드", "npm", ["run", "-s", "build:admin"]);
}

/* ------------------------------------------------------------------ 2. 실행 검사 */
let mainToken = null;
let firstPageId = null;

async function runtimeChecks() {
  console.log("\n[실행 검사] (api :4100, collab :4101, admin :4110, DB noty_verify)");
  await resetTestDb();
  const env = {
    DATABASE_URL: TEST_DB_URL,
    HOST: "127.0.0.1",
    PORT: String(PORTS.api),
    COLLAB_HOST: "127.0.0.1",
    COLLAB_PORT: String(PORTS.collab),
    COLLAB_MODE: "single",
    ADMIN_HOST: "127.0.0.1",
    ADMIN_PORT: String(PORTS.admin),
    NOTY_ADMIN_PASSWORD: ADMIN_PASSWORD,
    FILE_URL_SECRET: randomBytes(16).toString("hex"),
    NOTY_SECRET_KEY: randomBytes(16).toString("hex"),
    NOTY_WEB_DIST: LAYOUT.webDist,
    NOTY_UPLOADS_DIR: mkdtempSync(path.join(os.tmpdir(), "noty-verify-uploads-")),
    EMBEDDING_ENABLED: "false",
    AI_DIGEST_ENABLED: "false",
    CORS_ALLOWED_ORIGINS: "http://allowed.example",
  };
  startService("api", "start:server", env);
  await check("API 시작", () => waitFor(`${API}/api/health`, 90_000));
  startService("collab", "start:collaboration", env);
  startService("admin", "start:admin", env);
  await check("어드민 시작", () => waitFor(`${ADMIN}/api/health`, 60_000));
  await new Promise((r) => setTimeout(r, 1500)); // 협업 서버 listen 대기

  await check("웹 화면 제공 (/ 와 화면 경로)", async () => {
    const index = await fetch(`${API}/`);
    expect(index.status === 200 && index.headers.get("content-type")?.includes("text/html"), `/ → ${index.status}`);
    const spa = await fetch(`${API}/some/page`);
    expect(spa.status === 200, `/some/page → ${spa.status}`);
  });

  await check("로그인 (첫 관리자)", async () => {
    const res = await json(`${API}/api/auth/login`, { method: "POST", body: { username: "admin", password: ADMIN_PASSWORD } });
    expect(res.status === 200 && res.data?.token, `status ${res.status}`);
    mainToken = res.data.token;
  });

  await check("페이지 만들기·목록", async () => {
    const created = await json(`${API}/api/pages`, { method: "POST", token: mainToken, body: { title: "검증 페이지" } });
    expect(created.status === 201, `생성 ${created.status}`);
    firstPageId = created.data.page?.id ?? created.data.id;
    const list = await json(`${API}/api/pages`, { token: mainToken });
    expect(list.data.pages.some((p) => p.id === firstPageId), "목록에 없음");
  });

  await check("하위 페이지 → 부모 본문에 페이지 블록", async () => {
    const child = await json(`${API}/api/pages`, {
      method: "POST",
      token: mainToken,
      body: { title: "하위 페이지", parentId: firstPageId, insertIntoParentBlocks: true },
    });
    expect(child.status === 201, `생성 ${child.status}`);
    const parent = await json(`${API}/api/pages/${firstPageId}/document`, { token: mainToken });
    const childId = child.data.page?.id ?? child.data.id;
    expect(JSON.stringify(parent.data).includes(childId), "부모 본문에 하위 페이지가 없음");
  });

  await check("첨부 파일: 업로드·권한·서명 주소", async () => {
    const up = await json(`${API}/api/attachments`, {
      method: "POST",
      token: mainToken,
      body: { name: "a.txt", type: "text/plain", base64: Buffer.from("hello verify").toString("base64") },
    });
    expect(up.status === 201, `업로드 ${up.status}`);
    const anon = await fetch(`${API}${up.data.url}`);
    expect(anon.status === 401, `로그인 없이 ${anon.status}`);
    const signed = await json(`${API}/api/files/sign?url=${encodeURIComponent(up.data.url)}`, { token: mainToken });
    const body = await (await fetch(`${API}${signed.data.url}`)).text();
    expect(body === "hello verify", `서명 주소 내용: ${body}`);
  });

  await check("특수 블록 페이지 저장 (코드·수식·다이어그램)", async () => {
    const created = await json(`${API}/api/pages`, { method: "POST", token: mainToken, body: { title: "블록 확인" } });
    const id = created.data.page?.id ?? created.data.id;
    const blocks = [
      { type: "codeBlock", props: { language: "javascript" }, content: [{ type: "text", text: "const answer = 42;", styles: {} }] },
      { type: "mathBlock", content: [{ type: "text", text: "\\frac{a}{b} + \\sqrt{x^2}", styles: {} }] },
      { type: "diagram", content: [{ type: "text", text: "graph TD; A-->B;", styles: {} }] },
      { type: "paragraph", content: [{ type: "text", text: "블록 확인 문단", styles: {} }] },
    ];
    const saved = await json(`${API}/api/pages/${id}/document`, { method: "PUT", token: mainToken, body: { blocks } });
    expect(saved.status === 200, `저장 ${saved.status}`);
  });

  await check("검색", async () => {
    const res = await json(`${API}/api/search?q=${encodeURIComponent("검증")}`, { token: mainToken });
    expect(res.status === 200, `status ${res.status}`);
  });

  await check("CORS (허용 / Electron / 차단)", async () => {
    const h = async (origin) => (await fetch(`${API}/api/health`, { headers: { Origin: origin } })).headers.get("access-control-allow-origin");
    expect((await h("http://allowed.example")) === "http://allowed.example", "허용 주소");
    expect((await h("null")) === "null", "Electron");
    expect((await h("http://evil.example")) === null, "차단 주소");
  });

  await check("실시간 협업 (/collab, 두 클라이언트)", () => collabSync(mainToken, firstPageId));

  let adminToken = null;
  await check("어드민 로그인·계정 만들기", async () => {
    const login = await json(`${ADMIN}/api/auth/login`, { method: "POST", body: { username: "admin", password: ADMIN_PASSWORD } });
    expect(login.status === 200, `로그인 ${login.status}`);
    adminToken = login.data.token;
    const created = await json(`${ADMIN}/api/users`, {
      method: "POST",
      token: adminToken,
      body: { username: "viewer1", displayName: "Viewer", password: "viewer-pass-1", role: "viewer" },
    });
    expect(created.status === 201, `계정 만들기 ${created.status}`);
  });

  await check("읽기 전용: 보기 가능, 쓰기 차단", async () => {
    const login = await json(`${API}/api/auth/login`, { method: "POST", body: { username: "viewer1", password: "viewer-pass-1" } });
    expect(login.status === 200, `로그인 ${login.status}`);
    const list = await json(`${API}/api/pages`, { token: login.data.token });
    expect(list.status === 200, `목록 ${list.status}`);
    const write = await json(`${API}/api/pages`, { method: "POST", token: login.data.token, body: { title: "x" } });
    expect(write.status === 403, `쓰기 ${write.status}`);
  });

  await check("API 키 암호화 저장 (DB 에는 암호문, 화면에는 가린 값)", async () => {
    const key = "sk-verify-0123456789";
    const saved = await json(`${ADMIN}/api/settings`, {
      method: "PUT",
      token: adminToken,
      body: { config: { embedding: { enabled: false, provider: "openai", model: "text-embedding-3-small", baseUrl: "https://api.openai.com/v1", apiKey: key } } },
    });
    expect(saved.status === 200, `저장 ${saved.status}`);
    expect(saved.data.config.embedding.apiKey === "sk-v...6789", `가린 값: ${saved.data.config.embedding.apiKey}`);
    const client = new pg.Client({ connectionString: TEST_DB_URL });
    await client.connect();
    const raw = (await client.query("SELECT value->>'apiKey' AS k FROM system_settings WHERE key = 'embedding'")).rows[0]?.k;
    await client.end();
    expect(raw?.startsWith("enc:v1:") && !raw.includes("sk-verify"), `DB 값: ${String(raw).slice(0, 20)}`);
  });

  await check("어드민 설정·상태 조회", async () => {
    const settings = await json(`${ADMIN}/api/settings`, { token: adminToken });
    expect(settings.status === 200, `설정 ${settings.status}`);
    const status = await json(`${ADMIN}/api/status`, { token: adminToken });
    expect(status.status === 200 && status.data.indexing, `상태 ${status.status}`);
  });
}

/* ------------------------------------------------------------------ 3. Electron */
async function electronCheck() {
  console.log("\n[Electron 검사] (빌드된 화면을 file:// 로 열어 실행 검사 서버에 접속)");
  if (!mainToken) {
    record("Electron", false, "실행 검사가 먼저 성공해야 합니다.");
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "noty-verify-electron-"));
  const mainFile = path.join(dir, "main.cjs");
  writeFileSync(
    mainFile,
    `const { app, BrowserWindow, session } = require("electron");
// 데스크톱 앱과 같은 CSP 를 건다.
const { applyRendererCsp } = require(${JSON.stringify(path.join(LAYOUT.desktopDir, "csp.cjs"))});
// 실행마다 빈 프로필을 쓴다. (이전 실행의 만료된 토큰이 남아 있으면 앱이 세션을 지우면서 결과가 흔들린다)
app.setPath("userData", ${JSON.stringify(path.join(dir, "profile"))});
app.whenReady().then(async () => {
  applyRendererCsp(session.defaultSession);
  const win = new BrowserWindow({ show: false });
  const cspViolations = [];
  win.webContents.on("console-message", (...args) => {
    const message = typeof args[0] === "object" && args[0] && "message" in args[0] ? args[0].message : args[2];
    if (/Content Security Policy/i.test(String(message))) cspViolations.push(String(message).slice(0, 160));
  });
  const index = ${JSON.stringify(path.join(LAYOUT.webDist, "index.html"))};
  await win.loadFile(index);
  await win.webContents.executeJavaScript(\`
    localStorage.setItem("noty.serverHost", ${JSON.stringify(API)});
    localStorage.setItem("noty.authToken", ${JSON.stringify(mainToken)});
    localStorage.setItem("noty.authUser", JSON.stringify({ id: "user-admin", username: "admin", displayName: "admin", role: "admin" }));
  \`);
  await win.loadFile(index);
  // 화면이 페이지 목록을 그릴 때까지 최대 15초 기다린다.
  for (let i = 0; i < 30; i += 1) {
    const ready = await win.webContents.executeJavaScript('document.body.innerText.includes("검증 페이지")');
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const result = await win.webContents.executeJavaScript(\`(async () => ({
    origin: location.origin,
    health: await fetch(${JSON.stringify(`${API}/api/health`)}).then((r) => r.status).catch(() => 0),
    ws: await new Promise((res) => { const s = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${PORTS.api}/collab`)}); s.onopen = () => { s.close(); res("open"); }; s.onerror = () => res("error"); setTimeout(() => res("timeout"), 4000); }),
    pageListed: document.body.innerText.includes("검증 페이지"),
    login: !!document.querySelector(".login-screen"),
    error: !!document.querySelector(".center-message--error"),
  }))()\`);

  // 코드·수식·다이어그램 블록 페이지를 열어 실제로 그려지는지 본다.
  await win.webContents.executeJavaScript(\`(() => {
    const target = [...document.querySelectorAll("button, a, [role=treeitem], [role=button], span, div")]
      .find((el) => el.children.length === 0 && el.textContent.trim() === "블록 확인");
    (target?.closest("button, a, [role=treeitem], [role=button]") || target)?.click();
  })()\`);
  let blocks = {};
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    blocks = await win.webContents.executeJavaScript(\`({
      opened: document.body.innerText.includes("블록 확인 문단"),
      code: !!document.querySelector(".bn-editor pre code, .bn-editor [data-content-type=codeBlock] pre"),
      math: !!document.querySelector(".bn-editor .katex"),
      diagram: !!document.querySelector(".bn-editor svg[id*=mermaid], .bn-editor [data-content-type=diagram] svg"),
    })\`);
    if (blocks.opened && blocks.code && blocks.math && blocks.diagram) break;
  }
  result.blocks = blocks;
  result.cspViolations = cspViolations;
  console.log("VERIFY_ELECTRON=" + JSON.stringify(result));
  app.exit(0);
});`,
  );
  const res = spawnSync("npx", ["electron", mainFile], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  rmSync(dir, { recursive: true, force: true });
  const line = `${res.stdout}`.split("\n").find((l) => l.startsWith("VERIFY_ELECTRON="));
  if (!line) {
    record("Electron (file://) → 서버", false, `${res.stdout}${res.stderr}`.trim().split("\n").slice(-5).join("\n"));
    return;
  }
  const r = JSON.parse(line.slice("VERIFY_ELECTRON=".length));
  const { blocks, cspViolations, ...base } = r;
  record(
    "Electron (file://, CSP) → 서버",
    base.origin === "file://" && base.health === 200 && base.ws === "open" && base.pageListed && !base.login && !base.error,
    JSON.stringify(base),
  );
  record(
    "Electron: 코드·수식·다이어그램 블록 표시",
    Boolean(blocks?.opened && blocks.code && blocks.math && blocks.diagram),
    JSON.stringify(blocks),
  );
  record("Electron: CSP 위반 없음", cspViolations.length === 0, cspViolations.length ? cspViolations.join(" | ") : "");
  // 데스크톱 앱 본체(main 프로세스)가 빌드된 화면을 찾아 띄우는지. 임시 사용자 데이터 폴더로 실행한다.
  const userData = mkdtempSync(path.join(os.tmpdir(), "noty-verify-desktop-"));
  const smoke = spawnSync("npx", ["electron", LAYOUT.desktopDir, "--smoke-test"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NOTY_DESKTOP_USER_DATA: userData },
  });
  rmSync(userData, { recursive: true, force: true });
  const smokeLine = `${smoke.stdout}`.split("\n").find((l) => l.startsWith("SMOKE_RESULT="));
  const smokeResult = smokeLine ? JSON.parse(smokeLine.slice("SMOKE_RESULT=".length)) : null;
  record(
    "데스크톱 앱 실행 (main 프로세스 → 로그인 화면)",
    Boolean(smokeResult && smokeResult.errorCount === 0 && /Noty에 로그인/.test(smokeResult.text)),
    smokeResult ? path.relative(ROOT, LAYOUT.desktopDir) : `${smoke.stdout}${smoke.stderr}`.trim().split("\n").slice(-4).join("\n"),
  );
}

/* ------------------------------------------------------------------ 4. Docker (선택) */
async function dockerChecks() {
  console.log("\n[Docker 검사] (운영 이미지 + 설치 마법사 전체 설치, 격리된 이름·볼륨)");
  const existing = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.split("\n");
  const clash = ["noty-admin", "noty-api", "noty-collab", "noty-db"].filter((n) => existing.includes(n));
  if (clash.length) {
    record("Docker 검사", false, `이미 있는 컨테이너와 이름이 겹쳐 건너뜁니다: ${clash.join(", ")}`);
    return;
  }
  const build = run("운영 이미지 빌드", "docker", ["build", "-q", "-f", "deploy/Dockerfile", "--target", "app", "-t", "noty-app:verify", "."], () =>
    spawnSync("docker", ["images", "noty-app:verify", "--format", "{{.Size}}"], { encoding: "utf8" }).stdout.trim(),
  );
  if (!build.ok) return;
  // 운영 이미지에 문서 처리(PDF·Word·Excel) 의존성이 다 들어 있는지
  run("운영 이미지: 첨부 파일 텍스트 추출", "docker", ["run", "--rm", "noty-app:verify", "npx", "tsx", "--test", "apps/server/file-extract.test.ts"], (out) => {
    const pass = out.match(/# pass (\d+)/)?.[1];
    return pass ? `pass ${pass}` : "";
  });

  const dir = mkdtempSync(path.join(os.tmpdir(), "noty-verify-docker-"));
  writeFileSync(
    path.join(dir, "drive.mjs"),
    `const A = "http://127.0.0.1:4410";
const code = process.argv[2];
const call = async (p, o = {}) => { const r = await fetch(A + p, { method: o.method || "GET", headers: { "Content-Type": "application/json", "X-Setup-Code": code }, body: o.body && JSON.stringify(o.body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
const out = {};
out.verify = (await call("/api/setup/verify", { method: "POST" })).status;
const plan = { database: { mode: "docker", port: 15499 }, ollama: { mode: "none" }, models: { chat: "", embedding: "", pull: false },
  services: { mode: "docker", bind: "local", apiPort: 4400, collabPort: 4401 }, admin: { username: "boss", password: "boss-pass-123" } };
out.install = (await call("/api/setup/install", { method: "POST", body: plan })).status;
let job; for (let i = 0; i < 120; i++) { await new Promise((r) => setTimeout(r, 3000)); job = (await call("/api/setup/job")).data.job; if (job.status !== "running") break; }
out.job = job.status; out.error = job.error;
out.locked = (await call("/api/setup/install", { method: "POST", body: plan })).status;
const login = await (await fetch("http://127.0.0.1:4400/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "boss", password: "boss-pass-123" }) })).json();
out.mainLogin = Boolean(login.token);
out.web = (await fetch("http://127.0.0.1:4400/")).status;
out.ws = await new Promise((res) => { const s = new WebSocket("ws://127.0.0.1:4400/collab"); s.onopen = () => { s.close(); res("open"); }; s.onerror = () => res("error"); setTimeout(() => res("timeout"), 4000); });
console.log("VERIFY_DOCKER=" + JSON.stringify(out));`,
  );
  const sh = (a) => spawnSync("docker", a, { encoding: "utf8" });
  try {
    sh(["volume", "create", "noty_config"]);
    sh([
      "run", "-d", "--name", "noty-admin", "--network", "host", "-u", "root",
      "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", "noty_config:/app/config",
      "-e", "ADMIN_HOST=127.0.0.1", "-e", "ADMIN_PORT=4410", "-e", "NOTY_APP_IMAGE=noty-app:verify",
      "noty-app:verify",
    ]);
    let code = "";
    for (let i = 0; i < 30 && !code; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      code = sh(["logs", "noty-admin"]).stdout.match(/설치 코드: ([A-Z0-9-]+)/)?.[1] || "";
    }
    if (!code) throw new Error("설치 코드를 찾지 못했습니다.");
    const drive = sh(["run", "--rm", "--network", "host", "-v", `${dir}:/e2e`, "noty-app:verify", "node", "/e2e/drive.mjs", code]);
    const line = drive.stdout.split("\n").find((l) => l.startsWith("VERIFY_DOCKER="));
    if (!line) throw new Error(`${drive.stdout}${drive.stderr}`.trim().split("\n").slice(-5).join("\n"));
    const r = JSON.parse(line.slice("VERIFY_DOCKER=".length));
    record("설치 마법사 전체 설치 (DB Docker + 서비스 Docker)", r.verify === 200 && r.install === 202 && r.job === "done", r.error || "");
    record("설치 후 잠금 · 로그인 · 웹 · /collab", r.locked === 409 && r.mainLogin && r.web === 200 && r.ws === "open", JSON.stringify({ locked: r.locked, login: r.mainLogin, web: r.web, ws: r.ws }));
  } catch (error) {
    record("설치 마법사", false, error instanceof Error ? error.message : String(error));
  } finally {
    sh(["rm", "-f", "noty-admin", "noty-api", "noty-collab", "noty-db"]);
    sh(["volume", "rm", "noty_config", "noty_pgdata", "noty_data"]);
    sh(["rmi", "noty-app:verify"]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ 실행 */
const started = Date.now();
try {
  if (!args.has("--skip-static")) await staticChecks();
  await runtimeChecks();
  if (!args.has("--skip-electron")) await electronCheck();
} catch (error) {
  record("검사 중단", false, error instanceof Error ? error.stack || error.message : String(error));
} finally {
  const failedServices = results.some((r) => !r.ok);
  if (failedServices) {
    for (const { name, log } of children) console.log(`\n--- ${name} 로그 (마지막 15줄) ---\n${log().trim().split("\n").slice(-15).join("\n")}`);
  }
  stopServices();
  await dropTestDb().catch(() => undefined);
}
if (args.has("--docker")) await dockerChecks();

const failed = results.filter((r) => !r.ok);
console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과 (${((Date.now() - started) / 1000).toFixed(0)}s)`);
if (failed.length) {
  console.log("실패:");
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
