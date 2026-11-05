import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { listModels } from "@noty/core/ai-models";
import { CONFIG_DIR, isInstalled, readInstallConfig, writeInstallConfig, type NotyInstallConfig } from "@noty/core/config";
import { pool, reconfigureDatabase } from "@noty/core/db";
import { saveSystemSettingsToDb } from "@noty/core/settings";
import { createManagedUser, ensureUserColumns, resetManagedUserPassword, updateManagedUser } from "@noty/core/users";
import {
  buildImage,
  containerLogs,
  createTar,
  dockerInfo,
  dockerSocketPresent,
  explainDockerError,
  ensureVolume,
  imageExists,
  inspectContainer,
  pullImage,
  ensureNetwork,
  removeContainer,
  runContainer,
} from "./docker.js";

/**
 * 설치 마법사.
 *
 * 어드민을 처음 띄우면(설치 설정 없음) 설치 모드로 시작한다.
 * - 콘솔과 NOTY_CONFIG_DIR/setup-code.txt 에 일회용 설치 코드를 남기고, 설치 API 는 이 코드로만 열린다.
 * - 각 자원(DB, Ollama, 서비스)마다 "이미 있는 것에 URL 로 연결" 또는 "이 서버에 Docker 로 만들기"를 고른다.
 * - 설치가 끝나면 설정 파일에 installedAt 을 남기고, 이후 설치 API 와 Docker 제어는 잠긴다.
 */

const { Client } = pg;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const APP_IMAGE = process.env.NOTY_APP_IMAGE || "noty-app:latest";
const POSTGRES_IMAGE = "noty-postgres:pg17-pgroonga";
const OLLAMA_IMAGE = "ollama/ollama:0.40.0";
// 컨테이너·볼륨·네트워크 이름 앞부분. 검사 스크립트처럼 실제 설치와 겹치면 안 될 때 NOTY_RESOURCE_PREFIX 로 바꾼다.
const PREFIX = (process.env.NOTY_RESOURCE_PREFIX || "noty").replace(/[^a-z0-9]/g, "") || "noty";
const NAMES = { db: `${PREFIX}-db`, ollama: `${PREFIX}-ollama`, api: `${PREFIX}-api`, collab: `${PREFIX}-collab` };
const VOLUMES = { db: `${PREFIX}_pgdata`, ollama: `${PREFIX}_ollama`, data: `${PREFIX}_data` };
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/**
 * 컨테이너 네트워크 방식 (deploy/install.sh 가 정한다)
 * - host  : Linux. 모든 컨테이너가 서버의 127.0.0.1 을 같이 쓴다. 주소를 그대로 쓴다.
 * - bridge: Docker Desktop(macOS·Windows). 컨테이너는 Docker 네트워크 "noty" 안에서 서로를 이름으로 찾고,
 *           필요한 포트만 호스트에 연다. 사용자가 적은 127.0.0.1(호스트 컴퓨터)은 host.docker.internal 로 바꿔 접속한다.
 */
export const NETWORK_MODE: "host" | "bridge" = process.env.NOTY_DOCKER_NETWORK === "bridge" ? "bridge" : "host";
const DOCKER_NETWORK = PREFIX;
const isBridge = () => NETWORK_MODE === "bridge";

/** 사용자가 적은 주소(호스트 컴퓨터 기준)를 어드민·서비스 컨테이너에서 닿는 주소로 바꾼다. */
export function toContainerUrl(url: string): string {
  if (!isBridge() || !url) return url;
  try {
    const parsed = new URL(url);
    if (["127.0.0.1", "localhost", "0.0.0.0", "[::1]"].includes(parsed.hostname)) {
      parsed.hostname = "host.docker.internal";
      return parsed.toString().replace(/\/$/, url.endsWith("/") ? "/" : "");
    }
  } catch {
    // URL 이 아니면 그대로
  }
  return url;
}

/* ------------------------------------------------------------------ 설치 코드 */

let setupCode: string | null = null;

export function setupRequired(): boolean {
  return !isInstalled();
}

export function initSetupMode(): void {
  if (!setupRequired()) return;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const raw = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  setupCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  if (CONFIG_DIR) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(path.join(CONFIG_DIR, "setup-code.txt"), `${setupCode}\n`, { mode: 0o600 });
  }
  console.log("");
  console.log("  ┌──────────────────────────────────────────────┐");
  console.log("  │  Noty 설치 모드                              │");
  console.log(`  │  설치 코드: ${setupCode}                        │`);
  console.log("  │  어드민 화면에서 이 코드를 입력하세요.       │");
  console.log("  └──────────────────────────────────────────────┘");
  console.log("");
}

export function verifySetupCode(given: string | undefined): boolean {
  if (!setupCode || !given) return false;
  const a = Buffer.from(setupCode);
  const b = Buffer.from(given.trim().toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ 환경 확인 */

function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, host);
  });
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 5000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function inspectEnvironment() {
  const docker = { available: false, version: "", gpu: false, os: "", error: "" };
  if (dockerSocketPresent()) {
    try {
      const info = await dockerInfo();
      Object.assign(docker, { available: true, ...info });
    } catch (error) {
      docker.error = explainDockerError(error);
    }
  } else {
    docker.error = "Docker 소켓(/var/run/docker.sock)이 연결되어 있지 않습니다.";
  }

  let ollama: { found: boolean; url: string; version?: string } = { found: false, url: DEFAULT_OLLAMA_URL };
  try {
    const res = await fetchJson<{ version: string }>(`${toContainerUrl(DEFAULT_OLLAMA_URL)}/api/version`, undefined, 2000);
    ollama = { found: true, url: DEFAULT_OLLAMA_URL, version: res.version };
  } catch {
    // 없음
  }

  // bridge 방식에서는 어드민이 호스트 포트를 직접 볼 수 없다 (null = 확인 불가, 설치할 때 Docker 가 알려 준다).
  const ports: Record<string, boolean | null> = {};
  for (const port of [4000, 4001, 5433, 11434]) ports[port] = isBridge() ? null : await portFree(port);

  return { docker, ollama, ports, networkMode: NETWORK_MODE, appImage: APP_IMAGE, pending: Boolean(readInstallConfig()) };
}

export async function testDatabaseUrl(url: string) {
  const client = new Client({ connectionString: toContainerUrl(url), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const version = (await client.query("SHOW server_version")).rows[0]?.server_version as string;
    const ext = await client.query<{ name: string }>(
      "SELECT name FROM pg_available_extensions WHERE name IN ('vector', 'pgroonga')",
    );
    const names = new Set(ext.rows.map((row) => row.name));
    const warnings: string[] = [];
    if (!names.has("vector")) warnings.push("pgvector 확장이 없어 의미 검색(벡터)을 쓸 수 없습니다. pgvector 가 설치된 Postgres 가 필요합니다.");
    if (!names.has("pgroonga")) warnings.push("PGroonga 확장이 없어 한국어 키워드 검색이 기본 검색으로 대체됩니다.");
    return { ok: names.has("vector"), message: `PostgreSQL ${version} 연결 성공`, warnings };
  } catch (error) {
    return { ok: false, message: `연결 실패: ${error instanceof Error ? error.message : String(error)}`, warnings: [] };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function testOllamaUrl(rawUrl: string) {
  const url = toContainerUrl(rawUrl);
  try {
    const version = await fetchJson<{ version: string }>(`${url.replace(/\/+$/, "")}/api/version`);
    const chat = await listModels({ provider: "ollama", baseUrl: url }, "chat");
    const embedding = await listModels({ provider: "ollama", baseUrl: url }, "embedding");
    return {
      ok: true,
      message: `Ollama ${version.version} 연결 성공`,
      chatModels: chat.models.map((m) => m.id),
      embeddingModels: embedding.models.map((m) => m.id),
    };
  } catch (error) {
    return { ok: false, message: `연결 실패: ${error instanceof Error ? error.message : String(error)}`, chatModels: [], embeddingModels: [] };
  }
}

/* ------------------------------------------------------------------ 설치 계획과 작업 */

export interface SetupPlan {
  database: { mode: "docker"; port: number } | { mode: "external"; url: string };
  ollama: { mode: "docker"; gpu: boolean } | { mode: "external"; url: string } | { mode: "none" };
  models: { chat: string; embedding: string; pull: boolean };
  services: { mode: "docker" | "manual"; bind: "local" | "network"; apiPort: number; collabPort: number; publicUrl?: string };
  admin: { username: string; password: string; displayName?: string };
}

type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";
interface SetupJob {
  status: "running" | "done" | "failed";
  steps: { key: string; label: string; status: StepStatus; detail?: string }[];
  log: string[];
  error?: string;
  manualEnv?: string;
  appUrl?: string;
  startedAt: string;
}

let job: SetupJob | null = null;

export function getJob(): SetupJob | null {
  return job;
}

function validatePlan(plan: SetupPlan): void {
  const port = (value: unknown, label: string) => {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) throw new Error(`${label} 포트가 올바르지 않습니다.`);
  };
  if (plan.database.mode === "docker") port(plan.database.port, "DB");
  else if (!/^postgres(ql)?:\/\//.test(plan.database.url)) throw new Error("DB 주소는 postgresql:// 로 시작해야 합니다.");
  if (plan.ollama.mode === "external" && !/^https?:\/\//.test(plan.ollama.url)) throw new Error("Ollama 주소는 http(s):// 로 시작해야 합니다.");
  port(plan.services.apiPort, "웹/API");
  port(plan.services.collabPort, "협업");
  if (plan.services.apiPort === plan.services.collabPort) throw new Error("웹/API 와 협업 포트가 같습니다.");
  if (plan.services.publicUrl && !/^https?:\/\//.test(plan.services.publicUrl)) throw new Error("접속 주소는 http(s):// 로 시작해야 합니다.");
  if (!plan.admin.username || !plan.admin.password) throw new Error("첫 관리자 아이디와 비밀번호를 입력하세요.");
  if (plan.admin.password.length < 8) throw new Error("관리자 비밀번호는 8자 이상이어야 합니다.");
  const needsDocker = plan.database.mode === "docker" || plan.ollama.mode === "docker" || plan.services.mode === "docker";
  if (needsDocker && !dockerSocketPresent()) throw new Error("Docker 로 만들기를 고르려면 어드민에 Docker 소켓을 연결해야 합니다.");
}

export async function startInstall(plan: SetupPlan): Promise<SetupJob> {
  if (job?.status === "running") throw new Error("이미 설치가 진행 중입니다.");
  validatePlan(plan);
  const needsDocker = plan.database.mode === "docker" || plan.ollama.mode === "docker" || plan.services.mode === "docker";
  if (needsDocker) {
    // 소켓 권한까지 미리 확인해 설치 도중에 실패하지 않게 한다.
    await dockerInfo().catch((error) => {
      throw new Error(explainDockerError(error));
    });
  }
  const steps: SetupJob["steps"] = [
    { key: "database", label: plan.database.mode === "docker" ? "데이터베이스 만들기 (Docker)" : "데이터베이스 연결 확인", status: "pending" },
    {
      key: "ollama",
      label: plan.ollama.mode === "docker" ? "Ollama 만들기 (Docker)" : plan.ollama.mode === "external" ? "Ollama 연결 확인" : "Ollama (사용 안 함)",
      status: "pending",
    },
    { key: "models", label: "AI 모델 준비", status: "pending" },
    { key: "services", label: plan.services.mode === "docker" ? "Noty 서비스 시작 (Docker)" : "Noty 서비스 실행 대기 (직접 실행)", status: "pending" },
    { key: "finalize", label: "관리자 계정·AI 설정 저장", status: "pending" },
  ];
  job = { status: "running", steps, log: [], startedAt: new Date().toISOString() };
  void runInstall(plan, job);
  return job;
}

async function runInstall(plan: SetupPlan, current: SetupJob): Promise<void> {
  const log = (line: string) => {
    current.log.push(`[${new Date().toTimeString().slice(0, 8)}] ${line}`);
    if (current.log.length > 500) current.log.splice(0, current.log.length - 500);
  };
  const step = async (key: string, run: () => Promise<string | void>, skip = false) => {
    const target = current.steps.find((s) => s.key === key)!;
    if (skip) {
      target.status = "skipped";
      return;
    }
    target.status = "running";
    try {
      const detail = await run();
      target.status = "done";
      if (detail) target.detail = detail;
    } catch (error) {
      target.status = "failed";
      target.detail = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  // 다시 시도해도 같은 비밀값을 쓰도록, 진행 중인 설정이 있으면 이어서 쓴다.
  const pending = readInstallConfig();
  const secrets = {
    fileUrlSecret: pending?.secrets.fileUrlSecret || randomBytes(32).toString("hex"),
    postgresPassword: pending?.secrets.postgresPassword || randomBytes(24).toString("hex"),
    settingsKey: pending?.secrets.settingsKey || randomBytes(32).toString("hex"),
  };
  // 아래 주소들은 "어드민·서비스 컨테이너에서 닿는 주소"다.
  // host 방식은 서버의 127.0.0.1 그대로, bridge 방식은 Docker 네트워크 안의 컨테이너 이름이나 host.docker.internal.
  const databaseUrl =
    plan.database.mode === "docker"
      ? isBridge()
        ? `postgresql://noty:${secrets.postgresPassword}@${NAMES.db}:5432/noty`
        : `postgresql://noty:${secrets.postgresPassword}@127.0.0.1:${plan.database.port}/noty`
      : toContainerUrl(plan.database.url);
  const ollamaUrl =
    plan.ollama.mode === "external"
      ? toContainerUrl(plan.ollama.url.replace(/\/+$/, ""))
      : plan.ollama.mode === "docker" && isBridge()
        ? `http://${NAMES.ollama}:11434`
        : DEFAULT_OLLAMA_URL;
  const usesDocker = plan.database.mode === "docker" || plan.ollama.mode === "docker" || plan.services.mode === "docker";
  const config: NotyInstallConfig = {
    version: 1,
    database: { mode: plan.database.mode, url: databaseUrl, port: plan.database.mode === "docker" ? plan.database.port : undefined },
    ollama: { mode: plan.ollama.mode, url: plan.ollama.mode === "none" ? "" : ollamaUrl, gpu: plan.ollama.mode === "docker" ? plan.ollama.gpu : undefined },
    services: { ...plan.services },
    secrets: {
      fileUrlSecret: secrets.fileUrlSecret,
      postgresPassword: plan.database.mode === "docker" ? secrets.postgresPassword : undefined,
      settingsKey: secrets.settingsKey,
    },
  };
  writeInstallConfig(config);

  try {
    if (isBridge() && usesDocker) {
      await ensureNetwork(DOCKER_NETWORK);
      log(`Docker 네트워크 '${DOCKER_NETWORK}' 를 씁니다 (Docker Desktop 방식).`);
    }

    /* 1. 데이터베이스 */
    await step("database", async () => {
      if (plan.database.mode === "docker") {
        if (!(await imageExists(POSTGRES_IMAGE))) {
          log(`DB 이미지(${POSTGRES_IMAGE})를 빌드합니다. 처음 한 번은 몇 분 걸립니다.`);
          const dockerfile = readFileSync(path.join(REPO_ROOT, "docker/postgres/Dockerfile"));
          await buildImage(POSTGRES_IMAGE, createTar({ Dockerfile: dockerfile }), log);
        }
        await ensureVolume(VOLUMES.db);
        await replaceManagedContainer(NAMES.db, log);
        if (!isBridge() && !(await portFree(plan.database.port))) {
          throw new Error(`127.0.0.1:${plan.database.port} 포트를 이미 다른 프로그램이 쓰고 있습니다.`);
        }
        await runContainer({
          name: NAMES.db,
          image: POSTGRES_IMAGE,
          network: isBridge() ? DOCKER_NETWORK : undefined,
          env: { POSTGRES_USER: "noty", POSTGRES_PASSWORD: secrets.postgresPassword, POSTGRES_DB: "noty" },
          publish: [{ containerPort: 5432, hostPort: plan.database.port }],
          volumes: [{ volume: VOLUMES.db, target: "/var/lib/postgresql/data" }],
        });
        log("DB 컨테이너를 시작했습니다. 준비될 때까지 기다립니다…");
        await waitFor(async () => (await testDatabaseUrl(databaseUrl)).ok, 120_000, "DB 가 시간 안에 준비되지 않았습니다.", async () =>
          containerLogs(NAMES.db),
        );
        return `127.0.0.1:${plan.database.port}`;
      }
      const result = await testDatabaseUrl(databaseUrl);
      result.warnings.forEach((w) => log(`주의: ${w}`));
      if (!result.ok) throw new Error(result.message);
      log(result.message);
      return result.message;
    });

    /* 2. Ollama */
    await step(
      "ollama",
      async () => {
        if (plan.ollama.mode === "docker") {
          if (!isBridge() && !(await portFree(11434))) {
            throw new Error("11434 포트에 이미 Ollama(또는 다른 프로그램)가 있습니다. 'URL 로 연결'을 고르세요.");
          }
          if (!(await imageExists(OLLAMA_IMAGE))) {
            log(`Ollama 이미지(${OLLAMA_IMAGE})를 받습니다.`);
            await pullImage(OLLAMA_IMAGE, log);
          }
          await ensureVolume(VOLUMES.ollama);
          await replaceManagedContainer(NAMES.ollama, log);
          await runContainer({
            name: NAMES.ollama,
            image: OLLAMA_IMAGE,
            // host 방식: 서버 loopback 에만 연다. bridge 방식: 컨테이너 안에서는 모두에게 열고, 호스트에는 127.0.0.1 로만 공개한다.
            hostNetwork: !isBridge(),
            network: isBridge() ? DOCKER_NETWORK : undefined,
            publish: isBridge() ? [{ containerPort: 11434, hostPort: 11434 }] : undefined,
            env: { OLLAMA_HOST: isBridge() ? "0.0.0.0:11434" : "127.0.0.1:11434", OLLAMA_KEEP_ALIVE: "30m" },
            volumes: [{ volume: VOLUMES.ollama, target: "/root/.ollama" }],
            gpu: plan.ollama.gpu,
          });
          await waitFor(async () => (await testOllamaUrl(ollamaUrl)).ok, 60_000, "Ollama 가 시간 안에 응답하지 않았습니다.", async () =>
            containerLogs(NAMES.ollama),
          );
        }
        const result = await testOllamaUrl(ollamaUrl);
        if (!result.ok) throw new Error(result.message);
        log(result.message);
        return ollamaUrl;
      },
      plan.ollama.mode === "none",
    );

    /* 3. 모델 */
    await step(
      "models",
      async () => {
        const wanted = [plan.models.chat, plan.models.embedding].filter(Boolean);
        const tags = await fetchJson<{ models: { name: string }[] }>(`${ollamaUrl}/api/tags`);
        const have = new Set(tags.models.flatMap((m) => [m.name, m.name.replace(/:latest$/, "")]));
        const missing = wanted.filter((m) => !have.has(m) && !have.has(m.replace(/:latest$/, "")));
        if (missing.length === 0) return "필요한 모델이 이미 있습니다.";
        if (!plan.models.pull) throw new Error(`Ollama 에 모델이 없습니다: ${missing.join(", ")} ('모델 받기'를 켜거나 직접 받아 주세요)`);
        for (const model of missing) await pullOllamaModel(ollamaUrl, model, log);
        return `받음: ${missing.join(", ")}`;
      },
      plan.ollama.mode === "none",
    );

    /* 4. 서비스 */
    const host = plan.services.bind === "network" ? "0.0.0.0" : "127.0.0.1";
    const serviceEnv: Record<string, string> = {
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      FILE_URL_SECRET: secrets.fileUrlSecret,
      // DB 에 저장하는 API 키를 암호화하는 키. 어드민은 설치 설정 파일에서 같은 키를 읽는다.
      NOTY_SECRET_KEY: secrets.settingsKey,
      NOTY_DISABLE_BOOTSTRAP_ADMIN: "1",
      // 웹 화면은 같은 출처에서 열리고 Electron 은 따로 허용되므로, 접속 주소가 없으면 다른 출처는 막는다.
      CORS_ALLOWED_ORIGINS: plan.services.publicUrl?.replace(/\/+$/, "") || "same-origin",
      COLLAB_PORT: String(plan.services.collabPort),
    };
    const appUrl = plan.services.publicUrl || `http://${plan.services.bind === "network" ? "<서버 주소>" : "127.0.0.1"}:${plan.services.apiPort}`;
    current.appUrl = appUrl;
    await step("services", async () => {
      const healthUrl = isBridge()
        ? plan.services.mode === "docker"
          ? `http://${NAMES.api}:${plan.services.apiPort}/api/health`
          : `http://host.docker.internal:${plan.services.apiPort}/api/health`
        : `http://127.0.0.1:${plan.services.apiPort}/api/health`;
      if (plan.services.mode === "docker") {
        if (!(await imageExists(APP_IMAGE))) throw new Error(`앱 이미지(${APP_IMAGE})가 없습니다. 어드민을 띄운 이미지와 같은 이름이어야 합니다.`);
        await ensureVolume(VOLUMES.data);
        await replaceManagedContainer(NAMES.api, log);
        await replaceManagedContainer(NAMES.collab, log);
        if (!isBridge()) {
          for (const port of [plan.services.apiPort, plan.services.collabPort]) {
            if (!(await portFree(port))) throw new Error(`127.0.0.1:${port} 포트를 이미 다른 프로그램이 쓰고 있습니다.`);
          }
        }
        await runContainer({
          name: NAMES.api,
          image: APP_IMAGE,
          cmd: ["npx", "tsx", "apps/server/index.ts"],
          hostNetwork: !isBridge(),
          network: isBridge() ? DOCKER_NETWORK : undefined,
          // bridge: 컨테이너 안에서는 0.0.0.0, 호스트에는 고른 범위(127.0.0.1 또는 0.0.0.0)로 공개
          publish: isBridge() ? [{ containerPort: plan.services.apiPort, hostPort: plan.services.apiPort, hostIp: host }] : undefined,
          env: {
            ...serviceEnv,
            HOST: isBridge() ? "0.0.0.0" : host,
            PORT: String(plan.services.apiPort),
            ...(isBridge() ? { COLLAB_UPSTREAM_HOST: NAMES.collab } : {}),
          },
          volumes: [{ volume: VOLUMES.data, target: "/app/server-data" }],
        });
        await runContainer({
          name: NAMES.collab,
          image: APP_IMAGE,
          cmd: ["npx", "tsx", "apps/server/collaboration.ts"],
          hostNetwork: !isBridge(),
          network: isBridge() ? DOCKER_NETWORK : undefined,
          env: {
            ...serviceEnv,
            COLLAB_MODE: "single",
            // 협업 서버는 api 만 접속한다 (host: loopback, bridge: Docker 네트워크 안).
            COLLAB_HOST: isBridge() ? "0.0.0.0" : "127.0.0.1",
            COLLAB_INSTANCE_NAME: "noty-collab",
          },
        });
        log("api·collab 컨테이너를 시작했습니다. 첫 시작에서 DB 스키마를 만듭니다…");
        await waitFor(async () => (await fetch(healthUrl, { signal: AbortSignal.timeout(2000) })).ok, 180_000, "API 서버가 시간 안에 뜨지 않았습니다.", async () =>
          containerLogs(NAMES.api),
        );
        return appUrl;
      }
      current.manualEnv = [
        ...Object.entries({ ...serviceEnv, HOST: host, PORT: String(plan.services.apiPort), NOTY_WEB_DIST: "/app/apps/web/dist" }).map(([k, v]) => `${k}=${v}`),
        `# 협업 서버: COLLAB_HOST=127.0.0.1 COLLAB_PORT=${plan.services.collabPort} COLLAB_MODE=single`,
      ].join("\n");
      log(`아래 환경변수로 api·collab 을 실행해 주세요. ${healthUrl} 가 응답할 때까지 기다립니다 (최대 30분).`);
      await waitFor(async () => (await fetch(healthUrl, { signal: AbortSignal.timeout(2000) })).ok, 30 * 60_000, "API 서버가 30분 안에 응답하지 않았습니다.");
      return appUrl;
    });

    /* 5. 마무리 */
    await step("finalize", async () => {
      await reconfigureDatabase(databaseUrl);
      // 스키마는 api 가 시작하면서 만든다. users 테이블이 생길 때까지 기다린다.
      await waitFor(
        async () => Boolean((await pool.query("SELECT to_regclass('public.system_settings') AS t")).rows[0]?.t),
        120_000,
        "DB 스키마가 준비되지 않았습니다.",
      );
      await ensureUserColumns();
      const username = plan.admin.username.trim().toLowerCase();
      const existing = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [username]);
      let adminId: string;
      if (existing.rows[0]) {
        adminId = existing.rows[0].id;
        await resetManagedUserPassword(adminId, plan.admin.password);
        await updateManagedUser(adminId, { role: "admin", disabled: false });
        log(`기존 계정 '${username}' 을 관리자로 설정하고 비밀번호를 바꿨습니다.`);
      } else {
        adminId = (await createManagedUser({ username, displayName: plan.admin.displayName, password: plan.admin.password, role: "admin" })).id;
        log(`관리자 계정 '${username}' 을 만들었습니다.`);
      }
      if (plan.ollama.mode !== "none") {
        await saveSystemSettingsToDb(
          {
            ai: { provider: "ollama", model: plan.models.chat, baseUrl: ollamaUrl, apiKey: "" } as any,
            aiBackground: { mode: "same", digestEnabled: true } as any,
            embedding: { enabled: Boolean(plan.models.embedding), provider: "ollama", model: plan.models.embedding, baseUrl: ollamaUrl, apiKey: "" },
          },
          adminId,
        );
        log("AI 설정(채팅·위키 정리·임베딩)을 저장했습니다.");
      }
      writeInstallConfig({ ...config, installedAt: new Date().toISOString() });
      if (CONFIG_DIR) rmSync(path.join(CONFIG_DIR, "setup-code.txt"), { force: true });
      setupCode = null;
      log("설치가 끝났습니다. 설치 모드와 Docker 제어를 잠갔습니다.");
    });
    current.status = "done";
  } catch (error) {
    current.status = "failed";
    current.error = explainDockerError(error);
    const failedStep = current.steps.find((s) => s.status === "failed");
    if (failedStep) failedStep.detail = current.error;
    log(`실패: ${current.error}`);
  }
}

async function replaceManagedContainer(name: string, log: (line: string) => void): Promise<void> {
  const state = await inspectContainer(name);
  if (!state.exists) return;
  if (!state.managed) throw new Error(`'${name}' 이름의 컨테이너가 이미 있고 Noty 가 만든 것이 아닙니다. 지우거나 이름을 바꿔 주세요.`);
  log(`이전에 만든 ${name} 컨테이너를 다시 만듭니다. (데이터 볼륨은 유지)`);
  await removeContainer(name);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, message: string, diagnostics?: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // 아직 준비 안 됨
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const extra = diagnostics ? await diagnostics().catch(() => "") : "";
  throw new Error(extra ? `${message}\n--- 최근 로그 ---\n${extra}` : message);
}

async function pullOllamaModel(baseUrl: string, model: string, log: (line: string) => void): Promise<void> {
  log(`모델 ${model} 받는 중…`);
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`모델 ${model} 을 받지 못했습니다: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastPercent = -10;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const event = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
      if (event.error) throw new Error(`모델 ${model}: ${event.error}`);
      if (event.total && event.completed !== undefined) {
        const percent = Math.floor((event.completed / event.total) * 100);
        if (percent >= lastPercent + 10) {
          lastPercent = percent;
          log(`${model}: ${percent}% (${(event.total / 1e9).toFixed(1)} GB)`);
        }
      }
    }
  }
  log(`모델 ${model} 준비 완료`);
}
