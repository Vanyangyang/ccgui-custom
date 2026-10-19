"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import {
  AgentLimitsCard,
  type ContextSegment,
  type UsageLimit,
} from "@/components/application/agent-limits/agent-limits-card";
import { ProjectFolderMenu } from "@/components/application/ai-chat/project-folder-menu";
import {
  BranchMenu,
  type BranchMenuItem,
} from "@/components/application/ai-chat/branch-menu";
import { ComposerResizeHandle } from "@/components/application/ai-chat/composer-resize-handle";
import { ComposerEditable } from "@/components/application/ai-chat/composer-editable";
import { ComposerToolbar } from "@/components/application/ai-chat/composer-toolbar";
import { ComposerPickerMenus } from "@/components/application/ai-chat/composer-picker-menus";
import { SelectedAgentChip } from "@/components/application/ai-chat/composer-agent-chip";
import { useComposerPickers } from "@/components/application/ai-chat/use-composer-pickers";
import { useComposerInputHandle } from "@/components/application/ai-chat/use-composer-input-handle";
import { useResizableComposer } from "@/components/application/ai-chat/use-resizable-composer";
import {
  FILE_TAG_CLASS,
  extractText,
  htmlFromText,
  renderFileTags,
  sanitizeEditableHtml,
  setCaretOffset,
} from "@/components/application/ai-chat/file-tags";
import { ASSUMED_CONTEXT_WINDOW } from "@/features/chat/usage";
import {
  usePromptCompletion,
  usePromptHistoryNav,
} from "@/components/application/ai-chat/use-prompt-history";
import { cx } from "@/utils/cx";
import { formatTokens } from "@/utils/format-tokens";
import { useDismissOnOutsidePress, useTriggerToggle } from "@/utils/use-dismiss-on-outside-press";
import {
  compareByOrder,
  composerStatusRegistry,
  pluginIdFromRegistryKey,
  useRegistry,
} from "@ccgui/plugin-sdk";
import { PluginBoundary } from "@/features/plugins/boundary/PluginBoundary";
import { cacheHeatRingStroke, cacheHeatTextColor } from "@/features/chat/session-cleanup";

/**
 * Board UI → "ai_chat" composer + status bar, adapted to live data. The pill
 * keeps the template visual (add menu, model menu, send control); the field
 * is a textarea so Shift+Enter inserts a newline; while a turn streams the
 * send button becomes a stop control, with optional live-send and queue actions.
 * The status bar renders real branch /
 * workspace / token usage.
 */

/** Imperative handle on the composer's editable field. */
export interface ComposerInputHandle {
  focus: () => void;
  /** Insert plain text at the caret; `@/abs/path` mentions render as chips. */
  insertText: (text: string) => void;
  /** Focus the field and open the `/` picker, appending a line-start `/`
   *  when the caret is not already inside a slash trigger. */
  openSlashPicker: () => void;
}

export interface ComposerProps {
  className?: string;
  /** Controlled field value. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Fires on the send button and on the configured send gesture (sendShortcut). */
  onSubmit?: (value: string) => void;
  /** Optional explicit next-turn action while streaming; submit guides the current turn. */
  onQueue?: (value: string) => void;
  /** Send gesture: "enter" = Enter sends, Shift+Enter newline (default);
   *  "cmdEnter" = ⌘/Ctrl+Enter sends, plain Enter newline. */
  sendShortcut?: "enter" | "cmdEnter";
  /** Fires on the stop button while streaming. */
  onStop?: () => void;
  /** A turn is in flight: show stop and any supplied live-send actions. */
  streaming?: boolean;
  /** Greys out send. */
  disabled?: boolean;
  /** Slot for the add-attachment menu (template AddMenu). */
  addMenu?: ReactNode;
  /** Slot for the CLI + model switcher (CliMenu). */
  cliMenu?: ReactNode;
  /** Slot for the permission-mode picker (PermissionMenu). */
  permissionMenu?: ReactNode;
  /** The field itself, for focus management and mention insertion. */
  inputRef?: MutableRefObject<ComposerInputHandle | null>;
  /** Clipboard images pasted into the field; absent = paste stays text-only. */
  onPasteImages?: (files: File[]) => void;
  /** Active workspace root: enables the `@` file-mention picker. */
  workspacePath?: string;
}

export function Composer({
  className,
  value,
  onValueChange,
  onSubmit,
  onQueue,
  sendShortcut = "enter",
  onStop,
  streaming = false,
  disabled = false,
  addMenu,
  cliMenu,
  permissionMenu,
  inputRef,
  onPasteImages,
  workspacePath,
}: ComposerProps = {}) {
  const editableRef = useRef<HTMLDivElement>(null);
  // IME composition tracking (desktop-cc-gui parity): WKWebView fires
  // `compositionend` BEFORE the Enter keydown that commits the candidate, so
  // `nativeEvent.isComposing` is already false at that keydown and the plain
  // check would send the message. Gate Enter on a sync ref plus a 100ms
  // "recently settled" window after compositionend.
  const isComposingRef = useRef(false);
  const lastCompositionEndTimeRef = useRef(0);
  // Reactive mirror of isComposingRef: gates the ghost completion so IME
  // candidates never produce a suggestion.
  const [isComposing, setIsComposing] = useState(false);

  // Top-edge drag resize (desktop-cc-gui parity): the handle fixes the field
  // at an explicit height; without a manual size the field keeps auto-growing.
  const { isResizing, isCollapsed, manualHeightPx, getHandleProps, nudge } =
    useResizableComposer({ editableRef });

  /** Last text we emitted upward; the value-sync effect skips our own echoes. */
  const lastEmittedRef = useRef("");
  const [submitTick, setSubmitTick] = useState(0);

  const emitChange = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;
    // Keep the DOM truly empty when the text is, so the :empty placeholder
    // shows (browsers like to leave a stray <br> behind). Never wipe the
    // element while an IME composition session is active, or the browser/
    // WebView cancels the active composition and swallows the candidate.
    const text = extractText(el);
    if (!isComposingRef.current && text === "" && el.innerHTML !== "") el.innerHTML = "";
    lastEmittedRef.current = text;
    onValueChange?.(text);
  }, [onValueChange]);

  const syncTags = useCallback(() => {
    const el = editableRef.current;
    if (el && !isComposingRef.current) renderFileTags(el);
  }, []);

  // `@` mention / `/` slash / `#` agent / `!` prompt pickers: trigger
  // tracking, priority arbitration, and select actions live in
  // useComposerPickers. The parent owns the wrapper ref (root div + popover
  // anchor).
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pickers = useComposerPickers({
    editableRef,
    wrapperRef,
    workspacePath,
    value,
    lastEmittedRef,
    emitChange,
    syncTags,
  });
  const {
    mention,
    slash,
    agent,
    prompt,
    mentionMenuRef,
    slashMenuRef,
    agentMenuRef,
    promptMenuRef,
    updateSlashTrigger,
    updateTriggers,
    selectedAgent,
    clearSelectedAgent,
  } = pickers;

  // Ghost-text completion from prompt history (desktop-cc-gui parity):
  // suffix is painted via data-completion-suffix and accepted with Tab.
  const completion = usePromptCompletion(isComposing ? "" : (value ?? ""));

  // Replace the field's content programmatically: rebuild DOM from text and
  // put the caret at its end. Shared by the external-value sync (draft
  // restore) and by history recall / Tab accept below.
  const replaceEditableText = useCallback((text: string) => {
    const el = editableRef.current;
    if (!el) return;
    el.innerHTML = sanitizeEditableHtml(htmlFromText(text));
    setCaretOffset(el, text.length);
  }, []);

  // Replace the field's content and emit upward (history recall, Tab accept).
  const setEditableText = useCallback(
    (text: string) => {
      replaceEditableText(text);
      emitChange();
      syncTags();
    },
    [replaceEditableText, emitChange, syncTags],
  );

  // ArrowUp/ArrowDown recall of previously submitted prompts.
  const { handleKeyDown: handleHistoryKeyDown } = usePromptHistoryNav({
    editableRef,
    setText: setEditableText,
  });

  // External value changes (draft restore on tab switch, clear on submit,
  // 插件中心「创建插件」预填命令): the layout effect below rebuilds the DOM
  // synchronously during commit so a follow-up keystroke or IME composition
  // started right after Enter never lands before a delayed clear.
  //
  // 光标必须我们自己落位：DOM 一重建，浏览器手里的插入点就没了，随后的
  // focus()（例如 creator flow 的 focusComposerWhenVisible）会把光标放到
  // 内容开头。落到文本末尾，用户可以直接接着敲需求。
  useLayoutEffect(() => {
    const v = value ?? "";
    if (v === lastEmittedRef.current) return;
    lastEmittedRef.current = v;
    replaceEditableText(v);
  }, [value, submitTick, replaceEditableText]);

  const handleSubmit = useCallback(
    (submitted: string) => {
      if (value !== undefined) setSubmitTick((n) => n + 1);
      onSubmit?.(submitted);
    },
    [onSubmit, value],
  );

  const handleQueue = useMemo(
    () =>
      onQueue
        ? (queued: string) => {
            if (value !== undefined) setSubmitTick((n) => n + 1);
            onQueue(queued);
          }
        : undefined,
    [onQueue, value],
  );

  // Expose the field handle (focus + mention insertion from the file tree).
  useComposerInputHandle({
    inputRef,
    editableRef,
    emitChange,
    syncTags,
    updateSlashTrigger,
  });

  // Chip × removal via delegation (chips are raw DOM, not React).
  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;
    const onClick = (event: MouseEvent) => {
      const close = (event.target as HTMLElement).closest?.(`.${FILE_TAG_CLASS}-close`);
      if (!close) return;
      event.preventDefault();
      event.stopPropagation();
      close.closest(`.${FILE_TAG_CLASS}`)?.remove();
      emitChange();
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [emitChange]);

  return (
    <div
      ref={wrapperRef}
      className={cx(
        "relative flex w-full flex-col gap-1 rounded-2xl border p-2 shadow-xs",
        isCollapsed
          ? "h-2 gap-0 border-transparent bg-transparent p-0 shadow-none"
          : "border-separator-border bg-background-primary-default",
        className,
      )}
    >
      <ComposerResizeHandle
        getHandleProps={getHandleProps}
        nudge={nudge}
        isResizing={isResizing}
        isCollapsed={isCollapsed}
      />
      <ComposerPickerMenus
        isCollapsed={isCollapsed}
        workspacePath={workspacePath}
        pickers={pickers}
      />

      {/* Pinned-agent chip above the input, styled after the attachment
          chips (ConversationFooter); × clears the selection. */}
      {!isCollapsed && selectedAgent && (
        <SelectedAgentChip agent={selectedAgent} onClear={clearSelectedAgent} />
      )}

      {!isCollapsed && (
        <ComposerEditable
          editableRef={editableRef}
          sendShortcut={sendShortcut}
          mentionOpen={mention != null}
          slashOpen={slash != null}
          agentOpen={agent != null}
          promptOpen={prompt != null}
          completionSuffix={completion.suffix}
          acceptCompletion={completion.accept}
          setEditableText={setEditableText}
          handleHistoryKeyDown={handleHistoryKeyDown}
          mentionMenuRef={mentionMenuRef}
          slashMenuRef={slashMenuRef}
          agentMenuRef={agentMenuRef}
          promptMenuRef={promptMenuRef}
          isComposingRef={isComposingRef}
          lastCompositionEndTimeRef={lastCompositionEndTimeRef}
          setIsComposing={setIsComposing}
          emitChange={emitChange}
          syncTags={syncTags}
          updateTriggers={updateTriggers}
          disabled={disabled}
          onSubmit={handleSubmit}
          onPasteImages={onPasteImages}
          manualHeightPx={manualHeightPx}
        />
      )}

      {!isCollapsed && (
        <ComposerToolbar
          addMenu={addMenu}
          cliMenu={cliMenu}
          permissionMenu={permissionMenu}
          streaming={streaming}
          disabled={disabled}
          onStop={onStop}
          onSend={() =>
            handleSubmit(
              editableRef.current ? extractText(editableRef.current) : (value ?? ""),
            )
          }
          onQueue={
            handleQueue
              ? () =>
                  handleQueue(
                    editableRef.current ? extractText(editableRef.current) : (value ?? ""),
                  )
              : undefined
          }
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- status bar */
const CONTEXT_POPOVER_CLASSES = cx(
  "w-[340px] max-w-[calc(100vw-32px)] origin-bottom-right",
  "rounded-2xl border border-border-button-default bg-background-primary-default p-2 shadow-dropdown",
  "transition duration-150 ease-out",
  "data-[entering]:opacity-0 data-[entering]:scale-95 data-[entering]:blur-[2px]",
  "data-[exiting]:opacity-0 data-[exiting]:scale-95 data-[exiting]:blur-[2px]",
);

const EMPTY_LIMITS: UsageLimit[] = [];
const EMPTY_PLAN = "";

/** 16px circular context meter at `pct` percent. */
function ContextRing({
  pct,
  heat,
  heatRatio,
}: {
  pct: number;
  heat?: "hot" | "cold" | "unknown";
  heatRatio?: number;
}) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const effectiveRatio =
    typeof heatRatio === "number" && Number.isFinite(heatRatio)
      ? heatRatio
      : heat === "hot"
        ? 1
        : 0;
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" className="shrink-0 -rotate-90">
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-agent-progress-ring)" strokeWidth="2.5" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke={cacheHeatRingStroke(effectiveRatio)}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * c} ${c}`}
      />
    </svg>
  );
}

export function StatusBar({
  branch,
  branches,
  branchRepoName,
  onBranchOpen,
  onBranchSelect,
  folders,
  selectedFolder,
  onFolderSelect,
  usagePct,
  contextMax,
  contextMaxKnown = true,
  contextOccupancyKnown = true,
  contextShowCapacity = false,
  contextCountsKnown = false,
  contextLabel,
  contextNote,
  modelContextMax,
  autoCompactWindow,
  contextSegments,
  onContextOpen,
  contextSettings,
  quotaStatus,
  throughputStatus,
  onCompactContext,
  onRefreshUsage,
  compacting,
  refreshing,
  canCompact,
  cacheHeat,
  cacheHeatRatio,
  cacheNote,
  onArchiveAndHandoff,
}: {
  branch?: string;
  /** Local and remote-tracking branches for the switcher; empty until the
   *  first load. */
  branches?: BranchMenuItem[];
  /** Repository display name when the chip tracks a nested repo (file-tree
   *  selection inside a subfolder repository); prefixes the branch label. */
  branchRepoName?: string;
  onBranchOpen?: () => void;
  /** Present → the branch label becomes a switcher dropdown. */
  onBranchSelect?: (name: string) => void;
  /** Workspace folder display names. */
  folders?: string[];
  selectedFolder?: string;
  onFolderSelect?: (name: string) => void;
  usagePct?: number;
  /** Context window size in tokens for the breakdown card. */
  contextMax?: number;
  contextMaxKnown?: boolean;
  contextOccupancyKnown?: boolean;
  /** 占用未知时，药丸和卡片仍显示已知窗口，不显示百分比。 */
  contextShowCapacity?: boolean;
  contextCountsKnown?: boolean;
  /** Localized label/note for request counts that are not current occupancy. */
  contextLabel?: string;
  contextNote?: string;
  /** Model capacity, kept separate when the gauge uses an auto-compact budget. */
  modelContextMax?: number;
  /** Explicit auto-compaction setting, including before model capacity is known. */
  autoCompactWindow?: number;
  /** Token buckets for the breakdown card; empty until usage is reported. */
  contextSegments?: ContextSegment[];
  onContextOpen?: () => void;
  contextSettings?: ReactNode;
  /** Account quota status has its own details, independent of the context meter. */
  quotaStatus?: ReactNode;
  /** Session-scoped host throughput measurement, updated by engine reports. */
  throughputStatus?: ReactNode;
  onCompactContext?: () => void;
  onRefreshUsage?: () => void;
  compacting?: boolean;
  refreshing?: boolean;
  canCompact?: boolean;
  /** Provider retention estimate; unknown is not evidence of a cold cache. */
  cacheHeat?: "hot" | "cold" | "unknown";
  /** Continuous [0, 1] heat ratio for smooth warm-amber ⇄ cool-gray gradient interpolation. */
  cacheHeatRatio?: number;
  cacheNote?: string;
  /** Zero-token archive and handoff into a fresh session when cold. */
  onArchiveAndHandoff?: () => void;
}) {
  const { t } = useTranslation();
  // `isNonModal` popovers don't dismiss on outside press (react-aria couples
  // the two); restore it manually — same fix as Select (see the hook doc).
  const [contextOpen, setContextOpen] = useState(false);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const contextPopoverRef = useRef<HTMLElement>(null);
  useDismissOnOutsidePress(contextOpen, () => setContextOpen(false), [
    contextTriggerRef,
    contextPopoverRef,
  ]);
  const allowContextOpenChange = useTriggerToggle(contextOpen, contextTriggerRef);
  // Plugin chips (SDK 0.3.9, permission ui:composer-status) render in the
  // left group after the branch switcher, each behind its own boundary.
  const pluginItems = useRegistry(composerStatusRegistry);
  const limitsContext = useMemo(
    () => ({ max: contextMax ?? ASSUMED_CONTEXT_WINDOW, segments: contextSegments ?? [], capacityKnown: contextMaxKnown, occupancyKnown: contextOccupancyKnown, showCapacity: contextShowCapacity, countsKnown: contextCountsKnown }),
    [contextMax, contextSegments, contextMaxKnown, contextOccupancyKnown, contextShowCapacity, contextCountsKnown],
  );
  const limitsText = useMemo(
    () => ({
      contextWindow: contextLabel ?? t(autoCompactWindow ? "chat.autoCompactWindow" : "chat.contextWindow"),
      unknown: t("chat.contextUnknown"),
      freeSpace: t("chat.freeSpace"),
      planUsageLimits: t("chat.planUsageLimits"),
      managePlan: t("chat.managePlan"),
      compactContext: t("chat.compactContext"),
      compactContextTooltip: t("chat.compactContextTooltip"),
      compacting: t("chat.compacting"),
      refreshUsage: t("chat.refreshUsage"),
      refreshUsageTooltip: t("chat.refreshUsageTooltip"),
      refreshing: t("chat.refreshing"),
    }),
    [t, autoCompactWindow, contextLabel],
  );
  const effectiveRatio =
    typeof cacheHeatRatio === "number" && Number.isFinite(cacheHeatRatio)
      ? cacheHeatRatio
      : cacheHeat === "hot"
        ? 1
        : cacheHeat === "cold"
          ? 0
          : undefined;
  return (
    <div className="flex min-h-[26px] w-full flex-wrap items-center justify-between gap-x-2 gap-y-1.5 select-none">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {folders && folders.length > 0 && (
          <ProjectFolderMenu
            folders={folders}
            selectedName={selectedFolder}
            onSelect={onFolderSelect}
          />
        )}
        {branch &&
          (onBranchSelect ? (
            <BranchMenu
              branches={branches ?? []}
              currentName={branch}
              repoName={branchRepoName}
              onOpen={onBranchOpen}
              onSelect={onBranchSelect}
            />
          ) : (
            <span className="flex max-w-[260px] items-center gap-1.5 rounded-full border border-border-button-default bg-background-secondary-default px-2.5 py-1">
              <GitBranch
                className="size-3.5 shrink-0 text-foreground-icon-secondary"
                aria-hidden
              />
              <span className="truncate text-caption-1-medium whitespace-nowrap text-text-primary">
                {branch}
              </span>
            </span>
          ))}
        {[...pluginItems].sort(compareByOrder).map((def) => {
          const pluginId = pluginIdFromRegistryKey(def.id);
          const Chip = def.component;
          return (
            <PluginBoundary key={def.id} pluginId={pluginId}>
              <Chip />
            </PluginBoundary>
          );
        })}
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
        {throughputStatus}
        {quotaStatus}
        {/* Keep capacity visible independently of measured occupancy. */}
        <AriaDialogTrigger
          isOpen={contextOpen}
          onOpenChange={(o) => {
            if (!allowContextOpenChange(o)) return;
            setContextOpen(o);
            if (o) onContextOpen?.();
          }}
        >
          <AriaButton
            ref={contextTriggerRef}
            aria-label={limitsText.contextWindow}
            data-cache-heat={cacheHeat}
            data-cache-heat-ratio={effectiveRatio}
            className="flex cursor-pointer items-center gap-1.5 rounded-full bg-background-secondary-default px-2.5 py-1 outline-none transition-colors duration-150 ease hover:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            <span className="text-caption-1-regular text-text-tertiary">{t("chat.contextWindow")}</span>
            {contextMaxKnown && contextOccupancyKnown && (
              <ContextRing pct={usagePct ?? 0} heat={cacheHeat} heatRatio={effectiveRatio} />
            )}
            <span
              style={effectiveRatio !== undefined ? { color: cacheHeatTextColor(effectiveRatio) } : undefined}
              className={cx(
                "text-caption-1-medium whitespace-nowrap tabular-nums transition-colors duration-300",
                cacheHeat === "hot" || (effectiveRatio !== undefined && effectiveRatio >= 0.35)
                  ? "text-text-error-primary"
                  : cacheHeat === "cold" || effectiveRatio === 0
                    ? "text-text-tertiary"
                    : "text-text-secondary",
              )}
            >
              {contextMaxKnown && contextOccupancyKnown ? `${usagePct ?? 0}%` : contextMaxKnown && contextShowCapacity && contextMax ? formatTokens(contextMax) : t("chat.contextUnknown")}
            </span>
          </AriaButton>
          <AriaPopover
            ref={contextPopoverRef}
            isNonModal
            placement="top end"
            offset={8}
            className={CONTEXT_POPOVER_CLASSES}
          >
            <AriaDialog aria-label={limitsText.contextWindow} className="outline-none">
              <AgentLimitsCard
                context={limitsContext}
                plan={EMPTY_PLAN}
                limits={EMPTY_LIMITS}
                text={limitsText}
                onCompact={onCompactContext}
                onRefresh={onRefreshUsage}
                compacting={compacting}
                refreshing={refreshing}
                canCompact={canCompact}
              />
              {contextNote && <p className="px-4 pb-3 text-caption-1-regular text-text-tertiary">{contextNote}</p>}
              {cacheNote && <p className="px-4 pb-3 text-caption-1-regular text-text-tertiary">{cacheNote}</p>}
              {modelContextMax && (
                <p className="px-4 pb-3 text-caption-1-regular text-text-tertiary">
                  {t("chat.modelContextCapacity", { tokens: formatTokens(modelContextMax) })}
                </p>
              )}
              {cacheHeat === "cold" && onArchiveAndHandoff && (
                <div className="mx-2 mt-1 mb-2 flex flex-col gap-2 rounded-xl border border-border-button-default bg-background-secondary-default px-3 py-2.5">
                  <p className="text-caption-1-regular text-text-secondary">
                    {t("chat.cacheColdHandoffHint")}
                  </p>
                  <button
                    type="button"
                    data-testid="archive-handoff-btn"
                    onClick={() => {
                      setContextOpen(false);
                      onArchiveAndHandoff();
                    }}
                    className="inline-flex h-7 w-full cursor-pointer items-center justify-center rounded-lg border border-border-button-default bg-background-primary-default px-2.5 text-caption-1-medium text-text-primary transition-colors duration-150 hover:bg-background-secondary-hover"
                  >
                    {t("chat.archiveAndHandoff")}
                  </button>
                </div>
              )}
              {contextSettings}
            </AriaDialog>
          </AriaPopover>
        </AriaDialogTrigger>
      </div>
    </div>
  );
}
