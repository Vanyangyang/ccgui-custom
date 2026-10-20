import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Composer,
  StatusBar,
  type ComposerInputHandle,
} from "@/components/application/ai-chat/ai-chat-composer";
import { MessageQueue } from "@/components/application/ai-chat/message-queue";
import { engineSupportsCompact } from "@/components/application/ai-chat/app-commands";
import type { ContextSegment } from "@/components/application/agent-limits/agent-limits-card";
import type { BranchInfo, Workspace } from "@/lib/ipc";
import type { ActiveSession, QueuedMessage, QueueMoveDirection } from "../store";
import { useChatStore } from "../store";
import { ImageLightbox } from "@/components/base/image-lightbox";
import { submitImageAnnotation, useImageAnnotationTarget } from "./image-annotation-target";
import { imageMetaText } from "@/utils/image-meta";
import type { AttachmentPreview } from "./use-composer-images";
import { RunStatusStrip } from "./RunStatusStrip";
import { QuestionDock, usePendingQuestion } from "./QuestionDock";
import { PlanReviewDock, usePendingPlanReview } from "./PlanReviewDock";
import { ErrorBanner } from "./ErrorBanner";
import { sessionKey } from "../store";
import { BtwOverlayCard } from "@/features/sidechat/BtwOverlayCard";
import { HandoffOverlayCard } from "./HandoffOverlayCard";
import { CrossSessionQueue } from "./CrossSessionQueue";
import { SessionSendCostApproval } from "./CrossSessionCostApproval";
import { ComposerSlotExtras } from "@/features/plugins/boundary/composer-slot-extras";
import { COMPOSER_DRAFT_TOPIC, pluginBus } from "@/features/plugins/runtime/events";
import { cursorContextOccupancyKnown, selectCursorContext } from "../usage";
import { USAGE_PART_LABEL_KEYS, usageBreakdown } from "./usage-breakdown";
import { CONVERSATION_FILE_DROP_SELECTOR, useComposerFileDrop } from "./use-composer-file-drop";
import { useClaudeContextWindow } from "./use-claude-context-window";
import { useCodexContextWindow } from "./use-codex-context-window";
import { CodexContextWindowEditor } from "./CodexContextWindowEditor";
import { contextDisplayMax } from "../claude-context-window";
import { ContextWindowEditor } from "./ContextWindowEditor";
import { useClaudeQuota } from "./use-claude-quota";
import { ClaudeQuotaStatus } from "./ClaudeQuotaStatus";
import { useCodexQuota } from "./use-codex-quota";
import { CodexQuotaStatus } from "./CodexQuotaStatus";
import { ThroughputStatus } from "./ThroughputStatus";
import { useAgyQuota } from "./use-agy-quota";
import { AgyQuotaStatus } from "./AgyQuotaStatus";
import { CursorQuotaStatus } from "./CursorQuotaStatus";
import { useCursorQuota } from "./use-cursor-quota";
import { selectAgyContext } from "./agy-context";
import { useAgyContextWindow } from "./use-agy-context-window";
import { AgyContextWindowEditor } from "./AgyContextWindowEditor";
import type { ThroughputState } from "../throughput";
import { InlineAside } from "@/features/assistant-notices/InlineAside";
import { chatHostVisible, subscribeChatHostPresence } from "@/features/assistant-notices/host-presence";
import { useHandoffStore } from "../session-cleanup";
import { usePromptCacheHeat } from "../use-prompt-cache";
import { cacheWindowText, getPromptCacheHeatRatio, promptCacheForEngine } from "../prompt-cache";

/** Path → trailing name (folder or file) for status-bar and chip labels.
 *  Both separators: workspace/attachment paths are native — backslashes on
 *  Windows — matching fileName in features/files/store. */
function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Composer attachment chip lightbox target: preview URL + display name. */
type ZoomImage = { src: string; name: string } | null;


/** One attachment chip: thumbnail + name button zooms the preview, × removes. */
function AttachmentChip({
  path,
  preview,
  onRemove,
  onZoom,
}: {
  path: string;
  preview: AttachmentPreview | undefined;
  onRemove: (path: string) => void;
  onZoom: (zoom: NonNullable<ZoomImage>) => void;
}) {
  const { t } = useTranslation();
  const annotationTarget = useImageAnnotationTarget();
  const name = preview?.name ?? baseName(path);
  const meta = preview ? imageMetaText(preview) : "";
  return (
    <span
      className="inline-flex items-center rounded-full bg-background-tertiary-default text-caption-1-medium text-text-secondary"
    >
      <button
        type="button"
        data-onboarding-target={preview && annotationTarget ? "image-preview" : undefined}
        onClick={() =>
          preview && onZoom({ src: preview.url, name: preview.name })
        }
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-l-full py-0.5 pl-0.5"
        aria-label={name}
      >
        {preview && (
          <img
            src={preview.url}
            alt=""
            className="size-6 shrink-0 rounded-full object-cover"
          />
        )}
        <span className="max-w-48 truncate">{name}</span>
        {meta && (
          <span className="shrink-0 whitespace-nowrap text-text-tertiary">
            {meta}
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={() => onRemove(path)}
        className="cursor-pointer rounded-r-full py-0.5 pr-2 pl-1 hover:text-text-primary"
      >
        ×
      </button>
    </span>
  );
}

/** Attachment chip row above the composer; hidden with no attachments. */
function AttachmentChips({
  images,
  previews,
  onRemoveImage,
  onZoomImage,
}: {
  images: string[];
  previews: Record<string, AttachmentPreview>;
  onRemoveImage: (path: string) => void;
  onZoomImage: (zoom: NonNullable<ZoomImage>) => void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex flex-wrap gap-1.5">
        {images.map((path) => (
          <AttachmentChip
            key={path}
            path={path}
            preview={previews[path]}
            onRemove={onRemoveImage}
            onZoom={onZoomImage}
          />
        ))}
      </div>
    </div>
  );
}

/** Active session's run status; renders idle placeholders with no session. */
function ActiveRunStatus({ active }: { active: ActiveSession | null }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <RunStatusStrip
        sessionKey={active ? sessionKey(active.engine, active.sessionId, active.workspacePath) : ""}
        engine={active?.engine ?? ""}
        workspacePath={active?.workspacePath ?? ""}
      />
    </div>
  );
}

/** Only the focused pane presents an aside; the native window handles other sources. */
function ConversationAside({ active }: { active: ActiveSession | null }) {
  // Center surfaces stay mounted when hidden. Withdraw the source so hidden
  // cards release their hover/focus leases and stop reading the native feed.
  const chatVisible = useSyncExternalStore(subscribeChatHostPresence, chatHostVisible, () => false);
  const focused = useChatStore(s => Boolean(active?.sessionId
    && s.active?.engine === active.engine && s.active.sessionId === active.sessionId
    && s.active.workspacePath === active.workspacePath));
  const source = useMemo(() => chatVisible && focused && active?.sessionId ? {
    engine: active.engine, sessionId: active.sessionId, workspacePath: active.workspacePath,
  } : null, [chatVisible, focused, active?.engine, active?.sessionId, active?.workspacePath]);
  return <InlineAside source={source} />;
}

/** Composer with its slot menus, disabled state, and image-paste wiring. */
function FooterComposer({
  active,
  draft,
  onDraftChange,
  onSubmit,
  onQueue,
  sendShortcut,
  onStop,
  streaming,
  noEnabledEngines,
  images,
  composerInputRef,
  addMenu,
  cliMenu,
  permissionMenu,
  supportsImages,
  onPasteImages,
}: {
  active: ActiveSession | null;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onQueue?: (value: string) => void;
  sendShortcut: string;
  onStop: () => void;
  streaming: boolean;
  noEnabledEngines: boolean;
  images: string[];
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
  addMenu: ReactNode;
  cliMenu: ReactNode;
  permissionMenu: ReactNode;
  supportsImages: boolean;
  onPasteImages: (files: File[]) => void;
}) {
  return (
    <Composer
      className="mx-auto max-w-3xl"
      value={draft}
      onValueChange={onDraftChange}
      onSubmit={onSubmit}
      onQueue={onQueue}
      sendShortcut={sendShortcut === "cmdEnter" ? "cmdEnter" : "enter"}
      onStop={onStop}
      streaming={streaming}
      disabled={!active || noEnabledEngines || (!draft.trim() && images.length === 0)}
      inputRef={composerInputRef}
      addMenu={<>{addMenu}<ComposerSlotExtras slot="addMenu" /></>}
      cliMenu={<>{cliMenu}<ComposerSlotExtras slot="cliMenu" /></>}
      permissionMenu={<>{permissionMenu}<ComposerSlotExtras slot="permissionMenu" /></>}
      onPasteImages={supportsImages ? onPasteImages : undefined}
      workspacePath={active?.workspacePath}
      sessionKey={active ? sessionKey(active.engine, active.sessionId, active.workspacePath) : undefined}
    />
  );
}

/** Branch/folder/usage status bar under the composer. The quick-switch
 * folder chip mirrors the sidebar: archived workspaces stay hidden until
 * unarchived. */
function FooterStatusBar({
  active,
  streaming,
  workspaces,
  sessionUsage,
  throughput,
  contextMax,
  contextMaxKnown,
  model,
  providerId,
  branch,
  branches,
  branchRepoName,
  onBranchOpen,
  onBranchSelect,
  startNewChat,
}: {
  active: ActiveSession | null;
  streaming: boolean;
  workspaces: Workspace[];
  sessionUsage: unknown;
  throughput?: ThroughputState | null;
  contextMax: number;
  contextMaxKnown: boolean;
  model?: string;
  providerId?: string;
  branch: string | undefined;
  branches: BranchInfo[] | undefined;
  branchRepoName: string | undefined;
  onBranchOpen?: () => void;
  onBranchSelect: (name: string) => void;
  startNewChat: (workspacePath: string) => void;
}) {
  const { t } = useTranslation();
  // Same denominator as the breakdown card (contextMax), so the ring pill
  // and the card never disagree.
  const activeEngine = useChatStore((s) => s.activeEngine);
  const displayEngine = active?.engine ?? activeEngine;
  const quota = useClaudeQuota(displayEngine, providerId, active?.workspacePath);
  const codexQuota = useCodexQuota(displayEngine, providerId, active?.workspacePath);
  const agyQuota = useAgyQuota(displayEngine, providerId, active?.workspacePath);
  const cursorQuota = useCursorQuota(displayEngine);
  const { window: autoCompactWindow, block: contextWindowBlock, refresh: refreshContextWindow, save: saveContextWindow } = useClaudeContextWindow(displayEngine);
  const codexContextWindow = useCodexContextWindow(displayEngine, providerId, active?.workspacePath);
  const displayMax = contextDisplayMax(contextMax, autoCompactWindow, contextMaxKnown);
  const usage = useMemo(
    () => usageBreakdown(sessionUsage, displayMax),
    [sessionUsage, displayMax],
  );
  // 【cursor上下文】本机会话状态的当前占用优先；没有它时，整轮合计超出窗口仍显示未知。
  const cursorContext = useMemo(
    () => (displayEngine === "cursor" ? selectCursorContext(sessionUsage, displayMax) : undefined),
    [displayEngine, sessionUsage, displayMax],
  );
  const cursorOccupancyKnown = cursorContext?.occupancyKnown
    || (displayEngine === "cursor" && cursorContextOccupancyKnown(sessionUsage, displayMax));
  const cursorBillingOnly = displayEngine === "cursor" && usage !== null && !cursorOccupancyKnown;
  const cursorSegments = useMemo(() => {
    if (!cursorContext?.occupancyKnown) return undefined;
    const labels: Record<string, string> = {
      system_prompt: t("chat.cursorContextPartSystem"),
      tools: t("chat.cursorContextPartTools"),
      rules: t("chat.cursorContextPartRules"),
      skills: t("chat.cursorContextPartSkills"),
      mcp: t("chat.cursorContextPartMcp"),
      subagents: t("chat.cursorContextPartSubagents"),
      summarized_conversation: t("chat.cursorContextPartSummary"),
      conversation: t("chat.cursorContextPartConversation"),
      uncategorized: t("chat.cursorContextPartOther"),
    };
    return cursorContext.categories.map((category) => ({
      label: labels[category.id] ?? category.id,
      tokens: category.tokens,
    }));
  }, [cursorContext, t]);
  const agyContextWindow = useAgyContextWindow(displayEngine);
  const agyContext = useMemo(() => displayEngine === "agy" ? selectAgyContext(sessionUsage, agyContextWindow.window, contextMaxKnown ? contextMax : undefined) : undefined, [displayEngine, sessionUsage, agyContextWindow.window, contextMax, contextMaxKnown]);
  const contextSegments: ContextSegment[] | undefined = useMemo(
    () =>
      (agyContext?.parts ?? usage?.parts)?.map((p) => ({
        label: t(USAGE_PART_LABEL_KEYS[p.kind]),
        tokens: p.tokens,
      })),
    [usage, agyContext, t],
  );
  const archivedWorkspaces = useChatStore((s) => s.archivedWorkspaces);
  const compactContext = useChatStore((s) => s.compactContext);
  const refreshSessionUsage = useChatStore((s) => s.refreshSessionUsage);
  const [compacting, setCompacting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // 压缩/刷新按本格子的会话 key 发出：分屏时不能再落到全局 active 上。
  const sessionKeyValue = active
    ? sessionKey(active.engine, active.sessionId, active.workspacePath)
    : "";

  const engines = useChatStore((s) => s.engines);
  const canCompactSession =
    engineSupportsCompact(engines, displayEngine) &&
    Boolean(active?.sessionId) &&
    !streaming &&
    !compacting;

  const handleCompact = useCallback(async () => {
    if (!canCompactSession) return;
    if (!active || streaming || compacting) return;
    setCompacting(true);
    try {
      await compactContext(sessionKeyValue);
    } finally {
      setCompacting(false);
    }
  }, [canCompactSession, active, streaming, compacting, compactContext, sessionKeyValue]);

  const handleRefresh = useCallback(async () => {
    if (!active || refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([refreshSessionUsage(sessionKeyValue), refreshContextWindow(), codexContextWindow.refresh(), agyContextWindow.refresh()]);
    } finally {
      // No minimum-visible-busy delay here: the refresh button's feedback
      // finishes the spin lap (and checks) on its own.
      setRefreshing(false);
    }
  }, [active, refreshing, refreshSessionUsage, refreshContextWindow, codexContextWindow.refresh, agyContextWindow.refresh, sessionKeyValue]);

  const visibleWorkspaces = useMemo(
    () => {
      const archivedIds = new Set(archivedWorkspaces);
      return workspaces.filter((w) => !archivedIds.has(w.id));
    },
    [workspaces, archivedWorkspaces],
  );
  const statusFolders = useMemo(() => visibleWorkspaces.map((w) => baseName(w.path)), [visibleWorkspaces]);
  const handleFolderSelect = useCallback(
    (name: string) => {
      const target = visibleWorkspaces.find((w) => baseName(w.path) === name);
      if (target) startNewChat(target.path);
    },
    [visibleWorkspaces, startNewChat],
  );

  const activeMeta = useChatStore((s) =>
    active?.sessionId
      ? s.sessions.find((item) => item.engine === active.engine && item.sessionId === active.sessionId)
      : undefined,
  );
  const enabledCache = promptCacheForEngine(active?.engine, activeMeta?.promptCache);
  const observedCacheHeat = usePromptCacheHeat(enabledCache);
  const cacheHeat = active?.sessionId && active.engine !== "cursor" ? observedCacheHeat : undefined;
  const cacheHeatRatio = active?.sessionId && active.engine !== "cursor"
    ? getPromptCacheHeatRatio(enabledCache, activeMeta?.updatedAt, streaming)
    : undefined;

  const handleArchiveAndHandoff = useCallback(() => {
    if (!active?.sessionId || !activeMeta || streaming) return;
    const currentState = useChatStore.getState().bySession[sessionKeyValue];
    const title = activeMeta.customTitle || activeMeta.title || activeMeta.sessionId.slice(0, 8);
    useHandoffStore.getState().startHandoff({
      workspacePath: active.workspacePath,
      sourceEngine: active.engine,
      sourceSessionId: active.sessionId,
      sourceTitle: title,
      sourceMeta: activeMeta,
      sourceState: currentState,
      archiveSourceOnSend: true,
    });
  }, [active, activeMeta, streaming, sessionKeyValue]);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <StatusBar
        branch={branch}
        branches={branches}
        branchRepoName={branchRepoName}
        onBranchOpen={onBranchOpen}
        onBranchSelect={onBranchSelect}
        folders={statusFolders}
        selectedFolder={active ? baseName(active.workspacePath) : undefined}
        onFolderSelect={handleFolderSelect}
        usagePct={cursorContext?.occupancyKnown ? cursorContext.pct : agyContext ? agyContext.pct : usage?.pct}
        contextMax={cursorContext?.occupancyKnown && cursorContext.max ? cursorContext.max : agyContext ? agyContext.max : displayMax}
        contextMaxKnown={cursorContext?.occupancyKnown ? true : agyContext?.capacityKnown ?? contextMaxKnown}
        contextOccupancyKnown={cursorContext?.occupancyKnown ? true : agyContext?.occupancyKnown ?? (displayEngine === "cursor" ? cursorOccupancyKnown : usage !== null)}
        contextShowCapacity={agyContext?.capacityKnown ?? (displayEngine === "cursor" && contextMaxKnown)}
        contextCountsKnown={agyContext?.countsKnown}
        contextLabel={agyContext ? t(agyContext.labelKey) : undefined}
        contextNote={cursorBillingOnly ? t("chat.cursorContextBilling") : agyContext?.noteKey ? t(agyContext.noteKey) : undefined}
        autoCompactWindow={autoCompactWindow}
        modelContextMax={agyContext ? agyContext.reportedMax : autoCompactWindow && contextMaxKnown ? contextMax : undefined}
        contextSegments={cursorSegments ?? (cursorBillingOnly ? [] : contextSegments)}
        onContextOpen={() => { void refreshContextWindow(); void codexContextWindow.refresh(); void agyContextWindow.refresh(); }}
        quotaStatus={quota.enabled ? <ClaudeQuotaStatus snapshot={quota.snapshot} now={quota.now} loading={quota.loading} refresh={quota.refresh} /> : codexQuota.enabled ? <CodexQuotaStatus snapshot={codexQuota.snapshot} now={codexQuota.now} loading={codexQuota.loading} refresh={codexQuota.refresh} /> : agyQuota.enabled ? <AgyQuotaStatus model={model} snapshot={agyQuota.snapshot} now={agyQuota.now} loading={agyQuota.loading} refresh={agyQuota.refresh} /> : cursorQuota.enabled ? <CursorQuotaStatus snapshot={cursorQuota.snapshot} now={cursorQuota.now} loading={cursorQuota.loading} refresh={cursorQuota.refresh} /> : undefined}
        throughputStatus={active ? <ThroughputStatus key={sessionKeyValue} throughput={throughput} scope={{engine: active.engine, sessionId: active.sessionId ?? undefined, workspacePath: active.workspacePath}} /> : undefined}
        contextSettings={displayEngine === "claude" ? <ContextWindowEditor
          window={autoCompactWindow} modelWindow={contextMax} block={contextWindowBlock} onSave={saveContextWindow}
        /> : displayEngine === "codex" ? <CodexContextWindowEditor
          key={JSON.stringify([displayEngine, providerId, active?.workspacePath])}
          settings={codexContextWindow.settings} reportedWindow={contextMaxKnown ? contextMax : undefined} onSave={codexContextWindow.save}
        /> : displayEngine === "agy" ? <AgyContextWindowEditor
          window={agyContextWindow.window} reportedWindow={agyContext?.reportedMax} onSave={agyContextWindow.save}
        /> : undefined}
        onCompactContext={handleCompact}
        onRefreshUsage={handleRefresh}
        compacting={compacting}
        refreshing={refreshing}
        canCompact={canCompactSession}
        cacheHeat={cacheHeat}
        cacheHeatRatio={cacheHeatRatio}
        cacheNote={cacheHeat ? cacheWindowText(t, enabledCache, cacheHeat) : undefined}
        onArchiveAndHandoff={active?.sessionId && activeMeta && !streaming && !enabledCache?.reference ? () => void handleArchiveAndHandoff() : undefined}
      />
    </div>
  );
}

/** Attachment preview lightbox; hidden until a chip is clicked. The chip is
 *  already attached, so annotation adds only the annotated copy. */
function AttachmentLightbox({
  zoom,
  onClose,
}: {
  zoom: ZoomImage;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const target = useImageAnnotationTarget();
  if (!zoom) return null;
  return <ImageLightbox src={zoom.src} name={zoom.name} onClose={onClose}
    annotation={target ? { onSubmit: (boxes) => submitImageAnnotation(target, { ...zoom, includeOriginal: false }, boxes, t) } : undefined} />;
}

/** Bottom column of the conversation: the message queue, error banners,
 * attachment chips, the composer, and the branch/folder/usage status bar. */
export function ConversationFooter({
  active,
  workspaces,
  queue,
  onRemoveQueued,
  onMoveQueued,
  onSendQueuedNow,
  onClearQueued,
  imageError,
  branchError,
  onDismissImageError,
  onDismissBranchError,
  images,
  previews,
  onRemoveImage,
  draft,
  onDraftChange,
  onSubmit,
  onQueue,
  sendShortcut,
  onStop,
  streaming,
  noEnabledEngines,
  composerInputRef,
  addMenu,
  cliMenu,
  permissionMenu,
  supportsImages,
  onPasteImages,
  onDropPaths,
  onDropFiles,
  sessionUsage,
  throughput,
  contextMax,
  contextMaxKnown = true,
  model,
  providerId,
  branch,
  branches,
  branchRepoName,
  onBranchOpen,
  onBranchSelect,
  startNewChat,
}: {
  active: ActiveSession | null;
  workspaces: Workspace[];
  queue: QueuedMessage[];
  onRemoveQueued: (id: string) => void;
  onMoveQueued: (id: string, direction: QueueMoveDirection) => void;
  onSendQueuedNow: (id: string) => void;
  onClearQueued?: () => void;
  imageError: string | null;
  branchError: string | null;
  onDismissImageError: () => void;
  onDismissBranchError: () => void;
  images: string[];
  previews: Record<string, AttachmentPreview>;
  onRemoveImage: (path: string) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onQueue?: (value: string) => void;
  sendShortcut: string;
  onStop: () => void;
  streaming: boolean;
  noEnabledEngines: boolean;
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
  addMenu: ReactNode;
  cliMenu: ReactNode;
  permissionMenu: ReactNode;
  supportsImages: boolean;
  onPasteImages: (files: File[]) => void;
  /** OS files dropped on the composer (desktop: absolute paths). Absent =
   *  no active session: drops stay ignored. */
  onDropPaths?: (paths: string[]) => void;
  /** Web-bridge drop: image File blobs only (browsers expose no path). */
  onDropFiles?: (files: File[]) => void;
  sessionUsage: unknown;
  throughput?: ThroughputState | null;
  contextMax: number;
  contextMaxKnown?: boolean;
  model?: string;
  providerId?: string;
  branch: string | undefined;
  branches: BranchInfo[] | undefined;
  onBranchOpen?: () => void;
  onBranchSelect: (name: string) => void;
  branchRepoName: string | undefined;
  startNewChat: (workspacePath: string) => void;
}) {
  /** Composer attachment chip lightbox: preview URL + display name. */
  const [zoomImage, setZoomImage] = useState<ZoomImage>(null);
  // While the CLI waits on an AskUserQuestion the panel takes the composer's
  // place — it covers the input box instead of floating beside it.
  const pendingQuestion = usePendingQuestion();
  // A plan revision awaiting the user's decision takes the same slot; the
  // backend serializes native waiting points, so at most one is pending.
  const pendingPlan = usePendingPlanReview();

  // The draft prop is the store's per-session value, so watching it covers
  // every change source at once: typing, submit-clear, and session switches
  // all re-emit with the latest text (empty string included).
  useEffect(() => {
    pluginBus.emit(COMPOSER_DRAFT_TOPIC, { text: draft });
  }, [draft]);

  const { t } = useTranslation();
  // 文件拖放落在整列对话（消息区 + 输入区）。图片变附件，其他文件在光标处变成 @引用。
  const { dropRef, isDragOver } = useComposerFileDrop({
    disabled: !onDropPaths,
    onDropPaths,
    onDropFiles,
  });
  const dropHint = isDragOver ? (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-border-focus-ring bg-background-primary-default/85">
      <span className="text-body-medium text-text-secondary">
        {t("chat.dropFilesHint")}
      </span>
    </div>
  ) : null;
  // 提示盖住对话栏整列；没有标记时仍画在输入区上，避免单测和旧挂载点空白。
  const hintHost = dropRef.current?.closest<HTMLElement>(CONVERSATION_FILE_DROP_SELECTOR) ?? null;

  return (
    <>
      {dropHint && hintHost ? createPortal(dropHint, hintHost) : null}
      <div
        ref={dropRef}
        className="relative flex w-full flex-col gap-2.5 bg-background-primary-default px-4 pt-2.5 pb-2"
      >
        {dropHint && !hintHost ? dropHint : null}
        <MessageQueue
          queue={queue}
          onRemove={onRemoveQueued}
          onMove={onMoveQueued}
          onSendNow={onSendQueuedNow}
          sendNowLabel={streaming && onQueue ? t("chat.steer") : undefined}
          sendNowTitle={streaming && onQueue ? t("chat.steerTooltip") : undefined}
          onClear={onClearQueued}
          className="mx-auto w-full max-w-3xl"
        />
        <CrossSessionQueue active={active} className="mx-auto w-full max-w-3xl" />
        <SessionSendCostApproval active={active} className="mx-auto w-full max-w-3xl" />
        <ErrorBanner message={imageError} onDismiss={onDismissImageError} />
        <ErrorBanner message={branchError} onDismiss={onDismissBranchError} />
        <AttachmentChips
          images={images}
          previews={previews}
          onRemoveImage={onRemoveImage}
          onZoomImage={setZoomImage}
        />
        <BtwOverlayCard
          sessionKey={active ? sessionKey(active.engine, active.sessionId, active.workspacePath) : ""}
        />
        <HandoffOverlayCard active={active} model={model} />
        <ConversationAside active={active} />
        <ActiveRunStatus active={active} />

        {pendingPlan ? (
          <PlanReviewDock />
        ) : pendingQuestion ? (
          <QuestionDock />
        ) : (
          <FooterComposer
            active={active}
            draft={draft}
            onDraftChange={onDraftChange}
            onSubmit={onSubmit}
            onQueue={onQueue}
            sendShortcut={sendShortcut}
            onStop={onStop}
            streaming={streaming}
            noEnabledEngines={noEnabledEngines}
            images={images}
            composerInputRef={composerInputRef}
            addMenu={addMenu}
            cliMenu={cliMenu}
            permissionMenu={permissionMenu}
            supportsImages={supportsImages}
            onPasteImages={onPasteImages}
          />
        )}
        <FooterStatusBar
          active={active}
          streaming={streaming}
          workspaces={workspaces}
          sessionUsage={sessionUsage}
          throughput={throughput}
          contextMax={contextMax}
          contextMaxKnown={contextMaxKnown}
          model={model}
          providerId={providerId}
          branch={branch}
          branches={branches}
          branchRepoName={branchRepoName}
          onBranchOpen={onBranchOpen}
          onBranchSelect={onBranchSelect}
          startNewChat={startNewChat}
        />

      </div>
      <AttachmentLightbox zoom={zoomImage} onClose={() => setZoomImage(null)} />
    </>
  );
}
