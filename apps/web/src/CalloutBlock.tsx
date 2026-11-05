import { useEffect, useRef, useState } from "react";
import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import {
  createReactBlockSpec,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";

/**
 * 콜아웃(Callout) 블록
 * - 프리셋(variant)만 저장하고 색상/아이콘 스타일은 디자인 시스템(styles/editor/callout.css,
 *   tokens.css의 --ds-callout-*)에서 일괄 관리합니다.
 */
export const CALLOUT_VARIANTS = ["note", "info", "tip", "warning", "danger", "idea"] as const;
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

export const CALLOUT_PRESETS: Record<
  CalloutVariant,
  {
    label: string;
    emoji: string;
    description: string;
    sampleText: string;
    aliases: string[];
  }
> = {
  note: {
    label: "메모",
    emoji: "📝",
    description: "가벼운 메모나 참고 사항 콜아웃",
    sampleText: "참고할 메모나 보충 설명을 여기에 적어보세요.",
    aliases: ["callout", "note", "memo", "콜아웃", "메모", "참고"],
  },
  info: {
    label: "정보",
    emoji: "💡",
    description: "알아두면 좋은 안내 · 정보 콜아웃",
    sampleText: "핵심 안내 사항이나 배경 정보를 요약해 두세요.",
    aliases: ["callout", "info", "information", "콜아웃", "정보", "안내"],
  },
  tip: {
    label: "팁 · 완료",
    emoji: "✅",
    description: "유용한 팁이나 권장 사항 콜아웃",
    sampleText: "이렇게 활용하면 작업 속도를 훨씬 높일 수 있습니다.",
    aliases: ["callout", "tip", "success", "done", "콜아웃", "팁", "성공", "완료"],
  },
  warning: {
    label: "주의",
    emoji: "⚠️",
    description: "놓치기 쉬운 주의 · 경고 콜아웃",
    sampleText: "설정을 변경하기 전에 현재 상태를 먼저 확인하세요.",
    aliases: ["callout", "warning", "caution", "콜아웃", "주의", "경고"],
  },
  danger: {
    label: "위험",
    emoji: "🚨",
    description: "되돌릴 수 없는 작업이나 치명적인 문제 콜아웃",
    sampleText: "이 작업은 되돌릴 수 없으므로 신중하게 실행해야 합니다.",
    aliases: ["callout", "danger", "error", "critical", "콜아웃", "위험", "에러", "오류"],
  },
  idea: {
    label: "아이디어",
    emoji: "✨",
    description: "아이디어나 핵심 강조 콜아웃",
    sampleText: "새로운 아이디어나 다음 단계 제안을 기록해 보세요.",
    aliases: ["callout", "idea", "important", "highlight", "콜아웃", "아이디어", "중요", "강조"],
  },
};

function isCalloutVariant(value: string): value is CalloutVariant {
  return (CALLOUT_VARIANTS as readonly string[]).includes(value);
}

function CalloutIconButton({
  variant,
  editable,
  onChangeVariant,
}: {
  variant: CalloutVariant;
  editable: boolean;
  onChangeVariant: (next: CalloutVariant) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="noty-callout__icon-wrap" contentEditable={false} ref={wrapRef}>
      <button
        type="button"
        className="ds-btn ds-btn--ghost ds-btn--icon noty-callout__icon"
        title={editable ? "콜아웃 종류 변경" : CALLOUT_PRESETS[variant].label}
        disabled={!editable}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((prev) => !prev)}
      >
        {CALLOUT_PRESETS[variant].emoji}
      </button>
      {open && (
        <div className="noty-callout__menu" role="menu">
          {CALLOUT_VARIANTS.map((key) => (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={key === variant}
              className={`ds-btn ds-btn--ghost noty-callout__menu-item noty-callout--${key}${
                key === variant ? " noty-callout__menu-item--active" : ""
              }`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChangeVariant(key);
                setOpen(false);
              }}
            >
              <span className="noty-callout__menu-swatch">{CALLOUT_PRESETS[key].emoji}</span>
              <span className="noty-callout__menu-label">{CALLOUT_PRESETS[key].label}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export const createCalloutBlockSpec = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      variant: {
        default: "info",
        values: CALLOUT_VARIANTS,
      },
    },
    content: "inline",
  } as const,
  {
    render: (props) => {
      const rawVariant = String(props.block.props.variant);
      const variant: CalloutVariant = isCalloutVariant(rawVariant) ? rawVariant : "info";
      return (
        <div className={`noty-callout noty-callout--${variant}`} data-variant={variant}>
          <CalloutIconButton
            variant={variant}
            editable={props.editor.isEditable}
            onChangeVariant={(next) => {
              props.editor.updateBlock(props.block, {
                type: "callout",
                props: { variant: next },
              } as any);
            }}
          />
          <div className="noty-callout__content" ref={props.contentRef} />
        </div>
      );
    },
  },
);

export function getCalloutSlashMenuItems(editor: any): DefaultReactSuggestionItem[] {
  return CALLOUT_VARIANTS.map((variant) => {
    const preset = CALLOUT_PRESETS[variant];
    return {
      title: `콜아웃 · ${preset.label}`,
      subtext: preset.description,
      aliases: preset.aliases,
      group: "콜아웃 샘플",
      icon: (
        <span className={`noty-callout__slash-swatch noty-callout--${variant}`}>
          {preset.emoji}
        </span>
      ),
      onItemClick: () => {
        insertOrUpdateBlockForSlashMenu(editor, {
          type: "callout",
          props: { variant },
          content: preset.sampleText,
        } as any);
      },
    };
  });
}
