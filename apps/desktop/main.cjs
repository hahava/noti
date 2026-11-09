const { app, BrowserWindow, ipcMain, net, protocol, session, shell } = require("electron");
const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { existsSync } = require("node:fs");
const { applyRendererCsp } = require("./csp.cjs");

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const devServerArgument = process.argv.find((argument) => argument.startsWith("--dev-server-url="));
const devServerUrl = devServerArgument?.slice("--dev-server-url=".length);
const isSmokeTest = process.argv.includes("--smoke-test");

// 사용자 데이터 폴더 이름을 패키지 위치와 상관없이 고정한다.
// (예전부터 개발 실행은 "notion-like", 배포판은 productName 인 "Noty" 폴더를 썼다)
app.setPath(
  "userData",
  process.env.NOTY_DESKTOP_USER_DATA || path.join(app.getPath("appData"), app.isPackaged ? "Noty" : "notion-like"),
);

/** 앱 아이콘 (파비콘과 같은 모양). 배포판 아이콘은 electron-builder 가 build/icon.png 로 만든다. */
const APP_ICON = path.join(__dirname, "build", "icon.png");

/**
 * 앱에 묶인 웹 화면: 저장소에서 실행하면 apps/web/dist, 배포판에서는 함께 묶은 renderer/.
 * 로그인 화면(서버 주소 입력)으로 쓰고, 서버가 웹 화면을 제공하지 않을 때 그대로 앱으로 쓴다.
 */
function resolveRendererIndex() {
  const candidates = [
    path.join(__dirname, "..", "web", "dist", "index.html"),
    path.join(__dirname, "renderer", "index.html"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[candidates.length - 1];
}

/*
 * 서버 화면 모드 (1.1.0~)
 * 로그인에 성공하면 그 서버가 제공하는 웹 화면(loadURL)으로 옮겨 간다.
 * 그래서 웹 화면을 고쳐도 서버만 다시 배포하면 앱에 반영된다.
 * - 마지막으로 접속한 서버는 userData/server.json 에 남겨 다음 실행 때 바로 연다.
 * - 서버에 닿지 않거나 웹 화면을 제공하지 않으면(개발 서버 등) 앱에 묶인 화면을 쓴다.
 * - 로그인 토큰은 주소(origin)마다 localStorage 가 달라서, 한 번만 꺼내 쓰는 값으로 넘긴다.
 */
const SERVER_PROBE_TIMEOUT_MS = 5000;
/** @type {string | null} 지금 창이 띄운 서버의 origin (IPC·이동 허용 판단용) */
let activeServerOrigin = null;
/** @type {{ origin: string, session: unknown } | null} 서버 화면이 시작할 때 한 번 가져갈 로그인 세션 */
let pendingSession = null;

function serverConfigPath() {
  return path.join(app.getPath("userData"), "server.json");
}

/** 서버 주소(리버스 프록시 하위 경로 포함)를 끝 / 없이 정리한다. http(s) 가 아니면 null. */
function toServerBase(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** http(s) 주소만 받아 origin 으로 정리한다. 아니면 null. */
function toServerOrigin(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function readSavedServerBase() {
  try {
    const saved = JSON.parse(await readFile(serverConfigPath(), "utf8"));
    return toServerBase(saved?.serverHost);
  } catch {
    return null;
  }
}

async function writeSavedServerBase(base) {
  if (!base) {
    await rm(serverConfigPath(), { force: true });
    return;
  }
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeJsonAtomic(serverConfigPath(), { serverHost: base });
}

/** 서버가 웹 화면(HTML)을 제공하는지 확인한다. API 만 있는 개발 서버면 false. */
async function serverProvidesWebApp(base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_PROBE_TIMEOUT_MS);
  try {
    const response = await net.fetch(`${base}/`, { signal: controller.signal, cache: "no-store" });
    const type = response.headers.get("content-type") || "";
    return response.ok && type.includes("text/html");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 요청을 보낸 화면이 앱에 묶인 화면(또는 개발 서버 화면)인지 */
function isFromLocalRenderer(event) {
  const url = event.senderFrame?.url || "";
  if (url.startsWith("file:")) return true;
  return Boolean(devServerUrl) && toServerOrigin(url) === toServerOrigin(devServerUrl);
}

/** 요청을 보낸 화면이 지금 띄운 서버 화면인지 */
function isFromActiveServer(event) {
  const origin = toServerOrigin(event.senderFrame?.url || "");
  return Boolean(origin) && origin === activeServerOrigin;
}

/** 앱에 묶인 화면에서만 부를 수 있는 IPC 처리기로 감싼다. 서버 화면에는 로컬 파일 접근을 열지 않는다. */
function localOnly(handler) {
  return (event, ...args) => {
    if (!isFromLocalRenderer(event)) throw new Error("This action is not available here.");
    return handler(event, ...args);
  };
}

function loadLocalRenderer(window) {
  activeServerOrigin = null;
  return window.loadFile(resolveRendererIndex());
}

function loadServerRenderer(window, base) {
  activeServerOrigin = toServerOrigin(base);
  return window.loadURL(`${base}/`);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app-asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function documentsDir() {
  return path.join(app.getPath("userData"), "documents");
}

function indexPath() {
  return path.join(documentsDir(), "index.json");
}

function sanitizePageId(id) {
  const cleaned = String(id || "welcome").replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || "welcome";
}

function documentPath(id = "welcome") {
  return path.join(documentsDir(), `${sanitizePageId(id)}.blocknote.json`);
}

async function writeJsonAtomic(target, data) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function readIndex() {
  try {
    const raw = await readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.pages) && parsed.pages.length > 0) {
      const firstDoc = parsed.pages.find((item) => item.kind !== "folder") || parsed.pages[0];
      return {
        pages: parsed.pages,
        activePageId: parsed.activePageId || firstDoc.id,
      };
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      console.error("Failed to read page index:", error);
    }
  }

  const now = new Date().toISOString();
  const initialIndex = {
    activePageId: "welcome",
    pages: [
      {
        id: "welcome",
        kind: "page",
        title: "나의 문서 편집기",
        parentId: null,
        order: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  await writeJsonAtomic(indexPath(), initialIndex);
  return initialIndex;
}

function isDescendant(pages, targetParentId, pageId) {
  let currentId = targetParentId;
  const visited = new Set();
  while (currentId) {
    if (currentId === pageId) return true;
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const parent = pages.find((item) => item.id === currentId);
    currentId = parent ? parent.parentId : null;
  }
  return false;
}

async function listPages() {
  return readIndex();
}

async function createPage(_event, options = {}) {
  const index = await readIndex();
  const kind = options && options.kind === "folder" ? "folder" : "page";
  const parentId = options && typeof options.parentId === "string" ? options.parentId : null;
  const defaultTitle = kind === "folder" ? "새 폴더" : "제목 없는 문서";
  const title =
    options && typeof options.title === "string" && options.title.trim()
      ? options.title.trim()
      : defaultTitle;

  const siblings = index.pages.filter((page) => page.parentId === parentId);
  const nextOrder = siblings.reduce((max, item) => Math.max(max, item.order ?? 0), -1) + 1;
  const now = new Date().toISOString();
  const prefix = kind === "folder" ? "folder" : "page";
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;

  const newPage = {
    id,
    kind,
    title,
    parentId,
    order: nextOrder,
    createdAt: now,
    updatedAt: now,
  };

  if (kind === "page") {
    const initialBlocks = [
      {
        type: "heading",
        props: { level: 1 },
        content: title,
      },
      {
        type: "paragraph",
        content: "",
      },
    ];
    await writeJsonAtomic(documentPath(id), initialBlocks);
    index.activePageId = id;
  }

  index.pages.push(newPage);
  await writeJsonAtomic(indexPath(), index);

  return { page: newPage, pages: index.pages };
}

async function updatePage(_event, payload = {}) {
  if (!payload || typeof payload.id !== "string") {
    throw new TypeError("Page id is required.");
  }

  const index = await readIndex();
  const target = index.pages.find((page) => page.id === payload.id);
  if (!target) {
    return { pages: index.pages };
  }

  if (typeof payload.title === "string") {
    const fallback = target.kind === "folder" ? "새 폴더" : "제목 없는 문서";
    target.title = payload.title.trim() || fallback;
  }

  if ("parentId" in payload) {
    const nextParentId = typeof payload.parentId === "string" ? payload.parentId : null;
    if (nextParentId !== target.parentId && !isDescendant(index.pages, nextParentId, target.id)) {
      const siblings = index.pages.filter(
        (page) => page.parentId === nextParentId && page.id !== target.id,
      );
      target.parentId = nextParentId;
      target.order = siblings.reduce((max, item) => Math.max(max, item.order ?? 0), -1) + 1;
    }
  }

  target.updatedAt = new Date().toISOString();
  await writeJsonAtomic(indexPath(), index);
  return { pages: index.pages };
}

async function deletePage(_event, id) {
  const targetId = sanitizePageId(id);
  const index = await readIndex();
  const target = index.pages.find((page) => page.id === targetId);
  if (!target) {
    return { pages: index.pages, nextActivePageId: index.activePageId };
  }

  const toDelete = new Set([targetId]);
  let added = true;
  while (added) {
    added = false;
    for (const page of index.pages) {
      if (page.parentId && toDelete.has(page.parentId) && !toDelete.has(page.id)) {
        toDelete.add(page.id);
        added = true;
      }
    }
  }

  for (const deleteId of toDelete) {
    try {
      await rm(documentPath(deleteId), { force: true });
    } catch (error) {
      console.error(`Failed to remove document ${deleteId}:`, error);
    }
  }

  index.pages = index.pages.filter((page) => !toDelete.has(page.id));
  const remainingDocs = index.pages.filter((page) => page.kind !== "folder");

  if (remainingDocs.length === 0) {
    const now = new Date().toISOString();
    const fallbackId = `page-${randomUUID().slice(0, 8)}`;
    index.pages.push({
      id: fallbackId,
      kind: "page",
      title: "새 문서",
      parentId: null,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    index.activePageId = fallbackId;
  } else if (toDelete.has(index.activePageId)) {
    const parentDoc =
      target.parentId &&
      remainingDocs.find((page) => page.id === target.parentId);
    index.activePageId = (parentDoc || remainingDocs[0]).id;
  }

  await writeJsonAtomic(indexPath(), index);
  return { pages: index.pages, nextActivePageId: index.activePageId };
}

async function loadDocument(_event, id = "welcome") {
  const pageId = sanitizePageId(id);
  const target = documentPath(pageId);

  try {
    const index = await readIndex();
    const found = index.pages.find((page) => page.id === pageId);
    if (found && found.kind !== "folder" && index.activePageId !== pageId) {
      index.activePageId = pageId;
      await writeJsonAtomic(indexPath(), index);
    }
  } catch (error) {
    console.error("Failed to update activePageId:", error);
  }

  try {
    const raw = await readFile(target, "utf8");
    return { blocks: JSON.parse(raw), path: target };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { blocks: null, path: target };
    }
    throw error;
  }
}

async function saveDocument(_event, blocks, options = {}) {
  if (!Array.isArray(blocks)) {
    throw new TypeError("Document must be an array of BlockNote blocks.");
  }

  const pageId = sanitizePageId(options?.id || "welcome");
  const target = documentPath(pageId);
  const savedAt = new Date().toISOString();

  await writeJsonAtomic(target, blocks);

  const index = await readIndex();
  const page = index.pages.find((item) => item.id === pageId);
  if (page && page.kind !== "folder") {
    if (typeof options?.title === "string" && options.title.trim()) {
      page.title = options.title.trim();
    }
    page.updatedAt = savedAt;
    index.activePageId = pageId;
    await writeJsonAtomic(indexPath(), index);
  }

  return { path: target, savedAt, pages: index.pages };
}

async function saveAttachment(_event, attachment) {
  if (!attachment || typeof attachment.name !== "string") {
    throw new TypeError("Attachment metadata is invalid.");
  }

  const bytes = Buffer.from(attachment.bytes);
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_SIZE) {
    throw new RangeError("Attachments must be between 1 byte and 25 MB.");
  }

  const extension = path.extname(attachment.name).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 12);
  const fileName = `${randomUUID()}${extension}`;
  const directory = path.join(app.getPath("userData"), "attachments");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, fileName), bytes, { flag: "wx" });

  return {
    name: attachment.name,
    type: typeof attachment.type === "string" ? attachment.type : "",
    size: bytes.length,
    url: `app-asset://attachments/${fileName}`,
  };
}

function createWindow() {
  const window = new BrowserWindow({
    // Windows·Linux 창 아이콘 (macOS 는 앱 번들 아이콘을 쓴다)
    icon: existsSync(APP_ICON) ? APP_ICON : undefined,
    width: 1200,
    height: 820,
    minWidth: 480,
    minHeight: 520,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#fbfbfa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("console-message", (_event, details) => {
    const { level, message, lineNumber, sourceId } = details;
    console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`Renderer failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
    // 서버 화면을 못 불러오면(서버 꺼짐 등) 앱에 묶인 로그인 화면으로 돌아간다. (-3: 다른 이동으로 취소됨)
    if (isMainFrame && activeServerOrigin && errorCode !== -3) {
      void loadLocalRenderer(window);
    }
  });

  // 창 안에서는 앱 화면·지금 서버·개발 서버로만 이동한다. 나머지 링크는 기본 브라우저로 연다.
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:")) return;
    const origin = toServerOrigin(url);
    if (origin && (origin === activeServerOrigin || (devServerUrl && origin === toServerOrigin(devServerUrl)))) return;
    event.preventDefault();
    if (origin) void shell.openExternal(url);
  });

  if (isSmokeTest) {
    window.webContents.once("did-finish-load", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const result = await window.webContents.executeJavaScript(`({
        text: document.body.innerText,
        editorCount: document.querySelectorAll('.bn-editor').length,
        errorCount: document.querySelectorAll('.center-message--error').length
      })`);
      console.log(`SMOKE_RESULT=${JSON.stringify(result)}`);
      app.exit(result.editorCount > 0 && result.errorCount === 0 ? 0 : 1);
    });
  }

  return window;
}

/** 첫 화면: 개발 서버 → 마지막 서버의 웹 화면 → 앱에 묶인 화면 순으로 고른다. */
async function loadInitialRenderer(window) {
  if (devServerUrl) {
    await window.loadURL(devServerUrl);
    return;
  }
  if (!isSmokeTest) {
    const savedBase = await readSavedServerBase();
    if (savedBase && (await serverProvidesWebApp(savedBase))) {
      await loadServerRenderer(window, savedBase);
      return;
    }
  }
  await loadLocalRenderer(window);
}

/** 앱에 묶인 로그인 화면에서 로그인한 뒤: 서버가 웹 화면을 주면 그쪽으로 옮긴다. 옮겼으면 true. */
async function openServer(event, payload = {}) {
  if (devServerUrl || isSmokeTest) return false;
  const base = toServerBase(payload.serverHost);
  if (!base || !(await serverProvidesWebApp(base))) return false;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return false;
  await writeSavedServerBase(base);
  pendingSession = payload.session ? { origin: toServerOrigin(base), session: payload.session } : null;
  void loadServerRenderer(window, base);
  return true;
}

/** 서버 화면이 시작할 때 로그인 세션을 한 번 가져간다 (그 서버 것만). */
function takePendingSession(event) {
  if (!isFromActiveServer(event) || !pendingSession || pendingSession.origin !== activeServerOrigin) {
    event.returnValue = null;
    return;
  }
  event.returnValue = pendingSession.session;
  pendingSession = null;
}

/** 서버 화면에서 로그아웃: 저장한 서버를 지우고 앱에 묶인 로그인 화면으로 돌아간다. */
async function leaveServer(event) {
  if (!isFromActiveServer(event)) return;
  pendingSession = null;
  await writeSavedServerBase(null);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) void loadLocalRenderer(window);
}

app.whenReady().then(() => {
  applyRendererCsp(session.defaultSession);
  // 개발 실행(electron apps/desktop)에서도 Dock 에 Electron 기본 아이콘 대신 Noty 아이콘을 보인다.
  if (process.platform === "darwin" && !app.isPackaged && existsSync(APP_ICON)) app.dock?.setIcon(APP_ICON);
  protocol.handle("app-asset", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "attachments") return new Response("Not found", { status: 404 });

    const fileName = path.basename(decodeURIComponent(url.pathname));
    if (!fileName || fileName !== decodeURIComponent(url.pathname).slice(1)) {
      return new Response("Invalid path", { status: 400 });
    }

    const target = path.join(app.getPath("userData"), "attachments", fileName);
    return net.fetch(pathToFileURL(target).toString());
  });

  ipcMain.handle("pages:list", localOnly(listPages));
  ipcMain.handle("pages:create", localOnly(createPage));
  ipcMain.handle("pages:update", localOnly(updatePage));
  ipcMain.handle("pages:delete", localOnly(deletePage));
  ipcMain.handle("document:load", localOnly(loadDocument));
  ipcMain.handle("document:save", localOnly(saveDocument));
  ipcMain.handle("attachment:save", localOnly(saveAttachment));
  ipcMain.handle("server:open", localOnly(openServer));
  ipcMain.handle("server:leave", leaveServer);
  ipcMain.on("server:take-session", takePendingSession);
  void loadInitialRenderer(createWindow());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void loadInitialRenderer(createWindow());
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
