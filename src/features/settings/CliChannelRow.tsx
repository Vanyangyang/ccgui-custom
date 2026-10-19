import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Globe from "lucide-react/dist/esm/icons/globe";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { Switch } from "@/components/base/switch/switch";
import type { RepoDragChrome } from "@/components/application/ai-chat/workspace-sortable-list";
import { inferModelEngine } from "@/components/foundations/icons/engine-brands";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { cx } from "@/utils/cx";
import ccSwitchIcon from "@/assets/model-icons/cc-switch.png";
import type { EngineId, ProviderEntry } from "./providers";

/** Same chrome as SettingsRow's container, but free-form content. */
export const ROW =
  "flex min-h-[52px] w-full items-center gap-3 py-2.5 pr-2.5 border-b border-separator-border last:border-b-0";

export function Badge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  /** "warning" = orange, used for the cc-switch origin pill. */
  tone?: "default" | "warning";
}) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none",
        tone === "warning"
          ? "bg-background-tertiary-warning text-text-warning-primary"
          : "bg-background-tertiary-default text-text-secondary",
      )}
    >
      {children}
    </span>
  );
}

/** host("https://api.moonshot.cn/anthropic") → "api.moonshot.cn". */
function hostOf(url: string): string {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).host;
  } catch {
    return url;
  }
}

/** Tinted rounded square with the inferred brand mark; doubles as the row's drag
 *  handle when `dragHandle` is set. */
export function ChannelAvatar({
  entry,
  fallbackEngine,
  dragHandle,
}: {
  entry?: ProviderEntry;
  fallbackEngine: EngineId;
  /** Drag-handle wiring (label + pointer handler) from the sortable list. */
  dragHandle?: { label: string; props: RepoDragChrome["dragHandleProps"] };
}) {
  const fromCcSwitch =
    entry != null &&
    (entry.raw as Record<string, unknown>).source === "cc-switch";
  const brand = entry
    ? (inferModelEngine(entry.model) ?? inferModelEngine(entry.baseUrl))
    : fallbackEngine;
  const avatar = (
    <span className="flex size-9 items-center justify-center rounded-2lg bg-background-tertiary-default text-foreground-icon-primary">
      {fromCcSwitch ? (
        <img src={ccSwitchIcon} alt="" className="size-5" aria-hidden />
      ) : brand ? (
        <EngineIcon engine={brand} size={16} />
      ) : (
        <Globe className="size-4" aria-hidden />
      )}
    </span>
  );
  // Plain avatar: static span. With a drag handle it becomes a real button —
  // same reorder-grip pattern as the workspace sidebar.
  if (!dragHandle) return <span className="shrink-0">{avatar}</span>;
  return (
    <button
      type="button"
      aria-label={dragHandle.label}
      title={dragHandle.label}
      {...(dragHandle.props ?? {})}
      onClick={(e) => e.stopPropagation()}
      className="shrink-0 cursor-grab touch-none">
      {avatar}
    </button>
  );
}

/** One custom channel: click to activate. */
export function ChannelRow({
  engine,
  entry,
  current,
  busy,
  drag,
  onToggle,
  onEdit,
  onDelete,
}: {
  engine: EngineId;
  entry: ProviderEntry;
  current: boolean;
  busy: boolean;
  drag: RepoDragChrome | null;
  /** on=true → make current; on=false (only possible when current) → fall back to 官方配置. */
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const fromCcSwitch = (entry.raw as Record<string, unknown>).source === "cc-switch";
  const subtitle = useMemo(() => {
    const parts = [
      entry.remark,
      entry.baseUrl && hostOf(entry.baseUrl),
      entry.model,
    ].filter(Boolean);
    return parts.join(" · ");
  }, [entry.remark, entry.baseUrl, entry.model]);

  return (
    <div
      role="button"
      tabIndex={0}
      className={cx(ROW, "cursor-pointer")}
      onClick={() => {
        if (!busy && !current) onToggle(true);
      }}
      onKeyDown={(e) => {
        // Ignore keys from nested controls (switch, edit, …): they handle
        // their own Enter/Space and must not also activate the row.
        if (e.target !== e.currentTarget) return;
        if ((e.key === "Enter" || e.key === " ") && !busy && !current) {
          e.preventDefault();
          onToggle(true);
        }
      }}
    >
      <ChannelAvatar
        entry={entry}
        fallbackEngine={engine}
        // The avatar doubles as the drag handle: stopPropagation keeps a
        // plain click (or the click after a drop) from activating the row.
        dragHandle={
          drag
            ? {
                label: t("settings.cliDrag"),
                props: drag.dragHandleProps,
              }
            : undefined
        }
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="flex items-center gap-1.5 text-body-regular text-text-primary">
          <span className="truncate">{entry.name}</span>
          {fromCcSwitch && <Badge tone="warning">cc-switch</Badge>}
        </p>
        {subtitle && (
          <p className="truncate text-body-2-regular text-text-secondary">{subtitle}</p>
        )}
      </div>
      {/* stopPropagation: action clicks must not re-activate the row.
          Order mirrors the reference: switch → divider → edit → delete. */}
      <span onClick={(e) => e.stopPropagation()}>
        <Switch
          size="sm"
          aria-label={entry.name}
          isSelected={current}
          onChange={onToggle}
          isDisabled={busy}
        />
      </span>
      <span
        aria-hidden
        className="h-4 w-px shrink-0 bg-separator-border"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        aria-label={t("settings.cliEdit")}
        title={t("settings.cliEdit")}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary disabled:opacity-40"
      >
        <Pencil className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t("settings.cliDelete")}
        title={t("settings.cliDelete")}
        disabled={busy || current}
        onClick={(e) => {
          e.stopPropagation();
          if (!current) onDelete();
        }}
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-text-error-primary disabled:opacity-40"
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </div>
  );
}
