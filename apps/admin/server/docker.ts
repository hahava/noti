import { existsSync } from "node:fs";
import http from "node:http";

/**
 * 설치 마법사가 쓰는 최소한의 Docker Engine API 클라이언트 (/var/run/docker.sock).
 * 외부 라이브러리 없이 필요한 호출만 한다: 확인, 이미지 받기/빌드, 볼륨, 컨테이너 만들기/시작/삭제.
 */

const SOCKET_PATH = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const API = "/v1.41";
export const MANAGED_LABEL = "dev.noty.managed";

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

type RequestOptions = { method?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string>; timeoutMs?: number };

function request(path: string, options: RequestOptions = {}): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = options.raw ?? (options.body !== undefined ? Buffer.from(JSON.stringify(options.body)) : undefined);
    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path: `${API}${path}`,
        method: options.method || "GET",
        headers: {
          ...(payload ? { "Content-Length": String(payload.length) } : {}),
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        timeout: options.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Docker 요청 시간이 초과되었습니다.")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function json<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { status, body } = await request(path, options);
  const text = body.toString("utf8");
  if (status >= 400) {
    let message = text;
    try {
      message = JSON.parse(text).message || text;
    } catch {
      // 그대로
    }
    throw new DockerError(message.trim() || `Docker API ${status}`, status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** 줄 단위 JSON 진행 상황을 내보내는 요청 (이미지 받기·빌드). */
function streamRequest(path: string, options: RequestOptions, onEvent: (event: Record<string, any>) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = options.raw;
    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path: `${API}${path}`,
        method: options.method || "POST",
        headers: { ...(payload ? { "Content-Length": String(payload.length) } : {}), ...options.headers },
      },
      (res) => {
        let buffer = "";
        let failure: string | null = null;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            try {
              const event = JSON.parse(line);
              if (event.error || event.errorDetail) failure = event.error || event.errorDetail?.message;
              onEvent(event);
            } catch {
              onEvent({ stream: line });
            }
          }
        });
        res.on("end", () => {
          if ((res.statusCode || 0) >= 400) return reject(new DockerError(failure || buffer || `Docker API ${res.statusCode}`, res.statusCode));
          if (failure) return reject(new DockerError(failure));
          resolve();
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function dockerSocketPresent(): boolean {
  return existsSync(SOCKET_PATH);
}

/** 소켓 권한 오류를 사람이 고칠 수 있는 안내로 바꾼다. */
export function explainDockerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/EACCES/.test(message)) {
    return `어드민이 Docker 소켓(${SOCKET_PATH})에 접근할 권한이 없습니다. 어드민 컨테이너를 --group-add $(stat -c %g ${SOCKET_PATH}) 로 실행하세요 (deploy/install.sh 가 해 줍니다).`;
  }
  if (/ENOENT|ECONNREFUSED/.test(message)) return `Docker 에 연결할 수 없습니다 (${SOCKET_PATH}). Docker 가 실행 중인지 확인하세요.`;
  const portInUse = message.match(/(?:listen tcp\d?\s+)?([\d.]+|\[[^\]]+\]):(\d+): bind: address already in use/);
  if (portInUse) {
    return `이 컴퓨터의 ${portInUse[2]} 포트를 이미 다른 프로그램(또는 다른 컨테이너)이 쓰고 있습니다. 그 프로그램을 끄거나, 설치 마법사에서 다른 포트를 고른 뒤 다시 시도하세요.`;
  }
  return message;
}

export async function dockerInfo(): Promise<{ version: string; gpu: boolean; os: string }> {
  const [version, info] = await Promise.all([
    json<{ Version: string }>("/version", { timeoutMs: 5000 }),
    json<{ Runtimes?: Record<string, unknown>; OperatingSystem?: string }>("/info", { timeoutMs: 5000 }),
  ]);
  return { version: version.Version, gpu: Boolean(info.Runtimes && "nvidia" in info.Runtimes), os: info.OperatingSystem || "" };
}

export async function imageExists(image: string): Promise<boolean> {
  const { status } = await request(`/images/${encodeURIComponent(image)}/json`);
  return status === 200;
}

export async function pullImage(image: string, onProgress: (line: string) => void): Promise<void> {
  const [name, tag = "latest"] = image.split(/:(?=[^/:]+$)/);
  let lastStatus = "";
  await streamRequest(`/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`, { method: "POST" }, (event) => {
    // 레이어별 진행률 줄은 너무 많아 상태가 바뀔 때만 남긴다.
    if (event.status && event.status !== lastStatus && !event.progress) onProgress(`${event.id ? `${event.id}: ` : ""}${event.status}`);
    lastStatus = event.status || lastStatus;
  });
}

/** 파일 몇 개로 이루어진 빌드 컨텍스트를 tar 로 묶는다 (ustar, 디렉터리 없음). */
export function createTar(files: Record<string, Buffer | string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136);
    header.write("        ", 148); // 체크섬 계산용 공백
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export async function buildImage(tag: string, context: Buffer, onProgress: (line: string) => void): Promise<void> {
  await streamRequest(
    `/build?t=${encodeURIComponent(tag)}&rm=1&forcerm=1`,
    { method: "POST", raw: context, headers: { "Content-Type": "application/x-tar" } },
    (event) => {
      const line = String(event.stream || event.status || "").trim();
      if (line && !line.startsWith("--->")) onProgress(line);
    },
  );
}

export async function ensureVolume(name: string): Promise<void> {
  await json("/volumes/create", { method: "POST", body: { Name: name, Labels: { [MANAGED_LABEL]: "true" } } });
}

export type ContainerState = { exists: boolean; running: boolean; status?: string; image?: string; managed?: boolean };

export async function inspectContainer(name: string): Promise<ContainerState> {
  const { status, body } = await request(`/containers/${encodeURIComponent(name)}/json`);
  if (status === 404) return { exists: false, running: false };
  if (status >= 400) throw new DockerError(body.toString("utf8"), status);
  const data = JSON.parse(body.toString("utf8"));
  return {
    exists: true,
    running: Boolean(data.State?.Running),
    status: data.State?.Status,
    image: data.Config?.Image,
    managed: data.Config?.Labels?.[MANAGED_LABEL] === "true",
  };
}

export async function removeContainer(name: string): Promise<void> {
  const { status, body } = await request(`/containers/${encodeURIComponent(name)}?force=true`, { method: "DELETE" });
  if (status >= 400 && status !== 404) throw new DockerError(body.toString("utf8"), status);
}

export type ContainerSpec = {
  name: string;
  image: string;
  cmd?: string[];
  env?: Record<string, string>;
  hostNetwork?: boolean;
  /** host 네트워크가 아닐 때 붙을 Docker 네트워크 이름 (같은 네트워크의 컨테이너끼리 이름으로 찾는다) */
  network?: string;
  /** 컨테이너 포트 → 호스트 포트 (기본 127.0.0.1, host 네트워크가 아닐 때) */
  publish?: { containerPort: number; hostPort: number; hostIp?: string }[];
  volumes?: { volume: string; target: string }[];
  gpu?: boolean;
};

export async function runContainer(spec: ContainerSpec): Promise<void> {
  const exposed: Record<string, object> = {};
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const port of spec.publish || []) {
    exposed[`${port.containerPort}/tcp`] = {};
    bindings[`${port.containerPort}/tcp`] = [{ HostIp: port.hostIp || "127.0.0.1", HostPort: String(port.hostPort) }];
  }
  const body = {
    Image: spec.image,
    Cmd: spec.cmd,
    Env: Object.entries(spec.env || {}).map(([key, value]) => `${key}=${value}`),
    Labels: { [MANAGED_LABEL]: "true" },
    ExposedPorts: spec.hostNetwork ? undefined : exposed,
    HostConfig: {
      NetworkMode: spec.hostNetwork ? "host" : spec.network || "bridge",
      PortBindings: spec.hostNetwork ? undefined : bindings,
      // Linux 의 bridge 에서도 host.docker.internal 로 호스트에 닿게 한다 (Docker Desktop 은 원래 된다).
      ExtraHosts: spec.hostNetwork ? undefined : ["host.docker.internal:host-gateway"],
      RestartPolicy: { Name: "unless-stopped" },
      Mounts: (spec.volumes || []).map((v) => ({ Type: "volume", Source: v.volume, Target: v.target })),
      DeviceRequests: spec.gpu ? [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }] : undefined,
    },
  };
  await json(`/containers/create?name=${encodeURIComponent(spec.name)}`, { method: "POST", body });
  const { status, body: startBody } = await request(`/containers/${encodeURIComponent(spec.name)}/start`, { method: "POST" });
  if (status >= 400) throw new DockerError(startBody.toString("utf8"), status);
}

/** 실행 중인 컨테이너와 호스트에 공개한 포트 */
export async function listPublishedPorts(): Promise<{ name: string; managed: boolean; ports: number[] }[]> {
  const list = await json<{ Names?: string[]; Labels?: Record<string, string>; Ports?: { PublicPort?: number }[] }[]>("/containers/json");
  return list.map((c) => ({
    name: (c.Names?.[0] ?? "").replace(/^\//, ""),
    managed: c.Labels?.[MANAGED_LABEL] === "true",
    ports: [...new Set((c.Ports ?? []).map((p) => p.PublicPort).filter((p): p is number => typeof p === "number"))],
  }));
}

export async function ensureNetwork(name: string): Promise<void> {
  const { status } = await request(`/networks/${encodeURIComponent(name)}`);
  if (status === 200) return;
  await json("/networks/create", { method: "POST", body: { Name: name, Labels: { [MANAGED_LABEL]: "true" } } });
}

export async function containerLogs(name: string, tail = 30): Promise<string> {
  const { body } = await request(`/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&tail=${tail}`);
  // 다중화 스트림 헤더(8바이트)를 걷어낸다.
  const out: string[] = [];
  let offset = 0;
  while (offset + 8 <= body.length) {
    const size = body.readUInt32BE(offset + 4);
    out.push(body.subarray(offset + 8, offset + 8 + size).toString("utf8"));
    offset += 8 + size;
  }
  return (out.join("") || body.toString("utf8")).trim();
}
