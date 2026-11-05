export type CollaborationMode = "single" | "distributed";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

const configuredMode = process.env.COLLAB_MODE;
if (configuredMode && configuredMode !== "single" && configuredMode !== "distributed") {
  throw new Error('COLLAB_MODE must be either "single" or "distributed"');
}

const redisUrl = process.env.REDIS_URL?.trim() || undefined;
export const collaborationMode: CollaborationMode =
  (configuredMode as CollaborationMode | undefined) ||
  (redisUrl ? "distributed" : "single");

if (collaborationMode === "distributed" && !redisUrl) {
  throw new Error("COLLAB_MODE=distributed requires REDIS_URL");
}

if (collaborationMode === "single" && configuredMode === "single" && redisUrl) {
  throw new Error("COLLAB_MODE=single cannot be used with REDIS_URL");
}

export const collaborationConfig = {
  mode: collaborationMode,
  host: process.env.COLLAB_HOST || "127.0.0.1",
  port: positiveInteger(process.env.COLLAB_PORT, 4001),
  instanceName:
    process.env.COLLAB_INSTANCE_NAME || `noty-collab-${process.pid}`,
  redisUrl: collaborationMode === "distributed" ? redisUrl : undefined,
  redisPrefix: process.env.COLLAB_REDIS_PREFIX || "noty:collaboration",
  debounce: positiveInteger(process.env.COLLAB_STORE_DEBOUNCE_MS, 2000),
  maxDebounce: positiveInteger(process.env.COLLAB_STORE_MAX_DEBOUNCE_MS, 10000),
};
