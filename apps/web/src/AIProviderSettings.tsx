import { useEffect, useState } from "react";
import { workspaceApi } from "./api";
import { AI_PROVIDER_LABELS } from "./AIChatPanel";
import type { AIStatus, AuthSession } from "./vite-env";

/* ==========================================================================
 * Noty 설정(⌘,) — AI 모델 요약 (읽기 전용)
 * 모델·계정·시스템 설정은 별도 포트의 어드민(apps/admin)에서 관리한다.
 * ========================================================================== */

/** 어드민 주소: VITE_ADMIN_URL 이 있으면 그것, 없으면 지금 접속한 호스트의 개발용 포트(5180) */
export function resolveAdminUrl(): string {
  const configured = import.meta.env.VITE_ADMIN_URL as string | undefined;
  if (configured) return configured;
  const host = typeof window !== "undefined" && window.location.hostname ? window.location.hostname : "127.0.0.1";
  return `http://${host}:5180`;
}

export function AIProviderSettings({ authSession, statusVersion = 0 }: { authSession: AuthSession; statusVersion?: number }) {
  const [status, setStatus] = useState<AIStatus | null>(null);
  const isAdmin = authSession.user.role === "admin";

  useEffect(() => {
    let cancelled = false;
    workspaceApi
      .getAIStatus()
      .then((res) => {
        if (!cancelled) setStatus(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [statusVersion]);

  return (
    <>
      <div className="settings-row">
        <div>
          <div className="settings-row__label">AI 어시스턴트</div>
          <div className="settings-row__desc">
            {status
              ? `${AI_PROVIDER_LABELS[status.provider] ?? status.provider} · ${status.model}${status.configured ? "" : " (연결 정보 없음)"}`
              : "불러오는 중…"}
          </div>
        </div>
      </div>
      {isAdmin && (
        <div className="settings-row">
          <div>
            <div className="settings-row__label">어드민</div>
            <div className="settings-row__desc">계정·역할, AI 모델, 검색 색인·LLM 위키, 시스템 설정은 어드민에서 관리합니다.</div>
          </div>
          <a className="ds-btn ds-btn--outline ds-btn--md" href={resolveAdminUrl()} target="_blank" rel="noreferrer">
            어드민 열기
          </a>
        </div>
      )}
    </>
  );
}
