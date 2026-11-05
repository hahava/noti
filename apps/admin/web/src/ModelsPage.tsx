import { useEffect, useState, type ReactNode } from "react";
import {
  adminApi,
  type AdminStatus,
  type BackgroundSettings,
  type ChatSettings,
  type EmbeddingSettings,
  type EmbeddingVendor,
  type SystemConfig,
  type Vendor,
} from "./api";
import { ModelPicker } from "./ModelPicker";

const VENDOR_LABELS: Record<Vendor, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
  ollama: "Ollama",
  gemini: "Gemini",
  custom: "OpenAI 호환",
};

const VENDOR_DEFAULTS: Record<Vendor, { model: string; baseUrl: string }> = {
  openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" },
  anthropic: { model: "claude-opus-5-5", baseUrl: "https://api.anthropic.com" },
  ollama: { model: "qwen3:8b", baseUrl: "http://127.0.0.1:11434" },
  gemini: { model: "", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  custom: { model: "", baseUrl: "" },
};

const EMBEDDING_DEFAULTS: Record<EmbeddingVendor, { model: string; baseUrl: string }> = {
  ollama: { model: "bge-m3", baseUrl: "http://127.0.0.1:11434" },
  openai: { model: "text-embedding-3-small", baseUrl: "https://api.openai.com/v1" },
  gemini: { model: "text-embedding-004", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  custom: { model: "", baseUrl: "" },
};

type Message = { ok: boolean; text: string } | null;

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? "is-active" : ""} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Section({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card__head">
        <div>
          <h3>{title}</h3>
          <p className="muted">{description}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** 업체·모델·키·엔드포인트 입력 묶음 (채팅·백그라운드 공통) */
function VendorFields({
  target,
  value,
  onChange,
}: {
  target: "chat" | "background";
  value: { provider: Vendor; model: string; apiKey: string; baseUrl: string };
  onChange: (patch: Partial<{ provider: Vendor; model: string; apiKey: string; baseUrl: string }>) => void;
}) {
  return (
    <>
      <Segmented
        value={value.provider}
        options={(Object.keys(VENDOR_LABELS) as Vendor[]).map((id) => [id, VENDOR_LABELS[id]])}
        onChange={(provider) => {
          if (provider === value.provider) return;
          onChange({ provider, model: VENDOR_DEFAULTS[provider].model, baseUrl: VENDOR_DEFAULTS[provider].baseUrl, apiKey: "" });
        }}
      />
      <div className="form">
        <label className="field">
          <span>모델</span>
          <ModelPicker
            target={target}
            provider={value.provider}
            baseUrl={value.baseUrl}
            apiKey={value.apiKey}
            value={value.model}
            placeholder={VENDOR_DEFAULTS[value.provider].model}
            onChange={(model) => onChange({ model })}
          />
        </label>
        {value.provider !== "ollama" && (
          <label className="field">
            <span>API 키</span>
            <input type="password" autoComplete="off" value={value.apiKey} placeholder="sk-…" onChange={(e) => onChange({ apiKey: e.target.value })} />
          </label>
        )}
        <label className="field">
          <span>엔드포인트</span>
          <input value={value.baseUrl} placeholder={VENDOR_DEFAULTS[value.provider].baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} />
        </label>
      </div>
    </>
  );
}

function Actions({ message, children }: { message: Message; children: ReactNode }) {
  return (
    <div className="actions">
      {message && <span className={message.ok ? "text-ok" : "text-error"}>{message.text}</span>}
      {children}
    </div>
  );
}

export function ModelsPage() {
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const setMessage = (key: string, message: Message) => setMessages((prev) => ({ ...prev, [key]: message }));

  useEffect(() => {
    adminApi
      .getSettings()
      .then((res) => setConfig(res.config))
      .catch((err) => setError(err.message));
    const loadStatus = () => adminApi.status().then(setStatus).catch(() => undefined);
    void loadStatus();
    const timer = window.setInterval(loadStatus, 5000);
    return () => window.clearInterval(timer);
  }, []);

  if (error) return <div className="alert alert--error">{error}</div>;
  if (!config) return <div className="muted">불러오는 중…</div>;

  const updateChat = (patch: Partial<ChatSettings>) => setConfig({ ...config, ai: { ...config.ai, ...patch } });
  const updateBackground = (patch: Partial<BackgroundSettings>) =>
    setConfig({ ...config, aiBackground: { ...config.aiBackground, ...patch } });
  const updateEmbedding = (patch: Partial<EmbeddingSettings>) => setConfig({ ...config, embedding: { ...config.embedding, ...patch } });

  const save = async (key: string, patch: Partial<SystemConfig>, text: string) => {
    setBusy(key);
    setMessage(key, null);
    try {
      const res = await adminApi.saveSettings(patch);
      setConfig(res.config);
      setMessage(key, { ok: true, text });
      setStatus(await adminApi.status());
    } catch (err) {
      setMessage(key, { ok: false, text: err instanceof Error ? err.message : "저장하지 못했습니다." });
    } finally {
      setBusy(null);
    }
  };

  const test = async (key: string, payload: Record<string, unknown>) => {
    setBusy(`${key}-test`);
    setMessage(key, null);
    try {
      const res = await adminApi.test(payload);
      setMessage(key, { ok: res.ok, text: res.message });
    } catch (err) {
      setMessage(key, { ok: false, text: err instanceof Error ? err.message : "연결 테스트에 실패했습니다." });
    } finally {
      setBusy(null);
    }
  };

  const chat = config.ai;
  const background = config.aiBackground;
  const embedding = config.embedding;
  const indexing = status?.indexing;
  const digests = status?.digests;

  return (
    <div className="stack">
      <Section title="채팅 모델" description="AI 어시스턴트 패널에서 답변을 만드는 모델입니다.">
        <VendorFields
          target="chat"
          value={chat}
          onChange={(patch) => {
            // 업체를 바꿀 때 이전 업체의 입력값은 profiles 에 남겨 둔다 (다시 돌아오면 복원).
            if (patch.provider && patch.provider !== chat.provider) {
              const profiles = { ...(chat.profiles ?? {}), [chat.provider]: { model: chat.model, apiKey: chat.apiKey, baseUrl: chat.baseUrl } };
              const saved = profiles[patch.provider];
              updateChat({ ...patch, ...(saved && (saved.model || saved.baseUrl) ? saved : {}), provider: patch.provider, profiles });
              return;
            }
            updateChat(patch);
          }}
        />
        <Actions message={messages.chat ?? null}>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void test("chat", { target: "ai", ai: chat })}>
            {busy === "chat-test" ? "확인 중…" : "연결 테스트"}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy !== null}
            onClick={() =>
              void save(
                "chat",
                { ai: { ...chat, profiles: { ...(chat.profiles ?? {}), [chat.provider]: { model: chat.model, apiKey: chat.apiKey, baseUrl: chat.baseUrl } } } },
                `${VENDOR_LABELS[chat.provider]} · ${chat.model} 로 저장했습니다.`,
              )
            }
          >
            저장
          </button>
        </Actions>
      </Section>

      <Section
        title="LLM 위키 · 백그라운드 작업"
        description="페이지가 바뀌면 AI 정리 노트와 주제(개념) 위키를 만듭니다. 페이지마다 호출하므로 비용이 적은 모델(예: 로컬 Ollama)을 추천합니다."
        aside={
          <label className="switch">
            <input type="checkbox" checked={background.digestEnabled} onChange={(e) => updateBackground({ digestEnabled: e.target.checked })} />
            <span>{background.digestEnabled ? "켜짐" : "꺼짐"}</span>
          </label>
        }
      >
        <Segmented
          value={background.mode}
          options={[
            ["same", "채팅 모델과 같게"],
            ["custom", "따로 지정"],
          ]}
          onChange={(mode) => updateBackground({ mode })}
        />
        {background.mode === "custom" ? (
          <VendorFields target="background" value={background} onChange={updateBackground} />
        ) : (
          <p className="hint">채팅 모델({VENDOR_LABELS[chat.provider]} · {chat.model})을 그대로 씁니다.</p>
        )}
        {digests && (
          <div className="stat-grid">
            <div className="stat"><strong>{digests.done}</strong><span>정리된 페이지 / {digests.totalPages}</span></div>
            <div className="stat"><strong>{digests.multiPageConcepts}</strong><span>여러 페이지 주제</span></div>
            <div className="stat"><strong>{digests.conceptArticles}</strong><span>종합 글</span></div>
            <div className="stat"><strong>{digests.failed}</strong><span>실패</span></div>
          </div>
        )}
        {digests?.lastError && <p className="text-error small">최근 오류: {digests.lastError}</p>}
        <Actions message={messages.background ?? null}>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy !== null}
            onClick={async () => {
              if (!window.confirm("모든 정리 노트와 주제 위키를 지우고 다시 만들까요? 페이지 수만큼 모델을 호출합니다.")) return;
              await adminApi.regenerateDigests();
              setMessage("background", { ok: true, text: "처음부터 다시 만들기 시작했습니다." });
              setStatus(await adminApi.status());
            }}
          >
            전체 다시 생성
          </button>
          {background.mode === "custom" && (
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void test("background", { target: "ai", ai: background, keyTarget: "background" })}
            >
              {busy === "background-test" ? "확인 중…" : "연결 테스트"}
            </button>
          )}
          <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={() => void save("background", { aiBackground: background }, "백그라운드 작업 설정을 저장했습니다.")}>
            저장
          </button>
        </Actions>
      </Section>

      <Section
        title="임베딩 · 검색"
        description="문서와 검색어를 벡터로 바꿔 의미 검색에 씁니다. 모델을 바꾸면 모든 문서를 새 모델로 다시 색인합니다."
        aside={
          <label className="switch">
            <input type="checkbox" checked={embedding.enabled} onChange={(e) => updateEmbedding({ enabled: e.target.checked })} />
            <span>{embedding.enabled ? "켜짐" : "꺼짐"}</span>
          </label>
        }
      >
        <Segmented
          value={embedding.provider}
          options={(Object.keys(EMBEDDING_DEFAULTS) as EmbeddingVendor[]).map((id) => [id, VENDOR_LABELS[id]])}
          onChange={(provider) => {
            if (provider === embedding.provider) return;
            updateEmbedding({ provider, model: EMBEDDING_DEFAULTS[provider].model, baseUrl: EMBEDDING_DEFAULTS[provider].baseUrl, apiKey: "" });
          }}
        />
        <div className="form">
          <label className="field">
            <span>모델</span>
            <ModelPicker
              target="embedding"
              provider={embedding.provider}
              baseUrl={embedding.baseUrl}
              apiKey={embedding.apiKey}
              value={embedding.model}
              placeholder={EMBEDDING_DEFAULTS[embedding.provider].model}
              onChange={(model) => updateEmbedding({ model })}
            />
          </label>
          {embedding.provider !== "ollama" && (
            <label className="field">
              <span>API 키</span>
              <input type="password" autoComplete="off" value={embedding.apiKey} onChange={(e) => updateEmbedding({ apiKey: e.target.value })} />
            </label>
          )}
          <label className="field">
            <span>엔드포인트</span>
            <input value={embedding.baseUrl} placeholder={EMBEDDING_DEFAULTS[embedding.provider].baseUrl} onChange={(e) => updateEmbedding({ baseUrl: e.target.value })} />
          </label>
        </div>
        {indexing && (
          <div className="stat-grid">
            <div className="stat"><strong>{indexing.textIndexedPages}/{indexing.totalPages}</strong><span>키워드 색인 ({indexing.keywordEngine === "pgroonga" ? "PGroonga" : "기본"})</span></div>
            <div className="stat"><strong>{indexing.enabled ? `${indexing.indexedPages}/${indexing.totalPages}` : "꺼짐"}</strong><span>벡터 색인{indexing.dims ? ` · ${indexing.dims}차원` : ""}</span></div>
            <div className="stat"><strong>{indexing.chunkCount}</strong><span>벡터 조각</span></div>
            <div className="stat"><strong>{indexing.attachments.done}</strong><span>첨부파일 추출 (대기 {indexing.attachments.pending})</span></div>
          </div>
        )}
        {indexing?.lastError && <p className="text-error small">최근 오류: {indexing.lastError}</p>}
        <Actions message={messages.embedding ?? null}>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy !== null}
            onClick={async () => {
              if (!window.confirm("모든 문서를 처음부터 다시 색인할까요?")) return;
              await adminApi.reindex();
              setMessage("embedding", { ok: true, text: "전체 다시 색인을 시작했습니다." });
              setStatus(await adminApi.status());
            }}
          >
            전체 다시 색인
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void test("embedding", { target: "embedding", embedding })}>
            {busy === "embedding-test" ? "확인 중…" : "연결 테스트"}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={() => void save("embedding", { embedding }, "임베딩 설정을 저장했습니다.")}>
            저장
          </button>
        </Actions>
      </Section>
    </div>
  );
}
