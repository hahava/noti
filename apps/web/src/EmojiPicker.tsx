import { useEffect, useRef } from "react";
import data from "@emoji-mart/data";
import ko from "@emoji-mart/data/i18n/ko.json";
import { Picker } from "emoji-mart";

/** 노션처럼 검색·카테고리·피부색이 있는 이모지 피커. data·i18n을 직접 넘겨 CDN에서 받지 않게 한다. */
export function EmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const picker = new Picker({
      data,
      i18n: ko,
      locale: "ko",
      theme: "light",
      autoFocus: true,
      previewPosition: "none",
      skinTonePosition: "search",
      perLine: 9,
      maxFrequentRows: 2,
      onEmojiSelect: (emoji: { native?: string }) => {
        if (emoji.native) onSelectRef.current(emoji.native);
      },
    });
    host.appendChild(picker as unknown as Node);
    return () => host.replaceChildren();
  }, []);

  return <div ref={hostRef} className="emoji-picker-mart" />;
}

/** 랜덤 버튼용: 전체 이모지 중 하나 */
export function randomEmoji(): string {
  const emojis = Object.values((data as { emojis: Record<string, { skins: Array<{ native: string }> }> }).emojis);
  return emojis[Math.floor(Math.random() * emojis.length)]?.skins[0]?.native ?? "📝";
}
