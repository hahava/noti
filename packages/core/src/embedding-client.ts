import type { EmbeddingSystemSettings } from "./settings.js";

/**
 * 임베딩 API 호출 (Ollama / OpenAI / Gemini / OpenAI 호환).
 * 메인 서버의 인덱서와 어드민 서버의 연결 테스트가 함께 쓴다.
 */

const REQUEST_TIMEOUT_MS = 60_000;

export function embeddingModelKey(settings: Pick<EmbeddingSystemSettings, "provider" | "model">): string {
  return `${settings.provider}:${settings.model.trim()}`;
}


/* --------------------------------------------------------------------------
 * 임베딩 API 호출
 * ------------------------------------------------------------------------ */

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const detail = data?.error?.message || data?.error || text.slice(0, 300) || res.statusText;
      throw new Error(`임베딩 API 오류 (HTTP ${res.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }
    return data;
  } catch (error: any) {
    if (error?.name === "AbortError") throw new Error("임베딩 API 응답 시간이 초과되었습니다.");
    if (isConnectionError(error)) {
      throw new Error(`임베딩 엔드포인트(${url})에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function embedTexts(settings: EmbeddingSystemSettings, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = settings.model.trim();
  if (!model) throw new Error("임베딩 모델이 설정되지 않았습니다.");
  const defaultBase = settings.provider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1";
  const baseUrl = (settings.baseUrl || defaultBase).replace(/\/+$/, "");

  let vectors: unknown;
  if (settings.provider === "ollama") {
    const data = await postJson(`${baseUrl}/api/embed`, { model, input: texts }, {});
    vectors = data?.embeddings;
  } else if (settings.provider === "gemini") {
    if (!settings.apiKey) throw new Error("Gemini API 키가 설정되지 않았습니다.");
    const geminiBase = (settings.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const modelPath = model.startsWith("models/") ? model : `models/${model}`;
    const data = await postJson(
      `${geminiBase}/${modelPath}:batchEmbedContents`,
      { requests: texts.map((text) => ({ model: modelPath, content: { parts: [{ text }] } })) },
      { "x-goog-api-key": settings.apiKey },
    );
    vectors = Array.isArray(data?.embeddings) ? data.embeddings.map((item: any) => item?.values) : undefined;
  } else {
    if (settings.provider === "openai" && !settings.apiKey) throw new Error("OpenAI API 키가 설정되지 않았습니다.");
    const data = await postJson(
      `${baseUrl}/embeddings`,
      { model, input: texts },
      settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
    );
    vectors = Array.isArray(data?.data)
      ? [...data.data].sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0)).map((item: any) => item.embedding)
      : undefined;
  }

  if (
    !Array.isArray(vectors) ||
    vectors.length !== texts.length ||
    !vectors.every((v) => Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "number"))
  ) {
    throw new Error("임베딩 API 응답 형식이 올바르지 않습니다. 임베딩 전용 모델인지 확인해 주세요.");
  }
  return vectors as number[][];
}

export async function testEmbeddingConnection(
  settings: EmbeddingSystemSettings,
): Promise<{ ok: boolean; message: string; dims?: number; latencyMs?: number }> {
  const start = Date.now();
  try {
    const [vector] = await embedTexts(settings, ["연결 테스트"]);
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      message: `임베딩 연결 성공 (${latencyMs}ms). '${settings.model}' 모델, ${vector.length}차원.`,
      dims: vector.length,
      latencyMs,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "임베딩 연결 테스트에 실패했습니다." };
  }
}

/** Node fetch 의 연결 실패는 "fetch failed" 로만 나오므로 원인 코드를 확인한다. */
function isConnectionError(error: any): boolean {
  const codes = [error?.cause?.code, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors.map((e: any) => e?.code) : [])];
  return (
    codes.some((code) => ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "EAI_AGAIN"].includes(code)) ||
    (error instanceof TypeError && error.message === "fetch failed")
  );
}
