import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle";
import { cx } from "@/utils/cx";
import type { SideToolItem } from "./store";

const LazyMarkdown = lazy(() => import("@/features/chat/components/Markdown"));

/** Compact token count: 1234 → "1.2k", 1_250_000 → "1.3M". */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Streaming/settled Markdown with a plain-text fallback while the chunk loads. */
export function SideMarkdown({
  text,
  workspacePath,
  streaming,
}: {
  text: string;
  workspacePath: string;
  streaming: boolean;
}) {
  return (
    <Suspense fallback={<div className="whitespace-pre-wrap text-body-regular text-text-primary">{text}</div>}>
      <div className="min-w-0 text-body-regular text-text-primary">
        <LazyMarkdown text={text} workspacePath={workspacePath} streaming={streaming} />
      </div>
    </Suspense>
  );
}

/** Collapsible reasoning preview (collapsed by default, never truncates text). */
export function SideThinking({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1 rounded-md text-caption-1-medium text-text-tertiary outline-none transition-colors duration-150 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <ChevronRight
          aria-hidden
          className={cx("size-3.5 transition-transform duration-150", open && "rotate-90")}
        />
        <span>{streaming ? t("sidechat.thinkingLive") : t("sidechat.thinking")}</span>
      </button>
      {open && (
        <div className="mt-1 max-h-48 overflow-y-auto overscroll-contain whitespace-pre-wrap border-l-2 border-border-button-default pl-2 text-caption-1-medium text-text-tertiary">
          {text}
        </div>
      )}
    </div>
  );
}

/** Read-only tool pills: side runs only ever read, so no approvals appear here. */
export function SideToolPills({ tools }: { tools: SideToolItem[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tools.map((tool) => (
        <span
          key={tool.id}
          title={tool.path ?? tool.name}
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-medium text-text-secondary"
        >
          {tool.status === "running" ? (
            <LoaderCircle aria-hidden className="size-3 shrink-0 animate-spin" />
          ) : (
            <Check aria-hidden className="size-3 shrink-0 text-notification-success-foreground" />
          )}
          <span className="max-w-64 truncate">{tool.name}</span>
        </span>
      ))}
    </div>
  );
}

/** Prompt-cache hit badge; hidden until the engine reports cached tokens. */
export function CacheHitBadge({ cacheRead }: { cacheRead: number | undefined }) {
  const { t } = useTranslation();
  if (!cacheRead || cacheRead <= 0) return null;
  return (
    <span
      title={t("sidechat.cacheHitHint")}
      className="inline-flex shrink-0 items-center rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-medium whitespace-nowrap text-notification-success-foreground"
    >
      {t("sidechat.cacheHit", { tokens: compactTokens(cacheRead) })}
    </span>
  );
}
