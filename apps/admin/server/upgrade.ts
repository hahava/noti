import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, readInstallConfig } from "@noty/core/config";
import {
  MANAGED_LABEL,
  containerLogs,
  createContainerRaw,
  dockerSocketPresent,
  execToFile,
  explainDockerError,
  inspectContainerRaw,
  inspectImage,
  pullImage,
  removeContainer,
  renameContainer,
  startContainer,
  stopContainer,
} from "./docker.js";
import { APP_IMAGE, NAMES, NETWORK_MODE, waitFor } from "./setup.js";

/**
 * 어드민 화면에서 하는 업데이트.
 *
 * 1. (선택) DB 백업: Docker 로 만든 DB 면 pg_dump 결과를 설정 볼륨(backups/)에 남긴다.
 * 2. 고른 버전의 이미지를 받는다 (ghcr.io/<계정>/noty:<버전>). :latest 는 쓰지 않아 되돌릴 수 있다.
 * 3. api → collab 순서로 컨테이너를 같은 설정·새 이미지로 바꾼다. 새 컨테이너가 뜨지 않으면 이전 컨테이너로 되돌린다.
 *    DB 스키마는 새 api 가 시작하면서 맞춘다 (추가만 하는 방식이라 이전 버전으로 되돌려도 동작한다).
 * 4. 마지막으로 잠깐 도는 보조 컨테이너가 어드민 자신을 새 이미지로 바꾼다 (실행 중인 컨테이너는 자기를 못 바꾼다).
 *
 * admin 역할로 로그인한 경우에만 부를 수 있고, 이미지 저장소는 어드민을 띄운 이미지(NOTY_APP_IMAGE)로 고정된다.
 */

export const ADMIN_CONTAINER = process.env.NOTY_ADMIN_CONTAINER || "noty-admin";
const RELEASES_REPO = process.env.NOTY_RELEASES_REPO || "hahava/noti";
const BACKUP_DIR = CONFIG_DIR ? path.join(CONFIG_DIR, "backups") : null;
const STATE_FILE = CONFIG_DIR ? path.join(CONFIG_DIR, "upgrade-state.json") : null;
const BACKUP_KEEP = 5;
const VERSION_LABEL = "org.opencontainers.image.version";
const SEMVER = /^\d+\.\d+\.\d+$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/* ------------------------------------------------------------------ 버전 */

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** ghcr.io/hahava/noty:latest → { registry, repo, tag }. 레지스트리 주소가 없는 이미지(소스 빌드)는 null */
export function parseImageRef(image: string): { registry: string; repo: string; tag: string } | null {
  const match = image.match(/^([^/]+\.[^/]+|[^/]+:\d+)\/([^:@]+)(?::([^:@/]+))?$/);
  return match ? { registry: match[1], repo: match[2], tag: match[3] || "latest" } : null;
}

const IMAGE_REF = parseImageRef(APP_IMAGE);

function packageVersion(): string | null {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** 컨테이너가 돌리는 이미지의 버전: 이미지 라벨 → 태그 순서로 찾는다 */
async function containerVersion(name: string): Promise<string | null> {
  const container = await inspectContainerRaw(name).catch(() => null);
  if (!container) return null;
  const image = await inspectImage(container.Image).catch(() => null);
  const label = image?.Config?.Labels?.[VERSION_LABEL];
  if (typeof label === "string" && SEMVER.test(label)) return label;
  const tag = parseImageRef(container.Config?.Image ?? "")?.tag;
  return tag && SEMVER.test(tag) ? tag : null;
}

interface ReleaseNote {
  version: string;
  name: string;
  body: string;
  url: string;
  publishedAt: string;
}

// GitHub·레지스트리 조회는 10분 동안 재사용한다 (GitHub 비로그인 호출 한도: 시간당 60회)
let remoteCache: { at: number; versions: string[]; notes: ReleaseNote[]; error: string | null } | null = null;

async function fetchRemote(force: boolean) {
  if (!force && remoteCache && Date.now() - remoteCache.at < 10 * 60_000) return remoteCache;
  let versions: string[] = [];
  let notes: ReleaseNote[] = [];
  let error: string | null = null;
  if (IMAGE_REF?.registry === "ghcr.io") {
    try {
      const tokenRes = await fetch(`https://ghcr.io/token?scope=repository:${IMAGE_REF.repo}:pull&service=ghcr.io`, {
        signal: AbortSignal.timeout(8000),
      });
      const { token } = (await tokenRes.json()) as { token?: string };
      const tagsRes = await fetch(`https://ghcr.io/v2/${IMAGE_REF.repo}/tags/list?n=1000`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (!tagsRes.ok) throw new Error(`이미지 저장소 응답 ${tagsRes.status}`);
      const { tags } = (await tagsRes.json()) as { tags?: string[] };
      versions = (tags ?? []).filter((tag) => SEMVER.test(tag)).sort((a, b) => compareVersions(b, a));
    } catch (err) {
      error = `새 버전을 확인하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "noty-admin" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const list = (await res.json()) as { tag_name: string; name: string | null; body: string | null; html_url: string; published_at: string }[];
      notes = list
        .map((r) => ({ version: r.tag_name.replace(/^v/, ""), name: r.name || r.tag_name, body: r.body || "", url: r.html_url, publishedAt: r.published_at }))
        .filter((r) => SEMVER.test(r.version));
    }
  } catch {
    // 변경 사항은 없어도 업데이트할 수 있다
  }
  remoteCache = { at: Date.now(), versions, notes, error };
  return remoteCache;
}

/* ------------------------------------------------------------------ 상태 */

interface UpgradeState {
  from: string | null;
  to: string;
  at: string;
}

function readState(): UpgradeState | null {
  if (!STATE_FILE) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function listBackups(): string[] {
  if (!BACKUP_DIR) return [];
  try {
    return readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".dump")).sort().reverse();
  } catch {
    return [];
  }
}

type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";

interface UpgradeJob {
  status: "running" | "done" | "failed";
  targetVersion: string;
  steps: { key: string; label: string; status: StepStatus; detail?: string }[];
  log: string[];
  error?: string;
  startedAt: string;
}

let job: UpgradeJob | null = null;

function unsupportedReason(): string | null {
  if (!dockerSocketPresent()) return "어드민에 Docker 소켓이 연결되어 있지 않아 화면에서 업데이트할 수 없습니다.";
  if (readInstallConfig()?.services.mode !== "docker") return "Noty 서비스를 직접 실행하는 설치입니다. 서비스를 새 버전으로 직접 바꿔 주세요.";
  if (IMAGE_REF?.registry !== "ghcr.io") {
    return `소스로 빌드한 이미지(${APP_IMAGE})로 설치되어 있습니다. 배포 이미지(ghcr.io)로 설치한 경우에만 화면에서 업데이트할 수 있습니다.`;
  }
  return null;
}

export async function getUpgradeInfo(force = false) {
  const reason = unsupportedReason();
  const [current, adminVersion, remote] = await Promise.all([
    containerVersion(NAMES.api),
    containerVersion(ADMIN_CONTAINER),
    reason ? Promise.resolve(null) : fetchRemote(force),
  ]);
  const currentVersion = current ?? packageVersion();
  const versions = remote?.versions ?? [];
  return {
    supported: !reason,
    reason,
    currentVersion,
    adminVersion: adminVersion ?? packageVersion(),
    latestVersion: versions[0] ?? null,
    versions,
    notes: remote?.notes ?? [],
    checkError: remote?.error ?? null,
    lastUpgrade: readState(),
    backups: listBackups(),
    databaseBackup: readInstallConfig()?.database.mode === "docker",
    job,
  };
}

/* ------------------------------------------------------------------ 컨테이너 교체 */

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 기존 컨테이너 설정으로 새 이미지 컨테이너를 만들 요청 본문.
 * 이전 이미지에서 물려받은 값(환경변수 PATH 등, 라벨, 기본 명령)은 빼서 새 이미지의 값을 쓰게 한다.
 */
export function buildReplacementBody(
  container: Record<string, any>,
  oldImage: Record<string, any> | null,
  image: string,
  envOverrides: Record<string, string> = {},
): Record<string, unknown> {
  const config = container.Config ?? {};
  const imageConfig = oldImage?.Config ?? {};
  const imageEnv = new Set<string>(imageConfig.Env ?? []);
  const env: string[] = (config.Env ?? []).filter((entry: string) => !imageEnv.has(entry));
  for (const [key, value] of Object.entries(envOverrides)) {
    const index = env.findIndex((entry) => entry.startsWith(`${key}=`));
    if (index >= 0) env[index] = `${key}=${value}`;
    else env.push(`${key}=${value}`);
  }
  const imageLabels: Record<string, string> = imageConfig.Labels ?? {};
  const labels = Object.fromEntries(Object.entries(config.Labels ?? {}).filter(([key, value]) => imageLabels[key] !== value));
  const own = <K extends string>(key: K) => (sameJson(config[key], imageConfig[key]) ? undefined : config[key]);
  return {
    Image: image,
    Env: env,
    Cmd: own("Cmd"),
    Entrypoint: own("Entrypoint"),
    User: own("User"),
    WorkingDir: own("WorkingDir"),
    Labels: labels,
    ExposedPorts: config.ExposedPorts,
    HostConfig: container.HostConfig,
  };
}

/**
 * 컨테이너를 새 이미지로 바꾼다. 이전 컨테이너는 이름만 바꿔 멈춰 두었다가,
 * 새 컨테이너가 healthy 확인을 통과하면 지우고 실패하면 다시 살린다.
 */
export async function replaceContainer(
  name: string,
  image: string,
  healthy: () => Promise<void>,
  log: (line: string) => void,
  envOverrides: Record<string, string> = {},
): Promise<void> {
  const container = await inspectContainerRaw(name);
  if (!container) throw new Error(`${name} 컨테이너가 없습니다.`);
  if (container.Config?.Labels?.[MANAGED_LABEL] !== "true") throw new Error(`${name} 은(는) Noty 가 만든 컨테이너가 아닙니다.`);
  const oldImage = await inspectImage(container.Image);
  const body = buildReplacementBody(container, oldImage, image, envOverrides);
  const previous = `${name}-previous`;
  await removeContainer(previous);
  log(`${name}: 이전 컨테이너를 멈추고 새 이미지로 시작합니다.`);
  await stopContainer(name);
  await renameContainer(name, previous);
  try {
    await createContainerRaw(name, body);
    await startContainer(name);
    await healthy();
  } catch (error) {
    log(`${name}: 새 컨테이너가 정상적으로 뜨지 않아 이전 컨테이너로 되돌립니다.`);
    await removeContainer(name).catch(() => undefined);
    await renameContainer(previous, name);
    await startContainer(name);
    throw error;
  }
  await removeContainer(previous);
  log(`${name}: 새 버전으로 바꿨습니다.`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 헬스 체크가 없는 컨테이너: 몇 초 뒤에도 재시작 없이 돌고 있으면 정상으로 본다 */
export async function staysRunning(name: string, ms = 8000): Promise<void> {
  await sleep(ms);
  const state = (await inspectContainerRaw(name))?.State;
  if (!state?.Running || state.Restarting || (state.RestartCount ?? 0) > 0) {
    const logs = await containerLogs(name).catch(() => "");
    throw new Error(`${name} 이(가) 시작 직후 멈췄습니다.${logs ? `\n--- 최근 로그 ---\n${logs}` : ""}`);
  }
}

/* ------------------------------------------------------------------ 업데이트 실행 */

export async function startUpgrade(version: string, backup: boolean): Promise<UpgradeJob> {
  if (job?.status === "running") throw new Error("이미 업데이트가 진행 중입니다.");
  const reason = unsupportedReason();
  if (reason) throw new Error(reason);
  if (!SEMVER.test(version)) throw new Error("버전 형식이 올바르지 않습니다 (예: 1.2.0).");
  const remote = await fetchRemote(false);
  if (remote.versions.length > 0 && !remote.versions.includes(version)) throw new Error(`이미지 저장소에 ${version} 버전이 없습니다.`);
  const doBackup = backup && readInstallConfig()?.database.mode === "docker" && Boolean(BACKUP_DIR);
  job = {
    status: "running",
    targetVersion: version,
    startedAt: new Date().toISOString(),
    log: [],
    steps: [
      { key: "backup", label: "데이터베이스 백업", status: doBackup ? "pending" : "skipped" },
      { key: "pull", label: `이미지 받기 (${version})`, status: "pending" },
      { key: "api", label: "웹·API 서버 교체", status: "pending" },
      { key: "collab", label: "실시간 협업 서버 교체", status: "pending" },
      { key: "admin", label: "어드민 교체 (잠시 연결이 끊깁니다)", status: "pending" },
    ],
  };
  if (!doBackup) {
    job.steps[0].detail = backup ? "외부 DB 는 화면에서 백업하지 않습니다. 직접 백업해 주세요." : "건너뜀";
  }
  void runUpgrade(job, doBackup);
  return job;
}

async function runUpgrade(current: UpgradeJob, doBackup: boolean): Promise<void> {
  const log = (line: string) => {
    current.log.push(`[${new Date().toTimeString().slice(0, 8)}] ${line}`);
    if (current.log.length > 500) current.log.splice(0, current.log.length - 500);
  };
  const step = async (key: string, run: () => Promise<string | void>) => {
    const target = current.steps.find((s) => s.key === key)!;
    if (target.status === "skipped") return;
    target.status = "running";
    try {
      const detail = await run();
      target.status = "done";
      if (detail) target.detail = detail;
    } catch (error) {
      target.status = "failed";
      target.detail = explainDockerError(error);
      throw error;
    }
  };

  const version = current.targetVersion;
  const image = `${IMAGE_REF!.registry}/${IMAGE_REF!.repo}:${version}`;
  const from = await containerVersion(NAMES.api);
  const config = readInstallConfig()!;
  const apiHealthUrl =
    NETWORK_MODE === "bridge"
      ? `http://${NAMES.api}:${config.services.apiPort}/api/health`
      : `http://127.0.0.1:${config.services.apiPort}/api/health`;

  try {
    await step("backup", async () => {
      mkdirSync(BACKUP_DIR!, { recursive: true });
      const file = path.join(BACKUP_DIR!, `noty-${new Date().toISOString().replace(/[:.]/g, "-")}-from-${from ?? "unknown"}.dump`);
      log("pg_dump 로 DB 를 백업합니다…");
      await execToFile(NAMES.db, ["pg_dump", "-U", "noty", "-d", "noty", "-Fc"], file);
      for (const old of listBackups().slice(BACKUP_KEEP)) rmSync(path.join(BACKUP_DIR!, old), { force: true });
      return path.basename(file);
    });

    await step("pull", async () => {
      log(`${image} 받는 중…`);
      await pullImage(image, log);
    });

    await step("api", () =>
      replaceContainer(
        NAMES.api,
        image,
        () =>
          waitFor(
            async () => (await fetch(apiHealthUrl, { signal: AbortSignal.timeout(2000) })).ok,
            180_000,
            "새 API 서버가 시간 안에 응답하지 않았습니다.",
            () => containerLogs(NAMES.api),
          ),
        log,
      ),
    );

    await step("collab", () => replaceContainer(NAMES.collab, image, () => staysRunning(NAMES.collab), log));

    if (STATE_FILE) writeFileSync(STATE_FILE, `${JSON.stringify({ from, to: version, at: new Date().toISOString() })}\n`, { mode: 0o600 });

    await step("admin", async () => {
      const admin = await inspectContainerRaw(ADMIN_CONTAINER);
      if (!admin) return `어드민 컨테이너(${ADMIN_CONTAINER})를 찾지 못해 어드민은 그대로 둡니다.`;
      const updater = `${ADMIN_CONTAINER}-updater`;
      await removeContainer(updater);
      await createContainerRaw(updater, {
        Image: image,
        Cmd: ["npx", "tsx", "apps/admin/server/self-update.ts"],
        Env: [`NOTY_ADMIN_CONTAINER=${ADMIN_CONTAINER}`, `NOTY_UPDATE_IMAGE=${image}`, `NOTY_DOCKER_NETWORK=${NETWORK_MODE}`],
        User: admin.Config?.User || undefined,
        Labels: { [MANAGED_LABEL]: "true" },
        HostConfig: {
          // 어드민과 같은 Docker 소켓·권한만 빌려 쓰고, 네트워크는 필요 없다.
          Binds: admin.HostConfig?.Binds,
          GroupAdd: admin.HostConfig?.GroupAdd,
          NetworkMode: "none",
          AutoRemove: true,
        },
      });
      await startContainer(updater);
      log("보조 컨테이너가 어드민을 새 버전으로 바꿉니다. 잠시 후 화면이 다시 연결됩니다.");
    });
    current.status = "done";
    log(`${version} 업데이트를 마쳤습니다.`);
  } catch (error) {
    current.status = "failed";
    current.error = explainDockerError(error);
    log(`실패: ${current.error}`);
  }
}
