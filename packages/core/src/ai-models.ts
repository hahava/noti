/**
 * 업체별 모델 목록 조회 (설정 화면의 모델 드롭다운용).
 * 키는 서버에서만 쓰고, 클라이언트에는 모델 id/이름만 돌려준다.
 */

export type ModelVendor = "openai" | "anthropic" | "ollama" | "gemini" | "custom";
export type ModelPurpose = "chat" | "embedding";

export interface ModelInfo {
  id: string;
  /** 사람이 읽는 이름 (없으면 id) */
  label?: string;
  /** 부가 정보: 파라미터 크기, 차원 등 */
  detail?: string;
}

export interface ModelListResult {
  models: ModelInfo[];
  /** 목록을 못 가져왔거나 해당 용도의 모델이 없을 때 안내 */
  message?: string;
}

const REQUEST_TIMEOUT_MS = 8000;

export const DEFAULT_VENDOR_BASE_URLS: Record<ModelVendor, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  ollama: "http://127.0.0.1:11434",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  custom: "",
};

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("API 키 인증에 실패했습니다. 키를 확인해 주세요.");
      const detail = data?.error?.message || data?.error || text.slice(0, 200) || res.statusText;
      throw new Error(`모델 목록 조회 실패 (HTTP ${res.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }
    return data;
  } catch (error: any) {
    if (error?.name === "AbortError") throw new Error("모델 목록 조회 시간이 초과되었습니다.");
    if (error instanceof TypeError && error.message === "fetch failed") {
      throw new Error(`엔드포인트(${url})에 연결할 수 없습니다.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const OPENAI_NON_CHAT = /embed|whisper|tts|dall-e|moderation|transcribe|audio|realtime|davinci|babbage|image|search/i;
const EMBEDDING_NAME_HINT = /embed|bge|e5-|gte|minilm|mxbai|nomic|arctic-embed|jina/i;

function sortModels(models: ModelInfo[]): ModelInfo[] {
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listModels(
  params: { provider: ModelVendor; baseUrl?: string; apiKey?: string },
  purpose: ModelPurpose,
): Promise<ModelListResult> {
  const provider = params.provider;
  const baseUrl = (params.baseUrl || DEFAULT_VENDOR_BASE_URLS[provider] || "").replace(/\/+$/, "");
  const apiKey = params.apiKey || "";
  if (!baseUrl) return { models: [], message: "엔드포인트를 입력하면 모델 목록을 불러옵니다." };

  if (provider === "anthropic") {
    if (purpose === "embedding") return { models: [], message: "Claude(Anthropic)는 임베딩 API를 제공하지 않습니다." };
    if (!apiKey) return { models: [], message: "API 키를 입력하면 모델 목록을 불러옵니다." };
    const models: ModelInfo[] = [];
    let afterId = "";
    // 페이지네이션 (최대 5페이지)
    for (let page = 0; page < 5; page++) {
      const data = await getJson(`${baseUrl}/v1/models?limit=100${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`, {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      });
      for (const item of data?.data ?? []) {
        models.push({ id: String(item.id), label: item.display_name ? String(item.display_name) : undefined });
      }
      if (!data?.has_more || !data?.last_id) break;
      afterId = String(data.last_id);
    }
    // API 는 최신순으로 준다 → 그대로 유지
    return { models };
  }

  if (provider === "ollama") {
    const data = await getJson(`${baseUrl}/api/tags`, {});
    const models = (data?.models ?? [])
      .filter((item: any) => {
        const capabilities: string[] | undefined = Array.isArray(item.capabilities) ? item.capabilities : undefined;
        const name = String(item.name ?? "");
        if (purpose === "embedding") return capabilities ? capabilities.includes("embedding") : EMBEDDING_NAME_HINT.test(name);
        return capabilities ? capabilities.includes("completion") : !EMBEDDING_NAME_HINT.test(name);
      })
      .map((item: any) => {
        const details = item.details ?? {};
        const detail = [details.parameter_size, details.quantization_level, purpose === "embedding" && details.embedding_length ? `${details.embedding_length}차원` : null]
          .filter(Boolean)
          .join(" · ");
        return { id: String(item.name), detail: detail || undefined };
      });
    if (models.length === 0) {
      return {
        models: [],
        message:
          purpose === "embedding"
            ? "설치된 임베딩 모델이 없습니다. 예: `ollama pull bge-m3`"
            : "설치된 대화 모델이 없습니다. 예: `ollama pull qwen3:8b`",
      };
    }
    return { models: sortModels(models) };
  }

  if (provider === "gemini") {
    if (!apiKey) return { models: [], message: "API 키를 입력하면 모델 목록을 불러옵니다." };
    const models: ModelInfo[] = [];
    let pageToken = "";
    for (let page = 0; page < 5; page++) {
      const data = await getJson(`${baseUrl}/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
        "x-goog-api-key": apiKey,
      });
      for (const item of data?.models ?? []) {
        const methods: string[] = item.supportedGenerationMethods ?? [];
        const wanted = purpose === "embedding" ? methods.includes("embedContent") : methods.includes("generateContent");
        if (!wanted) continue;
        models.push({ id: String(item.name ?? "").replace(/^models\//, ""), label: item.displayName ? String(item.displayName) : undefined });
      }
      if (!data?.nextPageToken) break;
      pageToken = String(data.nextPageToken);
    }
    return models.length ? { models: sortModels(models) } : { models: [], message: "사용 가능한 모델이 없습니다." };
  }

  // openai / custom (OpenAI 호환 /models)
  if (provider === "openai" && !apiKey) return { models: [], message: "API 키를 입력하면 모델 목록을 불러옵니다." };
  const data = await getJson(`${baseUrl}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
  const ids: string[] = (data?.data ?? data?.models ?? []).map((item: any) => String(item.id ?? item.name ?? "")).filter(Boolean);
  let filtered: string[];
  if (purpose === "embedding") {
    filtered = ids.filter((id) => EMBEDDING_NAME_HINT.test(id));
    // 호환 서버는 이름만으로 구분이 안 될 수 있어 전체를 보여준다.
    if (filtered.length === 0 && provider === "custom") filtered = ids;
  } else {
    filtered = ids.filter((id) => (provider === "openai" ? !OPENAI_NON_CHAT.test(id) : !EMBEDDING_NAME_HINT.test(id)));
    if (filtered.length === 0 && provider === "custom") filtered = ids;
  }
  return filtered.length
    ? { models: sortModels(filtered.map((id) => ({ id }))) }
    : { models: [], message: "해당 용도의 모델이 없습니다." };
}
