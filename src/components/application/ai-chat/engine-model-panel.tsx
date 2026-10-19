"use client";

import { useMemo, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Search from "lucide-react/dist/esm/icons/search";
import X from "lucide-react/dist/esm/icons/x";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { Switch } from "@/components/base/switch/switch";
import { CLI_DISPLAY_NAMES, inferModelEngine } from "@/components/foundations/icons/engine-brands";
import { ChevronDownSmall } from "@/components/foundations/icons/chevrons";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { supportsOmpFastMode, type OmpServiceTier } from "@/lib/omp-service-tier";
import { cx } from "@/utils/cx";
import { OmpSpeedSection } from "./omp-speed-section";
import { filterModels, groupModelsByProvider, type ModelGroup } from "./model-list";
import { EFFORT_LABEL_KEYS, getEffortLevels, normalizeEffortLevel, supportsEffort, type EffortLevel } from "./effort-levels";
import { EffortPicker } from "./effort-picker";
import { encodedModelEffort, modelChoiceRows, type ModelChoiceRow } from "./model-effort";
import { CursorModelList } from "./cursor-model-picker";
import type { CursorModel } from "./cursor-models";
import type { MenuOption, ModelOption } from "./cli-menu";

export interface ChannelOption {
  id: string;
  label: string;
}

/** Per-engine model flyout: pops to the right of the CLI popover, bottom-
 *  aligned with the engine list so the taller panel never clips below the
 *  composer-anchored popover. */
const FLYOUT_CLASSES = cx(
  "absolute left-full bottom-0 z-10 ml-2 w-80 max-w-[calc(100vw-32px)]",
  "rounded-lg border border-border-button-default bg-background-primary-default p-1 shadow-dropdown",
);

/* ------------------------------------------------------------------ flyout */

/** One checkmark channel row. Shown only when the engine has in-app channels. */
function ChannelRow({
  option,
  selected,
  engineId,
  onPick,
}: {
  option: ChannelOption;
  selected: boolean;
  engineId: string;
  onPick: (engine: string, id: string) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onPick(engineId, option.id)}
      className={cx(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
        selected
          ? "bg-background-primary-hover"
          : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
      )}
    >
      <span className="min-w-0 truncate text-body-medium text-text-primary">
        {option.label}
      </span>
      {selected && (
        <Check
          className="ml-auto size-4 shrink-0 text-foreground-icon-primary"
          aria-hidden
        />
      )}
    </button>
  );
}

/** Header field narrowing the channel list. While it holds text the dropdown
 *  stays open, so the matches are visible without a second click. */
function ChannelFilterField({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <input
      value={query}
      onChange={(event) => onQueryChange(event.target.value)}
      placeholder={t("chat.channelFilterPlaceholder")}
      aria-label={t("chat.channelFilterPlaceholder")}
      className="h-6 w-[104px] shrink-0 rounded-md border border-separator-border bg-background-secondary-default px-1.5 text-caption-1-regular text-text-primary outline-none placeholder:text-text-tertiary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    />
  );
}

/** Provider dropdown: collapsed to the current channel until opened, then a
 *  height-bounded scroll list. The old inline list rendered every channel at
 *  once, so a machine with a dozen relays pushed the model list — the part
 *  the panel exists for — off the flyout. */
function ChannelPicker({
  channels,
  selectedChannelId,
  engineId,
  onPickChannel,
  query,
  onQueryChange,
}: {
  channels: ChannelOption[];
  selectedChannelId: string;
  engineId: string;
  onPickChannel: (engine: string, id: string) => void;
  /** Header filter text; a non-empty filter also holds the list open. */
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (channels.length === 0) return null;
  const needle = query.trim().toLowerCase();
  // Match the id too: the visible label is the channel's name, but people
  // search by the slug they pasted into the provider dialog.
  const visible = needle
    ? channels.filter((channel) =>
        `${channel.label} ${channel.id}`.toLowerCase().includes(needle),
      )
    : channels;
  const expanded = open || needle.length > 0;
  const selected = channels.find((channel) => channel.id === selectedChannelId);
  return (
    <div className="flex w-full flex-col">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => {
          // Filtered? The arrow clears the filter instead of hiding the list
          // the text is still narrowing.
          if (needle) {
            onQueryChange("");
            setOpen(false);
            return;
          }
          setOpen((prev) => !prev);
        }}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-background-primary-hover focus-visible:bg-background-primary-hover"
      >
        <span className="shrink-0 text-body-2-medium text-text-tertiary">
          {t("chat.channelPicker")}
        </span>
        <span className="min-w-0 truncate text-body-medium text-text-primary">
          {selected?.label ?? t("chat.channelUnselected")}
        </span>
        <ChevronDownSmall
          className={cx(
            "ml-auto size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-200 ease",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div
          id={listId}
          role="radiogroup"
          aria-label={t("chat.channelPicker")}
          className="flex max-h-[200px] w-full flex-col overflow-y-auto"
        >
          {visible.map((channel) => (
            <ChannelRow
              key={channel.id}
              option={channel}
              selected={channel.id === selectedChannelId}
              engineId={engineId}
              onPick={(engine, id) => {
                // Restore focus before this row unmounts; otherwise the overlay
                // focuses the first engine row and switches away from this panel.
                triggerRef.current?.focus({ preventScroll: true });
                onPickChannel(engine, id);
                onQueryChange("");
                setOpen(false);
              }}
            />
          ))}
          {visible.length === 0 && (
            <span className="px-2 py-1.5 text-body-2-regular text-text-tertiary">
              {t("chat.noMatchingChannels")}
            </span>
          )}
        </div>
      )}
      <div aria-hidden className="-mx-1 mt-1 mb-1 h-px bg-border-button-default" />
    </div>
  );
}

/** One checkmark model row inside the flyout's radio group. */
function ModelRow({
  option,
  selected,
  engineId,
  onPick,
}: {
  option: ModelOption;
  selected: boolean;
  engineId: string;
  onPick: (engine: string, id: string) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onPick(engineId, option.id)}
      className={cx(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
        selected
          ? "bg-background-primary-hover"
          : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
      )}
    >
      <EngineIcon
        engine={inferModelEngine(option.label) ?? inferModelEngine(option.id) ?? engineId}
        size={18}
        className="shrink-0 text-foreground-icon-primary"
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body-medium whitespace-nowrap text-text-primary">
          {option.label}
        </span>
        {/* CLI /model-menu style subtitle ("Custom Opus model"); absent
            for plain catalog rows. */}
        {option.description && (
          <span className="truncate text-body-2-regular whitespace-nowrap text-text-secondary">
            {option.description}
          </span>
        )}
      </span>
      {selected && (
        <Check
          className="ml-auto size-4 shrink-0 text-foreground-icon-primary"
          aria-hidden
        />
      )}
    </button>
  );
}

function ModelVariantsRow({ row, selectedModelId, engineId, onPick }: {
  row: ModelChoiceRow;
  selectedModelId: string;
  engineId: string;
  onPick: (engine: string, id: string) => void;
}) {
  const { t } = useTranslation();
  const selected = row.variants!.some(({ model }) => model.id === selectedModelId);
  return <div className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5", selected && "bg-background-primary-hover")}>
    <EngineIcon engine={inferModelEngine(row.model.label) ?? engineId} size={18} className="shrink-0 text-foreground-icon-primary" />
    <span className="min-w-0 flex-1" title={row.model.label}>
      <span className="block truncate text-body-medium text-text-primary">{row.model.label}</span>
      {row.model.description && <span className="block truncate text-body-2-regular text-text-secondary">{row.model.description}</span>}
    </span>
    <span className="flex shrink-0 gap-0.5">
      {row.variants!.map(({ model, effort }) => <button
        key={model.id} type="button" role="radio" aria-checked={model.id === selectedModelId}
        aria-label={`${row.model.label} · ${t(EFFORT_LABEL_KEYS[effort])}`}
        title={model.label}
        onClick={() => onPick(engineId, model.id)}
        className={cx(
          "min-h-8 min-w-8 cursor-pointer rounded-md border px-1.5 text-body-2-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          model.id === selectedModelId ? "border-border-button-default bg-background-primary-default text-text-primary shadow-xs"
            : "border-transparent text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
        )}
      >{t(EFFORT_LABEL_KEYS[effort])}</button>)}
    </span>
  </div>;
}

/** The model's independent effort choices, when the protocol supports them. */
function FlyoutEffortSection({
  levels,
  effort,
  onChange,
  header,
}: {
  levels: readonly EffortLevel[];
  effort: EffortLevel;
  onChange: (level: EffortLevel) => void;
  header?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col">
      {header ?? <span className="px-2 pb-2 text-body-medium text-text-secondary">{t("chat.effort")}</span>}
      <div className="w-full px-2 pb-2">
        <EffortPicker levels={levels} value={effort} onChange={onChange} />
      </div>
    </div>
  );
}

/** Header refresh button: re-probes provider configs and model catalogs,
 * spinning until the probe settles and checking once it does. */
function RefreshButton({ onRefresh }: { onRefresh: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const refreshAction = useActionFeedback({ spin: true });
  const refreshing = refreshAction.feedback === "running";
  return (
    <button
      type="button"
      aria-label={t("common.refresh")}
      title={t("common.refresh")}
      disabled={refreshing}
      onClick={() => {
        if (refreshing) return;
        // The callback owns its error state; feedback already settles as failed.
        void refreshAction.start(() => Promise.resolve(onRefresh())).catch(() => {});
      }}
      className="flex size-7 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary disabled:cursor-default"
    >
      <ActionFeedbackIcon
        icon={RefreshCw}
        feedback={refreshAction.feedback}
        spin
        iconClassName="size-3.5"
      />
    </button>
  );
}

/** Optional header actions: catalog refresh (flyout + dialog) and/or the
 * dialog's dismiss button. Renders nothing when neither applies. */
function PanelActions({
  onRefresh,
  onClose,
}: {
  onRefresh?: () => void | Promise<void>;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  if (!onRefresh && !onClose) return null;
  return (
    <span className="mr-1 flex shrink-0 items-center">
      {onRefresh && <RefreshButton onRefresh={onRefresh} />}
      {onClose && (
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </span>
  );
}

/** The scrollable radio-group model list: provider-sectioned (search
 * included) when the catalog mixes sources, flat otherwise; an exhausted
 * search shows the no-match hint. */
function ModelGroupList({
  groups,
  empty,
  loading,
  selectedModelId,
  engineId,
  onPickModel,
}: {
  groups: ModelGroup[];
  empty: boolean;
  /** Catalog probe still running: the list on screen may be incomplete. */
  loading?: boolean;
  selectedModelId: string;
  engineId: string;
  onPickModel: (engine: string, id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex max-h-[240px] w-full flex-col overflow-y-auto"
      role="radiogroup"
      aria-label={t("chat.modelPicker")}
    >
      {groups.map((group) => (
        <div key={group.key || "__flat__"} className="flex w-full flex-col">
          {group.key && (
            <span className="sticky top-0 z-10 bg-background-primary-default px-2 pt-1.5 pb-0.5 text-body-2-medium text-text-tertiary">
              {group.key}
            </span>
          )}
          {modelChoiceRows(engineId, group.rows).map((row) => row.variants ? (
            <ModelVariantsRow key={row.key} row={row} selectedModelId={selectedModelId} engineId={engineId} onPick={onPickModel} />
          ) : (
            <ModelRow
              key={row.key || "__default__"}
              option={row.model}
              selected={row.model.id === selectedModelId}
              engineId={engineId}
              onPick={onPickModel}
            />
          ))}
        </div>
      ))}
      {loading && !empty && (
        <span className="px-2 pt-1 pb-2 text-body-2-regular text-text-tertiary">
          {t("chat.modelsLoading")}
        </span>
      )}
      {empty && (
        <span className="p-2 text-body-medium text-text-tertiary">
          {t("chat.noMatchingModels")}
        </span>
      )}
    </div>
  );
}

/** Filters the catalog by the search query and shapes the rows for
 *  ModelGroupList: provider sections layer the list whenever the engine's
 *  catalog mixes sources (OMP serving several relays) — including while
 *  filtering, so the results keep naming their origin instead of collapsing
 *  into identical rows. Pinning the active row to the top would tear it out
 *  of its section, so a grouped list keeps the catalog order and marks the
 *  pick in place; only a flat single-source list reorders to surface the
 *  pick. The section holding the current pick leads so the selection is
 *  never scrolled out of view; within sections the catalog order stands. */
function useOrderedModelGroups(
  models: ModelOption[],
  query: string,
  selectedModelId: string,
): { groups: ModelGroup[]; empty: boolean } {
  return useMemo(() => {
    const filtered = filterModels(models, query.trim().toLowerCase());
    const groups = groupModelsByProvider(filtered);
    // Sectioned whenever the grouping carried keys — a single provider
    // still gets its header (the group is keyless only when no provider is
    // known).
    const layered = groups.length > 0 && groups[0].key !== "";
    if (layered) {
      const ordered = [...groups].sort(
        (a, b) =>
          Number(b.rows.some((m) => m.id === selectedModelId)) -
          Number(a.rows.some((m) => m.id === selectedModelId)),
      );
      return { groups: ordered, empty: filtered.length === 0 };
    }
    const flat = [...filtered].sort(
      (a, b) =>
        Number(b.id === selectedModelId) - Number(a.id === selectedModelId),
    );
    return { groups: [{ key: "", rows: flat }], empty: flat.length === 0 };
  }, [models, query, selectedModelId]);
}

/** The search field filtering the model list. */
function ModelSearchField({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative mx-1 -mt-1.5 pb-1">
      <Search
        className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-[calc(50%+2px)] text-foreground-icon-secondary"
        aria-hidden
      />
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={t("chat.modelSearchPlaceholder")}
        aria-label={t("chat.modelSearchPlaceholder")}
        className="h-8 w-full rounded-md border border-separator-border bg-background-secondary-default pr-2 pl-7 text-body-regular text-text-primary outline-none placeholder:text-text-tertiary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      />
    </div>
  );
}

/** Panel footer: full-bleed divider (like the reference submenu) over the
 *  effort section. For OMP models supporting Fast mode and for Codex the
 *  effort header additionally carries the speed-tier picker. */
function EffortFooter({
  engineId,
  selectedModelId,
  effort,
  onEffortChange,
  claudeUltracode = false,
  onClaudeUltracodeChange,
  ompServiceTier,
  onOmpServiceTierChange,
  codexServiceTier,
  onCodexServiceTierChange,
  selectionScope,
}: {
  engineId: string;
  selectedModelId: string;
  effort: EffortLevel;
  onEffortChange: (engine: string, level: EffortLevel) => void;
  claudeUltracode?: boolean;
  onClaudeUltracodeChange?: (enabled: boolean) => void;
  ompServiceTier?: OmpServiceTier;
  onOmpServiceTierChange?: (tier: OmpServiceTier) => Promise<void>;
  codexServiceTier?: OmpServiceTier;
  onCodexServiceTierChange?: (tier: OmpServiceTier) => Promise<void>;
  selectionScope?: "chat" | "task";
}) {
  const { t } = useTranslation();
  const ultracodeDescriptionId = useId();
  const displayEffort = normalizeEffortLevel(engineId, effort);
  const ompFast = engineId === "omp" && supportsOmpFastMode(selectedModelId);
  const codexFast = engineId === "codex";
  const showFast = selectionScope !== "task" && (ompFast || codexFast);
  const fastTier = codexFast ? codexServiceTier : ompServiceTier;
  const onFastChange = codexFast ? onCodexServiceTierChange : onOmpServiceTierChange;
  const header = showFast && onFastChange ? (
    <OmpSpeedSection
      model={selectedModelId}
      supported={codexFast || undefined}
      value={fastTier ?? null}
      onChange={onFastChange}
    >
      <span className="text-body-medium text-text-secondary">{t("chat.effort")}</span>
    </OmpSpeedSection>
  ) : undefined;
  return (
    <>
      <div aria-hidden className={cx("-mx-1 mt-[7px] h-px bg-border-button-default", showFast ? "mb-1" : "mb-3")} />
      <FlyoutEffortSection
        levels={getEffortLevels(engineId).filter((level) => selectionScope !== "task" || engineId !== "pi" || level !== "ultra")}
        header={header}
        effort={displayEffort}
        onChange={(level) => onEffortChange(engineId, level)}
      />
      {selectionScope !== "task" && engineId === "claude" && (
        <div className="flex items-start justify-between gap-3 px-2 pb-2">
          <div className="min-w-0 flex-1">
            <span className="text-body-medium text-text-primary">{t("chat.ultracode")}</span>
            <p id={ultracodeDescriptionId} className="mt-1 text-body-2-regular text-text-secondary">
              {t("chat.ultracodeDescription")}
            </p>
          </div>
          <Switch
            size="sm"
            className="mt-1 shrink-0"
            aria-label={t("chat.ultracode")}
            aria-describedby={ultracodeDescriptionId}
            isSelected={claudeUltracode}
            isDisabled={!onClaudeUltracodeChange}
            onChange={onClaudeUltracodeChange}
          />
        </div>
      )}
    </>
  );
}

/**
 * Engine model panel content: "{name} 引擎" header over a search field over
 * checkmark model rows over the effort slider. Shared by the desktop flyout
 * (EngineFlyout) and the mobile second-level dialog; `onClose` adds a
 * dismiss button to the header, which only the dialog passes. Model picks
 * stay in-panel so Fast / effort can follow without reopening.
 */
export function EngineModelPanel({
  option,
  models,
  selectedModelId,
  query,
  onQueryChange,
  effort,
  onPickModel,
  onEffortChange,
  claudeUltracode,
  onClaudeUltracodeChange,
  channels,
  selectedChannelId,
  onPickChannel,
  ompServiceTier,
  onOmpServiceTierChange,
  codexServiceTier,
  onCodexServiceTierChange,
  onRefresh,
  onClose,
  loading,
  cursorModels,
  selectionScope = "chat",
}: {
  option: MenuOption;
  models: ModelOption[];
  selectedModelId: string;
  query: string;
  onQueryChange: (value: string) => void;
  effort: EffortLevel;
  onPickModel: (engine: string, id: string) => void;
  onEffortChange: (engine: string, level: EffortLevel) => void;
  claudeUltracode?: boolean;
  onClaudeUltracodeChange?: (enabled: boolean) => void;
  channels?: ChannelOption[];
  selectedChannelId?: string;
  onPickChannel?: (engine: string, id: string) => void;
  ompServiceTier?: OmpServiceTier;
  onOmpServiceTierChange?: (tier: OmpServiceTier) => Promise<void>;
  codexServiceTier?: OmpServiceTier;
  onCodexServiceTierChange?: (tier: OmpServiceTier) => Promise<void>;
  selectionScope?: "chat" | "task";
  /** Re-probe provider configs and model catalogs without an app restart. */
  onRefresh?: () => void | Promise<void>;
  onClose?: () => void;
  /** This engine's catalog probe is still running. */
  loading?: boolean;
  /** Cursor 的基础模型。有它时不再按努力档铺开文本目录。 */
  cursorModels?: CursorModel[];
}) {
  const { t } = useTranslation();
  const { groups, empty } = useOrderedModelGroups(models, query, selectedModelId);
  // Header channel filter (empty = the full channel list). Engines without
  // channels (omp until one is added in settings) get no channel UI at all —
  // an empty-array channels prop is still truthy, and a filter box that
  // narrows nothing is worse than none.
  const [channelQuery, setChannelQuery] = useState("");
  const engineChannels = channels ?? [];
  const hasChannels = engineChannels.length > 0;
  if (option.disabled) return null;

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="min-w-0 flex-1 truncate px-2 py-1.5 text-body-medium text-text-secondary">
          {t("chat.engineHeader", {
            name: CLI_DISPLAY_NAMES[option.id] ?? option.label,
          })}
        </span>
        {hasChannels && onPickChannel && (
          <ChannelFilterField query={channelQuery} onQueryChange={setChannelQuery} />
        )}
        <PanelActions onRefresh={onRefresh} onClose={onClose} />
      </div>
      {hasChannels && onPickChannel && (
        <ChannelPicker
          channels={engineChannels}
          selectedChannelId={selectedChannelId ?? ""}
          engineId={option.id}
          onPickChannel={onPickChannel}
          query={channelQuery}
          onQueryChange={setChannelQuery}
        />
      )}
      <ModelSearchField query={query} onQueryChange={onQueryChange} />
      {option.id === "cursor" && cursorModels && cursorModels.length > 0 ? (
        <CursorModelList
          models={cursorModels}
          selectedModelId={selectedModelId}
          query={query}
          onPick={(id) => onPickModel(option.id, id)}
        />
      ) : (
      <ModelGroupList
        groups={groups}
        empty={empty}
        loading={loading}
        selectedModelId={selectedModelId}
        engineId={option.id}
        onPickModel={onPickModel}
      />
      )}
      {option.id !== "cursor" && supportsEffort(option.id) && !encodedModelEffort(option.id, selectedModelId) && (
        <EffortFooter
          selectionScope={selectionScope}
          engineId={option.id}
          selectedModelId={selectedModelId}
          effort={effort}
          onEffortChange={onEffortChange}
          claudeUltracode={claudeUltracode}
          onClaudeUltracodeChange={onClaudeUltracodeChange}
          ompServiceTier={ompServiceTier}
          onOmpServiceTierChange={onOmpServiceTierChange}
          codexServiceTier={codexServiceTier}
          onCodexServiceTierChange={onCodexServiceTierChange}
        />
      )}
    </div>
  );
}

/** Desktop-only wrapper: the model panel as a flyout popping to the right of
 *  the CLI popover. On mobile CliMenu renders the same panel in a modal
 *  dialog instead (hover flyouts don't work on touch). */
export function EngineFlyout(props: Parameters<typeof EngineModelPanel>[0]) {
  // data-engine-flyout: CliMenu's hover-intent guard checks focus against
  // this marker so hovering a row never swaps the panel while the user is
  // typing in its search / channel filter.
  return (
    <div data-engine-flyout className={FLYOUT_CLASSES}>
      <EngineModelPanel {...props} />
    </div>
  );
}
