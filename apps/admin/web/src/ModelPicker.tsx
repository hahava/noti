import { useEffect, useRef, useState } from "react";
import { adminApi, type ModelInfo } from "./api";

/** 업체 API 에서 모델 목록을 불러와 고르는 입력 (목록에 없으면 직접 입력) */
const CUSTOM_VALUE = "__custom__";

export function ModelPicker({
  target,
  provider,
  baseUrl,
  apiKey,
  value,
  placeholder,
  onChange,
}: {
  target: "chat" | "background" | "embedding";
  provider: string;
  baseUrl: string;
  apiKey: string;
  value: string;
  placeholder?: string;
  onChange: (model: string) => void;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [custom, setCustom] = useState(false);
  const immediate = useRef(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(
      () => {
        adminApi
          .listModels({ target, provider, baseUrl, apiKey })
          .then((res) => {
            if (cancelled) return;
            setModels(res.models);
            setMessage(res.message ?? null);
          })
          .catch((err) => {
            if (cancelled) return;
            setModels([]);
            setMessage(err instanceof Error ? err.message : "모델 목록을 불러오지 못했습니다.");
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      immediate.current ? 0 : 600,
    );
    immediate.current = false;
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [target, provider, baseUrl, apiKey, reload]);

  useEffect(() => setCustom(false), [provider]);

  const inList = models.some((model) => model.id === value);
  const showInput = custom || models.length === 0 || (Boolean(value) && !inList);

  return (
    <div className="model-picker">
      <div className="model-picker__row">
        {models.length > 0 && (
          <select
            value={showInput ? CUSTOM_VALUE : value}
            onChange={(e) => {
              if (e.target.value === CUSTOM_VALUE) return setCustom(true);
              setCustom(false);
              onChange(e.target.value);
            }}
          >
            {!value && !showInput && <option value="">모델 선택…</option>}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label && model.label !== model.id ? `${model.label} (${model.id})` : model.id}
                {model.detail ? ` — ${model.detail}` : ""}
              </option>
            ))}
            <option value={CUSTOM_VALUE}>직접 입력…</option>
          </select>
        )}
        {showInput && <input value={value} placeholder={placeholder || "모델명"} onChange={(e) => onChange(e.target.value)} />}
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          title="모델 목록 새로고침"
          disabled={loading}
          onClick={() => {
            immediate.current = true;
            setReload((n) => n + 1);
          }}
        >
          {loading ? "…" : "↻"}
        </button>
      </div>
      {message && <div className="hint">{message}</div>}
    </div>
  );
}
