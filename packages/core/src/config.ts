import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 설치 설정 파일 (NOTY_CONFIG_DIR/noty.config.json).
 *
 * 어드민의 설치 마법사가 만들고, 어드민이 다음 시작 때 읽는다.
 * 메인 API·협업 서버는 어드민이 컨테이너를 만들 때 넘겨주는 환경변수로 동작하므로 이 파일을 직접 읽지 않는다.
 * 환경변수(DATABASE_URL 등)가 있으면 항상 환경변수가 우선한다.
 */

export type DatabaseMode = "docker" | "external";
export type OllamaMode = "docker" | "external" | "none";
export type ServicesMode = "docker" | "manual";
export type BindScope = "local" | "network";

export interface NotyInstallConfig {
  version: 1;
  installedAt?: string;
  database: { mode: DatabaseMode; url: string; port?: number };
  ollama: { mode: OllamaMode; url: string; gpu?: boolean };
  services: {
    mode: ServicesMode;
    bind: BindScope;
    apiPort: number;
    collabPort: number;
    publicUrl?: string;
  };
  /** settingsKey: DB 에 저장하는 API 키 등을 암호화하는 키 (secret-box) */
  secrets: { fileUrlSecret: string; postgresPassword?: string; settingsKey?: string };
}

export const CONFIG_DIR = process.env.NOTY_CONFIG_DIR ? path.resolve(process.env.NOTY_CONFIG_DIR) : null;
const CONFIG_FILE = CONFIG_DIR ? path.join(CONFIG_DIR, "noty.config.json") : null;

export function readInstallConfig(): NotyInstallConfig | null {
  if (!CONFIG_FILE || !existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as NotyInstallConfig;
  } catch (error) {
    console.error("[config] 설정 파일을 읽지 못했습니다:", error);
    return null;
  }
}

export function writeInstallConfig(config: NotyInstallConfig): void {
  if (!CONFIG_DIR || !CONFIG_FILE) throw new Error("NOTY_CONFIG_DIR 이 설정되지 않아 설치 설정을 저장할 수 없습니다.");
  mkdirSync(CONFIG_DIR, { recursive: true });
  const temp = `${CONFIG_FILE}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, CONFIG_FILE);
  chmodSync(CONFIG_FILE, 0o600);
}

/** 설치가 끝났는지. 환경변수로 DB 를 직접 준 경우(개발, compose 수동 배포)는 설치된 것으로 본다. */
export function isInstalled(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!CONFIG_DIR) return true; // 설정 폴더를 쓰지 않는 실행(개발)은 마법사 없이 기본 DB 로 동작
  return Boolean(readInstallConfig()?.installedAt);
}
