import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 저장소 기준 경로. 앱이 어느 폴더(apps/*)에 있든 데이터 위치는 여기서 한 번만 정한다.
 *   REPO_ROOT          packages/core/src → ../../..
 *   DATA_DIR           NOTY_DATA_DIR 또는 <저장소>/server-data
 *   DEFAULT_UPLOADS_DIR NOTY_UPLOADS_DIR 또는 DATA_DIR/uploads (어드민의 스토리지 설정이 있으면 그쪽이 우선)
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DATA_DIR = path.resolve(process.env.NOTY_DATA_DIR || path.join(REPO_ROOT, "server-data"));
export const DEFAULT_UPLOADS_DIR = path.resolve(process.env.NOTY_UPLOADS_DIR || path.join(DATA_DIR, "uploads"));
