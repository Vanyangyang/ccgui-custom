import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { mentionToken } from "@/components/application/ai-chat/file-tags";
import { pickFiles } from "@/lib/platform";
import { useChatStore, sessionKey as toSessionKey, type ActiveSession } from "../store";
import {
  resolveLiveSessionKey,
  resolveLiveSessionTab,
  resolveSessionEffort,
  resolveSessionModel,
  resolveSessionProvider,
} from "../store/stream";
import { cursorLaunchModel } from "@/components/application/ai-chat/cursor-models";
import { effectivePermission } from "../store/permissions";
import { isSidechatSupportedEngine, useSidechatStore } from "@/features/sidechat/store";
import { engineSupportsCompact, parseAppCommand } from "@/components/application/ai-chat/app-commands";
import {
  COMPUTER_USE_SETTINGS_HASH,
  engineSupportsComputerUse,
} from "../computer-use";
import { useMcpPanel } from "@/features/mcp/panel";
import { recordPrompt } from "../prompt-history";
import { clearComposerPrediction } from "../composer-prediction";
import { IMAGE_EXTENSIONS } from "./use-composer-images";
import { isHandoffDraft, useHandoffStore } from "../session-cleanup";
import { crossSessionCostReview, requiresSessionSendCostApproval, useSessionSendCostGuardStore } from "../cross-session-cost";

/** Composer submit/draft/attach/stop handlers plus the pending-@mention
 * bridge, so ChatConversation stays a composition layer. */
export function useComposerActions({
  active,
  sessionKey,
  streaming,
  images,
  clearImages,
  captureImageSubmission,
  importImageFiles,
  supportsImages,
  composerInputRef,
}: {  active: ActiveSession | null;
  sessionKey: string;
  streaming: boolean;
  images: string[];
  clearImages: () => void;
  captureImageSubmission: (paths: readonly string[]) => () => void;
  importImageFiles: (paths: string[], supported: boolean) => void;
  supportsImages: boolean;
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
}) {
  const { t } = useTranslation();
  const source = useRef({ key: sessionKey, mounted: true });
  useLayoutEffect(() => { source.current.key = sessionKey; }, [sessionKey]);
  useEffect(() => {
    source.current.mounted = true;
    return () => { source.current.mounted = false; };
  }, []);
  const pendingMention = useChatStore((s) => s.pendingMention);
  const engines = useChatStore((s) => s.engines);
  const {
    setDraft,
    clearPendingMention,
    send,
    sendWhileBusy,
    queueMessage,
    interrupt,
    startNewChat,
    compactContext,
    setSessionError,
  } = useChatStore(
    useShallow((s) => ({
      setDraft: s.setDraft,
      clearPendingMention: s.clearPendingMention,
      send: s.send,
      sendWhileBusy: s.sendWhileBusy,
      queueMessage: s.queueMessage,
      interrupt: s.interrupt,
      startNewChat: s.startNewChat,
      compactContext: s.compactContext,
      setSessionError: s.setSessionError,
    })),
  );

  const submitWithMode = useCallback(
    (value: string, mode: "send" | "queue") => {
      const current = useChatStore.getState();
      const liveActive = resolveLiveSessionTab(active, current.openTabs);
      if (!liveActive || (!value.trim() && images.length === 0)) return;
      const liveKey = resolveLiveSessionKey(
        toSessionKey(liveActive.engine, liveActive.sessionId, liveActive.workspacePath),
        current.openTabs,
      );
      const isStreaming = Boolean(
        streaming ||
          current.streamingByKey[liveKey] ||
          current.bySession[liveKey]?.streaming ||
          current.bySession[liveKey]?.draftLaunching,
      );
      const dispatch = (prompt: string, computerUse = false) => {
        clearComposerPrediction(liveKey);
        if (sessionKey && sessionKey !== liveKey) clearComposerPrediction(sessionKey);
        if (liveActive.sessionId === null && !isStreaming) {
          const clearSubmittedImages = captureImageSubmission(images);
          const pending = useHandoffStore.getState().byWorkspace[liveActive.workspacePath];
          const ownedByOtherPendingTab =
            !!pending &&
            !isHandoffDraft(prompt, pending) &&
            current.openTabs.some(
              (tab) =>
                tab.sessionId === null &&
                tab.workspacePath === liveActive.workspacePath &&
                tab.engine !== liveActive.engine &&
                isHandoffDraft(
                  current.drafts[toSessionKey(tab.engine, null, tab.workspacePath)] ?? "",
                  pending,
                ),
            );
          const handoff = pending && !ownedByOtherPendingTab ? pending : undefined;
          if (handoff) useHandoffStore.getState().setSending(liveActive.workspacePath, handoff.id, true);
          let adoptedKey = liveKey;
          const unsubscribeAdoption = useChatStore.subscribe((s) => {
            const resolved = resolveLiveSessionKey(liveKey, s.openTabs);
            if (resolved !== liveKey) adoptedKey = resolved;
          });
          const normalizeLf = (text: string) => text.replace(/\r\n/g, "\n");
          const matchesSubmittedDraft = (draftText: string | undefined) =>
            draftText !== undefined &&
            (draftText === value || normalizeLf(draftText) === normalizeLf(value));
          const finishSubmission = (result?: { runId: string; sessionId: string | null }) => {
            if (handoff) {
              // A dismissed or replaced handoff no longer owns this draft,
              // even if a newer draft happens to contain identical text.
              if (useHandoffStore.getState().byWorkspace[liveActive.workspacePath]?.id !== handoff.id) return;
              useHandoffStore.getState().completeHandoffOnSend(liveActive.workspacePath, handoff.id);
            }
            const nextHandoff = useHandoffStore.getState().byWorkspace[liveActive.workspacePath];
            if (nextHandoff && nextHandoff.id !== pending?.id) return;
            const stateNow = useChatStore.getState();
            const resultKey = result?.sessionId
              ? toSessionKey(liveActive.engine, result.sessionId, liveActive.workspacePath)
              : undefined;
            const targetKey =
              adoptedKey !== liveKey
                ? adoptedKey
                : resultKey && stateNow.openTabs.some((tab) => toSessionKey(tab.engine, tab.sessionId, tab.workspacePath) === resultKey)
                  ? resultKey
                  : resolveLiveSessionKey(liveKey, stateNow.openTabs);
            if (!stateNow.openTabs.some((tab) => toSessionKey(tab.engine, tab.sessionId, tab.workspacePath) === targetKey)) return;
            if (matchesSubmittedDraft(stateNow.drafts[targetKey] ?? stateNow.drafts[liveKey] ?? stateNow.drafts[sessionKey])) {
              setDraft(targetKey, "");
            }
            if (liveKey !== targetKey && matchesSubmittedDraft(stateNow.drafts[liveKey])) {
              setDraft(liveKey, "");
            }
            const mountedKey =
              adoptedKey !== liveKey && source.current.key === liveKey
                ? adoptedKey
                : resolveLiveSessionKey(source.current.key, stateNow.openTabs);
            if (!source.current.mounted || mountedKey !== targetKey) return;
            clearSubmittedImages();
          };
          void send(prompt, images, {
            computerUse,
            onCommitted: handoff ? undefined : finishSubmission,
            onRunStarted: handoff ? finishSubmission : undefined,
          }, liveActive).finally(() => {
            unsubscribeAdoption();
            if (handoff) useHandoffStore.getState().setSending(liveActive.workspacePath, handoff.id, false);
          });
          return;
        }
        if (liveActive.sessionId !== null && !isStreaming) {
          const sessionState = current.bySession[liveKey];
          const activeMeta = current.sessions?.find(
            (item) =>
              item.engine === liveActive.engine &&
              item.sessionId === liveActive.sessionId &&
              (!item.workspacePath || item.workspacePath === liveActive.workspacePath),
          );
          if (activeMeta && sessionState) {
            const review = crossSessionCostReview(activeMeta, current, "idle");
            const guardStore = useSessionSendCostGuardStore.getState();
            if (requiresSessionSendCostApproval(review, activeMeta, sessionState) && !guardStore.isApproved(liveKey, review)) {
              const heldImages = [...images];
              guardStore.hold({
                sessionKey: liveKey,
                engine: liveActive.engine,
                sessionId: liveActive.sessionId,
                workspacePath: liveActive.workspacePath,
                prompt,
                images: heldImages,
                computerUse,
                mode: "send",
                review,
                onApproveSend: () => {
                  const latestDraft = useChatStore.getState().drafts?.[liveKey];
                  const finalPrompt = latestDraft !== undefined && latestDraft.trim() ? latestDraft : prompt;
                  setDraft(liveKey, "");
                  clearImages();
                  void send(finalPrompt, heldImages, computerUse ? { computerUse: true } : undefined, liveActive);
                },
              });
              return;
            }
          }
        }
        useSessionSendCostGuardStore.getState().dismiss(liveKey);
        setDraft(liveKey, ""); clearImages();
        if (isStreaming && mode === "queue") queueMessage(prompt, images, computerUse ? { computerUse: true } : undefined, liveActive);
        else if (isStreaming) void sendWhileBusy(prompt, images, computerUse ? { computerUse: true } : undefined, liveActive);
        else void send(prompt, images, computerUse ? { computerUse: true } : undefined, liveActive);
      };
      // App commands resolve BEFORE the draft is cleared: a computer-use
      // send this session cannot honor leaves the user's text and
      // attachments in place to fix.
      const parsedCommand = parseAppCommand(value, liveActive.workspacePath);
      const appCommand = images.length === 0 || ["btw", "sidechat"].includes(parsedCommand?.command ?? "") ? parsedCommand : null;
      if (appCommand?.command === "btw" || appCommand?.command === "sidechat") {
        if (!isSidechatSupportedEngine(liveActive.engine)) {
          setSessionError(liveKey, t("sidechat.unsupportedEngine"));
          return;
        }
        if (images.length > 0 && !supportsImages) {
          setSessionError(liveKey, t("chat.imagesUnsupported"));
          return;
        }
        const clearSubmittedImages = captureImageSubmission(images);
        const onAccepted = () => {
          const now = useChatStore.getState();
          const targetKey = resolveLiveSessionKey(liveKey, now.openTabs);
          if ((now.drafts[targetKey] ?? now.drafts[liveKey]) === value) setDraft(targetKey, "");
          if (source.current.mounted && resolveLiveSessionKey(source.current.key, now.openTabs) === targetKey) clearSubmittedImages();
        };
        const sessionState = current.bySession[liveKey];
        const storedModel =
          resolveSessionModel(
            liveActive,
            sessionState,
            current.models[liveActive.engine],
          ) || null;
        const launchModel =
          liveActive.engine === "cursor"
            ? cursorLaunchModel(storedModel)
            : storedModel;
        const effort =
          resolveSessionEffort(
            liveActive,
            sessionState,
            current.efforts[liveActive.engine],
            current.models[liveActive.engine],
          ) ?? null;
        const provider =
          resolveSessionProvider(
            liveActive,
            sessionState,
            current.providers[liveActive.engine],
          ) ?? null;
        const parentMessages = sessionState?.messages ?? [];

        if (appCommand.command === "btw") {
          if (!appCommand.arg && images.length === 0) {
            setSessionError(liveKey, t("sidechat.btwNeedsQuestion"));
            return;
          }
          recordPrompt(value);
          void useSidechatStore.getState().askBtw({
            sessionKey: liveKey,
            engine: liveActive.engine,
            workspacePath: liveActive.workspacePath,
            parentSessionId: liveActive.sessionId,
            question: appCommand.arg,
            images,
            onAccepted,
            parentMessages,
            model: launchModel,
            effort,
            providerId: provider,
          });
          return;
        }

        recordPrompt(value);
        void useSidechatStore.getState().openSidechat({
          sessionKey: liveKey,
          engine: liveActive.engine,
          workspacePath: liveActive.workspacePath,
          parentSessionId: liveActive.sessionId,
          initialQuestion: appCommand.arg || undefined,
          parentPermission: effectivePermission(current.engines, liveActive.engine, current.permission),
          images,
          onAccepted,
          parentMessages,
          model: launchModel,
          effort,
          providerId: provider,
        });
        return;
      }
      if (appCommand?.command === "cua") {
        // Bare form opens the setup door: permission status and the grant
        // flow live in Settings → 电脑操控.
        if (!appCommand.arg) {
          window.location.hash = COMPUTER_USE_SETTINGS_HASH;
          return;
        }
        if (!engineSupportsComputerUse(engines, liveActive.engine)) {
          setSessionError(liveKey, t("chat.cuaUnsupportedEngine"));
          return;
        }
        recordPrompt(value);
        // Preserve the explicit capability flag for both submission modes;
        // the store keeps computer-use tasks out of a live follow-up path.
        dispatch(appCommand.arg, true);
        return;
      }
      recordPrompt(value);
      // App-level commands ("/new", "/compact", "/mcp") never reach the
      // engine — headless/protocol launches can't interpret them. A
      // user-defined catalog command of the same name takes precedence
      // (parseAppCommand).
      if (appCommand?.command === "new") {
        useSessionSendCostGuardStore.getState().dismiss(liveKey);
        useHandoffStore.getState().dismissHandoff(liveActive.workspacePath);
        setDraft(liveKey, ""); clearImages();
        startNewChat(liveActive.workspacePath);
        return;
      }
      if (appCommand?.command === "compact") {
        if (!engineSupportsCompact(engines, liveActive.engine)) {
          setSessionError(liveKey, t("chat.compactUnsupportedEngine"));
          return;
        }
        if (!liveActive.sessionId) {
          setSessionError(liveKey, t("chat.compactNeedsSession"));
          return;
        }
        if (isStreaming) {
          setSessionError(liveKey, t("chat.compactWhileStreaming"));
          return;
        }
        setDraft(liveKey, ""); clearImages();
        void compactContext(liveKey, appCommand.arg || undefined);
        return;
      }
      if (appCommand?.command === "handoff") {
        if (!liveActive.sessionId) {
          setSessionError(liveKey, t("chat.handoffNeedsSession"));
          return;
        }
        if (isStreaming) {
          setSessionError(liveKey, t("chat.handoffWhileStreaming"));
          return;
        }
        useSessionSendCostGuardStore.getState().dismiss(liveKey);
        setDraft(liveKey, ""); clearImages();
        const stateNow = useChatStore.getState();
        const activeMeta = stateNow.sessions.find(
          (item) => item.engine === liveActive.engine && item.sessionId === liveActive.sessionId,
        );
        const title = activeMeta?.customTitle || activeMeta?.title || liveActive.sessionId.slice(0, 8);
        useHandoffStore.getState().startHandoff({
          workspacePath: liveActive.workspacePath,
          sourceEngine: liveActive.engine,
          sourceSessionId: liveActive.sessionId,
          sourceTitle: title,
          sourceMeta: activeMeta,
          sourceState: stateNow.bySession[liveKey],
          nextTask: appCommand.arg || undefined,
          archiveSourceOnSend: false,
        });
        return;
      }
      if (appCommand?.command === "mcp") {
        setDraft(liveKey, ""); clearImages();
        useMcpPanel.getState().openPanel();
        return;
      }
      // The store chooses the live path for normal submit. Explicit queueing
      // always waits for the next turn and preserves FIFO order.
      dispatch(value);
    },
    [active, images, streaming, sessionKey, setDraft, clearImages, captureImageSubmission, send, sendWhileBusy, queueMessage, startNewChat, compactContext, engines, supportsImages, setSessionError, t],
  );
  const submit = useCallback((value: string) => submitWithMode(value, "send"), [submitWithMode]);
  const queue = useCallback((value: string) => submitWithMode(value, "queue"), [submitWithMode]);

  // 文件树「+」的 pendingMention 是全局信号：分屏时只有当前聚焦那一栏（就是
  // 全局 active 所在的格子）能消费它，否则每个格子的输入框都会插一份。
  const activeSessionKey = useChatStore((s) =>
    s.active ? toSessionKey(s.active.engine, s.active.sessionId, s.active.workspacePath) : "",
  );

  // File-tree "+" asks the composer to insert an @path mention at the caret.
  useEffect(() => {
    if (!pendingMention) return;
    if (activeSessionKey !== sessionKey) return;
    clearPendingMention();
    const input = composerInputRef.current;
    if (!input) return;
    input.focus();
    input.insertText(`${mentionToken(pendingMention.path)} `);
  }, [
    pendingMention,
    activeSessionKey,
    sessionKey,
    clearPendingMention,
    composerInputRef,
  ]);

  const handleDraftChange = useCallback(
    (v: string) => {
      const liveKey = resolveLiveSessionKey(sessionKey, useChatStore.getState().openTabs);
      setDraft(liveKey, v);
      if (!v.trim() && images.length === 0 && useSessionSendCostGuardStore.getState().bySessionKey[liveKey]?.mode === "send") {
        useSessionSendCostGuardStore.getState().dismiss(liveKey);
      }
    },
    [sessionKey, setDraft, images.length],
  );

  // Shared partition for the file picker and OS drops: images flow through
  // the sandboxed image pipeline (chips); every other file becomes an
  // @mention at the caret — same as the file tree's "+" — so its content
  // stays live instead of a frozen sandbox copy.
  const routeIncomingPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const imagePaths: string[] = [];
      const mentionPaths: string[] = [];
      for (const path of paths) {
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        (IMAGE_EXTENSIONS.includes(ext) ? imagePaths : mentionPaths).push(path);
      }
      if (mentionPaths.length > 0) {
        const input = composerInputRef.current;
        if (input) {
          input.focus();
          input.insertText(`${mentionPaths.map(mentionToken).join(" ")} `);
        }
      }
      if (imagePaths.length > 0) importImageFiles(imagePaths, supportsImages);
    },
    [composerInputRef, importImageFiles, supportsImages],
  );

  // "Add → Files and folders": native multi-picker.
  const handleAddAttachments = useCallback(() => {
    void (async () => {
      const picked = await pickFiles(t("chat.addFilesFolders"));
      routeIncomingPaths(picked);
    })();
  }, [t, routeIncomingPaths]);

  const handleStop = useCallback(() => void interrupt(active), [interrupt, active]);
  const handlePickSkills = useCallback(
    () => composerInputRef.current?.openSlashPicker(),
    [composerInputRef],
  );

  return {
    submit,
    queue,
    handleDraftChange,
    handleAddAttachments,
    /** OS file drop onto the composer (absolute native paths). */
    handleDroppedPaths: routeIncomingPaths,
    handleStop,
    handlePickSkills,
  };
}
