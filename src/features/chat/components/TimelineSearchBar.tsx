import { memo, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import X from "lucide-react/dist/esm/icons/x";
import Search from "lucide-react/dist/esm/icons/search";

/** 对话内搜索条（⌘F / Ctrl+F 打开）：输入即匹配，Enter 下一个、
 *  Shift+Enter 上一个、Esc 关闭——与浏览器页内查找一致。 */
export const TimelineSearchBar = memo(function TimelineSearchBar({
  query,
  onQueryChange,
  current,
  total,
  onPrev,
  onNext,
  onClose,
  inputRef,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  /** 当前命中序号（0 基）；无命中时为 0。 */
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  inputRef: MutableRefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  const hasQuery = query.trim().length > 0;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) onPrev();
      else onNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const navButtonClass =
    "flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-icon-tertiary transition-colors duration-150 ease hover:bg-background-secondary-hover hover:text-foreground-icon-primary disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground-icon-tertiary";

  return (
    <search
      onKeyDown={handleKeyDown}
      className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-lg border border-border-button-default bg-background-primary-default py-1 pr-1 pl-2 shadow-lg"
    >
      <Search className="size-3.5 shrink-0 text-foreground-icon-tertiary" aria-hidden />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={t("chat.searchPlaceholder")}
        aria-label={t("chat.searchPlaceholder")}
        className="w-44 bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-tertiary"
      />
      <span className="min-w-10 text-center text-caption-1-regular whitespace-nowrap text-text-tertiary">
        {hasQuery
          ? total > 0
            ? `${current + 1}/${total}`
            : t("chat.searchNoResults")
          : ""}
      </span>
      <button
        type="button"
        onClick={onPrev}
        disabled={total === 0}
        aria-label={t("chat.searchPrevMatch")}
        title={t("chat.searchPrevMatch")}
        className={navButtonClass}
      >
        <ChevronUp className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={total === 0}
        aria-label={t("chat.searchNextMatch")}
        title={t("chat.searchNextMatch")}
        className={navButtonClass}
      >
        <ChevronDown className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("chat.searchClose")}
        title={t("chat.searchClose")}
        className={navButtonClass}
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </search>
  );
});
