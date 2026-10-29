import { matchesHostTaskSelection } from "./host-task-selection";
import { ipc } from "@/lib/ipc";
import { cursorLaunchModel, cursorRememberedModel } from "@/components/application/ai-chat/cursor-models";
import { engineSupportsCompact } from "@/components/application/ai-chat/app-commands";
import { abortAutoReviews } from "./auto-review";
import { errorText } from "@/lib/errors";
import { isDeliveryOutcomeUnknown } from "@/lib/delivery-outcome";
import { newId } from "@/lib/id";
import i18n from "@/lib/i18n";
import {
  dedupeTabs,
  persistTabs,
  sessionKey,
  type ActiveSession,
} from "./persistence";
import { isBackgroundDraftAvailable } from "./tabs";
import {
  EMPTY_SESSION,
  adoptedDraftKeys,
  resolveLiveSessionKey,
  resolveLiveSessionTab,
  applyStreamParts,
  drainPending,
  moveStreamingFlag,
  patchSession,
  resolveSessionModel,
  resolveSessionEffort,
  resolveClaudeUltracode,
  resolveSessionProvider,
  rememberSettledRun,
  runRouting,
  setRetryingFlag,
  setStreamingFlag,
  settleLiveRows,
  untrackRun,
  type QueuedMessage,
  type SessionState,
} from "./stream";
import { latestMessageUsage, mergeUsage, parseUsage } from "../usage";
import { crossSessionCostReview, requiresQueueDrainCostApproval, useSessionSendCostGuardStore } from "../cross-session-cost";
import { settleThroughput } from "../throughput";
import { persistClaudeUltracode } from "./claude-ultracode";
import { resolveClaudeHaikuAssist } from "../claude-haiku-assist";
import { beginRuntimeOperation, guardRuntimeActions, isRuntimeSubmissionPaused } from "@/lib/runtime-checkpoint";
import {
  dropRunUsage,
  startThroughput,
  firstLineTitle,
  optimisticMeta,
  patchGrantBySeq,
  rememberModelForRun,
  rememberEffortForRun,
  patchQuestionByRequestId,
  rememberProviderForRun,
  routeAndReconcileRun,
  upsertSessionMetaInto,
} from "./engine-events";
import { ASK_OTHER_OPTION, askLoops, beginAskSubmit, revertAskSubmit } from "./ask-loop";
import { engineSupportsComputerUse } from "../computer-use";
import { HostChatBusyError, type SendOptions } from "./types";
import { patchPlanReview } from "./plan-review";
import { effectivePermission } from "./permissions";
import {
  buildAgentBlock,
  hasAgentBlock,
} from "../components/agent-block";
import {
  clearSelectedAgent,
  getSelectedAgent,
  migrateSelectedAgent,
} from "@/features/agents/selected-agent";
import { appendCommittedRows } from "./session-utils";
import { beginNativeRun } from "./native-tasks";
import {
  INTERRUPT_GRACE_MS,
  followUpGuardActive,
  hasOpenCard,
  isInterruptEcho,
  liveFollowUpBlocker,
  codexSteerBlocker,
  shouldInterruptTurn,
  usesNativeInterrupt,
} from "./live-follow-up";
import type { ChatStore } from "./types";
import type {
  LoadHistoryPage,
  StoreGet,
  StoreSet,
  StoreSubscribe,
} from "./context";

/**
 * Messaging: sending prompts (optimistic turn, native-id adoption, queue
 * drain), the message queue, interrupt, grant/question replies, compaction,
 * and the post-turn usage refresh. drainQueue and markUnseenIfBackground are
 * returned alongside the actions — init wires them into engine-event handling.
 */

export interface MessagingDeps {
  set: StoreSet;
  get: StoreGet;
  loadHistoryPage: LoadHistoryPage;
  subscribe: StoreSubscribe;
}

/** 会话 key：调用方给了目标就用它，否则回退到当前激活会话。
 *  分屏后每个格子都有自己的输入框与队列，不能再无脑用全局 active。 */
function keyOfTarget(
  target: ActiveSession | null | undefined,
  active: ActiveSession | null,
): string {
  const session = target ?? active;
  return session
    ? sessionKey(session.engine, session.sessionId, session.workspacePath)
    : "";
}

/** 已经算好 key 的调用点直接用 key，没给就回退到激活会话。 */
function resolveKey(key: string | undefined, active: ActiveSession | null): string {
  return resolveLiveSessionKey(key ?? keyOfTarget(null, active));
}

/** The one answer value a question card sends. A multi-select pick arrives as
 * labels and travels as the text the CLI's free-form editor would have given. */
function answerText(answers: Record<string, string | string[]>): string {
  const value = Object.values(answers)[0];
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}

/** How a message reaches a Claude CLI that is alive but idle (background tasks
 *  still running) instead of launching a process: see sendPrompt. */
interface LiveDelivery {
  /** A composer send (already past the queue) or the queue's head released at
   *  an idle boundary. */
  origin: "composer" | "queue";
  /** The queue row this delivery consumed; put back when it cannot go live. */
  item?: QueuedMessage;
}

export function createMessagingActions(
  deps: MessagingDeps,
): Pick<
  ChatStore,
  | "send"
  | "respondToGrant"
  | "respondToPlanReview"
  | "resumePlanReview"
  | "respondToQuestion"
  | "resendLastUser"
  | "queueMessage"
  | "sendWhileBusy"
  | "removeQueued"
  | "moveQueued"
  | "clearQueue"
  | "sendQueuedNow"
  | "interrupt"
  | "compactContext"
  | "refreshSessionUsage"
> & {
  /** After a turn ends, send the oldest queued message for that session. */
  drainQueue: (key: string) => void;
  /** The native CLI idles while background tasks run: hand the head of the
   *  queue to the live process (one item per idle boundary). */
  drainQueueLive: (key: string) => void;
  /** Flag a finished background session for the sidebar's unseen dot. */
  markUnseenIfBackground: (key: string) => void;
} {
  const { set, get, loadHistoryPage, subscribe } = deps;
  // Stop can arrive before send_message registers the child. A false reply
  // then means "not yet"; retry once when that exact launch is registered.
  const pendingNativeLaunches = new Map<string, { runId: string; ready: boolean; retryInterrupt: boolean }>();
  const interruptsInFlight = new Map<string, { at: number }>();
  const preparingLive = new Set<{ key: string; stopped: boolean }>();
  // A terminal event may precede the steer ACK. Defer the next launch until
  // every delivery is accounted for so an unconfirmed message is not resent.
  const codexSteersInFlight = new Map<string, number>();
  let nextCodexSteerOrder = 0;

  /**
   * Send a prompt to a specific tab. Unlike the public `send` action this is
   * not bound to the active session, so the queue can drain on a background
   * tab after its turn finishes there.
   */
  async function sendPrompt(
    tab: ActiveSession,
    prompt: string,
    images: string[],
    options?: SendOptions,
    live?: LiveDelivery,
  ) {
    const done = beginRuntimeOperation("chat:send-prompt");
    try { return await sendPromptUntracked(tab, prompt, images, options, live); }
    finally { done(); }
  }

  async function sendPromptUntracked(
    tab: ActiveSession,
    prompt: string,
    images: string[],
    options?: SendOptions,
    live?: LiveDelivery,
  ) {
    if (live && tab.engine === "codex") {
      const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
      // Restored queued steers retain their original order even though this
      // module's counter starts fresh in the replacement renderer.
      nextCodexSteerOrder = Math.max(nextCodexSteerOrder, ...(get().bySession[key]?.queue.map((item) => item.steerOrder ?? 0) ?? []));
      const delivery: LiveDelivery = { ...live, item: {
        ...(live.item ?? { id: newId(), text: prompt, images, queuedAt: Date.now(), computerUse: options?.computerUse }),
        steerOrder: ++nextCodexSteerOrder,
      } };
      codexSteersInFlight.set(key, (codexSteersInFlight.get(key) ?? 0) + 1);
      try {
        return await sendPreparedPrompt(tab, prompt, images, options, delivery);
      } finally {
        const remaining = (codexSteersInFlight.get(key) ?? 1) - 1;
        if (remaining) codexSteersInFlight.set(key, remaining);
        else codexSteersInFlight.delete(key);
        drainWhenRunEnded(key);
      }
    }
    if (tab.engine === "codex" && codexSteersInFlight.has(sessionKey(tab.engine, tab.sessionId, tab.workspacePath))) {
      if (options?.requestedRunId) throw new HostChatBusyError();
      enqueueExplicit(tab, prompt, images, options);
      return;
    }
    if (tab.sessionId !== null || live || (!prompt.trim() && !images.length)) {
      return sendPreparedPrompt(tab, prompt, images, options, live);
    }
    const key = sessionKey(tab.engine, null, tab.workspacePath);
    const draft = get().bySession[key];
    if (draft?.loading || draft?.streaming || draft?.draftLaunching) {
      if (options?.requestedRunId) throw new HostChatBusyError();
      return;
    }
    const draftLaunch = { id: newId(), invoked: false };
    patchSession(set, key, { draftLaunching: draftLaunch.id, interrupted: false });
    try {
      await sendPreparedPrompt(tab, prompt, images, options, live, draftLaunch);
    } finally {
      if (get().bySession[key]?.draftLaunching === draftLaunch.id) {
        patchSession(set, key, { draftLaunching: undefined });
        if (draftLaunch.invoked && !get().bySession[key]?.interrupted) drainQueue(key);
      }
    }
  }

  async function sendPreparedPrompt(
    tab: ActiveSession,
    prompt: string,
    images: string[],
    options?: SendOptions,
    live?: LiveDelivery,
    draftLaunch?: { id: string; invoked: boolean },
  ) {
    if (!prompt.trim() && images.length === 0) return;
    const typedPrompt = prompt;
    const assertHostIdle = () => {
      if (!options?.requestedRunId) return;
      const state = get();
      const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
      const session = state.bySession[key];
      if (options.hostNewChat) {
        // A first task turn targets exactly one open pending chat; an adopted,
        // closed, focused or user-edited draft is a pre-spawn refusal, never a
        // send elsewhere or an overwrite of the user's draft.
        if (
          tab.sessionId !== null ||
          !draftLaunch ||
          session?.draftLaunching !== draftLaunch.id ||
          !isBackgroundDraftAvailable(state, tab.engine, tab.workspacePath, options.hostLaunch, {
            requireOpenTab: true,
            allowDraftLaunchingId: draftLaunch.id,
          })
        ) {
          throw new HostChatBusyError();
        }
        return;
      }
      if (!state.initialized || !tab.sessionId || !session || session.loading || state.archivedSessionKeys[key] ||
        !state.openTabs.some((t) => t.engine === tab.engine && t.sessionId === tab.sessionId && t.workspacePath === tab.workspacePath)) {
        throw new HostChatBusyError("Exact host chat target is no longer reachable");
      }
      const current = state.openTabs.find((t) => t.engine === tab.engine && t.sessionId === tab.sessionId && t.workspacePath === tab.workspacePath)!;
      if (options.hostLaunch && !matchesHostTaskSelection(current, session, options.hostLaunch)) {
        throw new HostChatBusyError("Host task session selection changed before delivery");
      }
      if ((session.streaming && !(live && options.hostContinuation)) ||
        (session.queue.length && !options.hostContinuation?.priority) || hasOpenCard(session)) {
        throw new HostChatBusyError();
      }
    };
    assertHostIdle();
    // A pinned agent's instructions ride along as a tail block the
    // transcript keeps (the bubble strips it back out for display). Slash
    // prompts ("/compact") never get it, and a re-sent committed message
    // already carries its block, so re-injecting would duplicate it.
    const selectedAgent = getSelectedAgent(tab.workspacePath, tab.sessionId);
    // Built-in resolve failures are re-flagged after the optimistic-turn
    // patch below (which resets `error` for the new turn).
    let agentResolveError: string | null = null;
    if (selectedAgent && !prompt.startsWith("/") && !hasAgentBlock(prompt)) {
      // Built-in picks store no prompt: resolve the current catalog prompt
      // at send time. A since-disabled catalog entry fails the resolve —
      // drop the stale pin, surface the session error banner, and still
      // send the bare text.
      if (selectedAgent.source === "builtIn") {
        const preparation = live ? { key: sessionKey(tab.engine, tab.sessionId, tab.workspacePath), stopped: false } : undefined;
        if (preparation) preparingLive.add(preparation);
        try {
          const resolved = await ipc.resolveEnabledBuiltInAgent(selectedAgent.id);
          prompt += buildAgentBlock({
            name: resolved.name,
            icon: resolved.icon ?? undefined,
            prompt: resolved.prompt,
          });
        } catch {
          clearSelectedAgent(tab.workspacePath, tab.sessionId);
          agentResolveError = i18n.t("chat.agentUnavailable");
        } finally {
          if (preparation) preparingLive.delete(preparation);
        }
        // A Stop during this await cancels the prepared delivery even if the
        // run's final done already cleared its per-run parking flags.
        if (preparation?.stopped) {
          if (options?.hostContinuation) throw new HostChatBusyError("Host continuation stopped during preparation");
          patchSession(set, preparation.key, { followUpAt: null });
          const putBack = tab.engine === "codex" ? requeueCodexInput : requeueFirst;
          putBack(preparation.key, live!.item ?? {
            id: newId(), text: typedPrompt, images, queuedAt: Date.now(), computerUse: options?.computerUse,
          });
          return;
        }
      } else if (selectedAgent.prompt) {
        prompt += buildAgentBlock({
          name: selectedAgent.name,
          icon: selectedAgent.icon,
          prompt: selectedAgent.prompt,
        });
      }
    }
    if (options?.requestedRunId) {
      await options.hostBeforeSend?.();
      assertHostIdle();
      tab = get().openTabs.find((t) => t.engine === tab.engine && t.sessionId === tab.sessionId && t.workspacePath === tab.workspacePath)!;
    }
    const engine = tab.engine;
    const key = sessionKey(engine, tab.sessionId, tab.workspacePath);
    // Closing or retargeting during agent resolution cancels this first launch.
    if (tab.sessionId === null && !get().openTabs.some((t) =>
      t.engine === engine && t.sessionId === null && t.workspacePath === tab.workspacePath)) {
      if (options?.hostNewChat) throw new HostChatBusyError();
      return;
    }
    if (draftLaunch && (get().bySession[key]?.draftLaunching !== draftLaunch.id || get().bySession[key]?.interrupted)) {
      if (options?.hostNewChat) throw new HostChatBusyError();
      return;
    }
    // Computer use asks for the driver; engines without an MCP-mount path
    // would run the prompt text-only while the user believes the machine is
    // under agent control. Refuse loudly instead of downgrading silently.
    if (options?.computerUse && !engineSupportsComputerUse(get().engines, engine)) {
      patchSession(set, key, { error: i18n.t("chat.cuaUnsupportedEngine") });
      return;
    }
    // Resolve BEFORE the optimistic rows land: the patch below writes
    // activeModel, and a resolver reading it afterwards would see its own
    // write instead of the session's history.
    // The session's own model, not the engine default: continuing a
    // conversation keeps running the model that conversation uses.
    const engineDefaultModel =
      options?.hostLaunch && "defaultModel" in options.hostLaunch
        ? (options.hostLaunch.defaultModel || undefined)
        : get().models[engine];
    const storedModel =
      resolveSessionModel(tab, get().bySession[key], engineDefaultModel) ||
      null;
    // 【cursor模型】会话记住基础 id；启动参数另写进 CLI 配置，不进会话记录。
    const model = engine === "cursor" ? cursorRememberedModel(storedModel) : storedModel;
    const launchModel = engine === "cursor" ? cursorLaunchModel(storedModel) : storedModel;
    // Remember what this session runs, spelled as the picker spells it: the
    // engine's own transcript keeps only the bare model name, so this record
    // is what a restart or another client reads back (see
    // ipc.rememberSessionModel). A brand-new session has no id yet — its
    // `session` event carries the model instead.
    if (model) {
      if (tab.sessionId) {
        void ipc
          .rememberSessionModel(engine, tab.sessionId, model)
          .catch(() => {});
      } else {
        rememberModelForRun(key, model);
      }
    }
    const engineDefaultEffort =
      options?.hostLaunch && "defaultEffort" in options.hostLaunch
        ? ((options.hostLaunch.defaultEffort as typeof get extends () => infer S ? S extends { efforts: Record<string, infer E> } ? E : never : never) || undefined)
        : get().efforts[engine];
    const effort =
      resolveSessionEffort(tab, get().bySession[key], engineDefaultEffort, engineDefaultModel) ??
      null;
    // Read the latest pending tab: resolving an agent block above can yield
    // while the user changes the starting switch.
    const currentTab = get().openTabs.find((t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key &&
      (!options?.hostContinuation || t.workspacePath === tab.workspacePath)) ?? tab;
    const claudeUltracode = resolveClaudeUltracode(currentTab, get().bySession[key], get().defaultClaudeUltracode);
    const claudeHaikuAssist = resolveClaudeHaikuAssist(currentTab);
    if (engine === "claude" && tab.sessionId) {
      void persistClaudeUltracode(set, claudeUltracode, tab.sessionId);
    }
    // Remember the level the way the model is remembered: the picker follows
    // the session, so a reopened session — here, in another window, or on the
    // phone — keeps running the level it ran instead of the engine default.
    if (effort) {
      if (tab.sessionId) {
        void ipc
          .rememberSessionEffort?.(engine, tab.sessionId, effort)
          ?.catch(() => {});
      } else {
        rememberEffortForRun(key, effort);
      }
    }
    const provider =
      resolveSessionProvider(
        tab,
        get().bySession[key],
        options?.hostLaunch && "defaultProvider" in options.hostLaunch
          ? (options.hostLaunch.defaultProvider || undefined) : get().providers[engine],
      ) ?? null;
    if (provider) {
      if (tab.sessionId) {
        void ipc
          .rememberSessionProvider?.(engine, tab.sessionId, provider)
          ?.catch(() => {});
      } else {
        rememberProviderForRun(key, provider);
      }
    }
    const permission = effectivePermission(
      get().engines,
      engine,
      get().permission,
    );
    // The CLI behind this session is alive and idle: the message goes into
    // that process, no launch.
    if (live) {
      if (engine === "codex") return deliverCodexSteer(tab, key, prompt, typedPrompt, images, options, live, agentResolveError);
      return deliverFollowUp(currentTab, key, prompt, typedPrompt, images, options, live, agentResolveError);
    }
    // Optimistic user message.
    const requestedRunId = options?.requestedRunId ?? `run-${newId()}`;
    if (options?.hostContinuation) {
      await options.hostContinuation.beforeDelivery("turn", requestedRunId);
      assertHostIdle();
    }
    // Built-in agent resolution above can yield: recheck immediately before
    // claiming this timeline so an external queued send cannot overlap a user.
    assertHostIdle();
    set((s) => ({
      streamingByKey: setStreamingFlag(s.streamingByKey, key, true),
    }));
    appendCommittedRows(
      set,
      key,
      [
        {
          role: "user",
          text: prompt,
          ts: new Date().toISOString(),
          images: images.length ? [...images] : undefined,
        },
      ],
      {
        ...(engine === "claude"
          ? {
              ...beginNativeRun(get().bySession[key] ?? EMPTY_SESSION, requestedRunId),
              // The CLI fixes these at launch: a later live follow-up compares.
              liveLaunch: { model, effort, provider, permission, claudeUltracode, claudeHaikuAssist },
            }
          : {}),
        ...(engine === "codex" ? { codexRunId: requestedRunId, liveLaunch: { model, effort, provider, permission } } : {}),
        streaming: true,
        error: null,
        interrupted: false,
        turnStartedAt: Date.now(),
        activeModel: model,
        activeEffort: effort,
        ...(engine === "claude" ? { claudeUltracode } : {}),
        activeProvider: provider,
        // 电脑操控 is per-send opt-in (never sticky: a later ordinary
        // message must not silently regain machine control). The record only
        // feeds resendLastUser, which repeats this very message.
        activeComputerUse: options?.computerUse === true,
        // The tail indicator counts this reply, not the one before it.
        turnUsage: null,
        throughput: startThroughput(requestedRunId),
      },
    );
    // Refresh independently: a slow history read must not delay sending or Stop.
    const hostUserRow = get().bySession[key]?.messages.at(-1);
    options?.onCommitted?.();
    void get().refreshSessionUsage(key);
    routeAndReconcileRun(set, requestedRunId, key);
    if (agentResolveError) {
      patchSession(set, key, { error: agentResolveError });
    }
    if (options?.computerUse) {
      // Arm the global Esc-to-stop for this run: the escape hatch out of a
      // machine-driving turn. Disarmed when the turn settles (onDone / a
      // failed spawn), so the system-wide hotkey never outlives the run.
      void ipc.computerUseSetActive?.(true)?.catch(() => {});
    }
    const nativeLaunch = engine === "claude"
      ? { runId: requestedRunId, ready: false, retryInterrupt: false }
      : undefined;
    if (nativeLaunch) pendingNativeLaunches.set(requestedRunId, nativeLaunch);
    try {
      if (options?.hostUserRow && hostUserRow?.role === "user") {
        await options.hostUserRow({ runId: requestedRunId, seq: hostUserRow.seq, ts: hostUserRow.ts, text: hostUserRow.text, ...(hostUserRow.images ? { images: [...hostUserRow.images] } : {}) });
        // Correlation persistence may yield to cancellation or an ownership fence.
        await options.hostBeforeSend?.();
        if (!get().openTabs.some(t => t.engine === tab.engine && t.sessionId === tab.sessionId && t.workspacePath === tab.workspacePath) ||
          runRouting.get(requestedRunId) !== key || get().bySession[key]?.interrupted || get().bySession[key]?.queueParked) throw new HostChatBusyError("Exact host delivery was stopped during row persistence");
      }
      if (draftLaunch) draftLaunch.invoked = true;
      const result = await ipc.sendMessage({
        runId: requestedRunId,
        engine,
        workspacePath: tab.workspacePath,
        sessionId: tab.sessionId,
        prompt,
        imagePaths: images.length ? images : null,
        model: launchModel,
        effort,
        ...(engine === "claude" ? { claudeUltracode, claudeHaikuAssist } : {}),
        permission,
        providerId: provider,
        computerUse: options?.computerUse === true,
      });
      if (nativeLaunch) {
        nativeLaunch.runId = result.runId;
        nativeLaunch.ready = true;
        pendingNativeLaunches.delete(requestedRunId);
      }
      options?.onRunStarted?.(result);
      options?.hostContinuation?.onReceived("turn", result.runId);
      // Older backends choose their own id. Retire the provisional route.
      if (result.runId !== requestedRunId) {
        runRouting.delete(requestedRunId);
        untrackRun(requestedRunId);
      }
      // A whole turn can finish while invoke is still pending. Its session
      // event has then moved the state and done has removed the routing entry.
      const knownKey = runRouting.get(result.runId) ?? Object.keys(get().bySession).find(
        (candidate) => get().bySession[candidate]?.settledRunIds?.includes(result.runId),
      );
      const settled = knownKey && get().bySession[knownKey]?.settledRunIds?.includes(result.runId);
      // A turn that settled while invoke was pending still needs the adoption
      // when its session announcement never arrived (an older backend, or a
      // done that carried the id silently): without it the tab stays pending
      // forever and no one clears its streaming flag. If onSession already
      // migrated the state, bySession[key] is gone and this stays a no-op.
      const stillPending = get().bySession[key] !== undefined;
      if (result.sessionId && !tab.sessionId
          && (!settled || (knownKey && get().bySession[knownKey]?.interrupted) || stillPending)) {
        // Preassigned native id (grok): adopt immediately.
        migrateSelectedAgent(tab.workspacePath, result.sessionId);
        const newKey = sessionKey(
          engine,
          result.sessionId,
          tab.workspacePath,
        );
        if (engine === "claude") {
          const latest = get().bySession[key]?.claudeUltracode ?? get().bySession[newKey]?.claudeUltracode ?? claudeUltracode;
          void persistClaudeUltracode(set, latest, result.sessionId);
        }
        if (model) {
          void ipc
            .rememberSessionModel?.(engine, result.sessionId, model)
            ?.catch(() => {});
        }
        if (effort) {
          void ipc
            .rememberSessionEffort?.(engine, result.sessionId, effort)
            ?.catch(() => {});
        }
        if (provider) {
          void ipc
            .rememberSessionProvider?.(engine, result.sessionId, provider)
            ?.catch(() => {});
        }
        routeAndReconcileRun(set, result.runId, newKey);
        set((s) => {
          const bySession = { ...s.bySession };
          if (bySession[key]) {
            bySession[newKey] = { ...bySession[key], draftLaunching: undefined };
            if (newKey !== key) delete bySession[key];
          }
          // Stamp only the tab that owns this run; blanketing every pending
          // tab of this engine+workspace would create duplicate session tabs.
          let stamped = false;
          const openTabs = dedupeTabs(
            s.openTabs.map((t) => {
              if (
                stamped ||
                t.engine !== engine ||
                t.sessionId !== null ||
                t.workspacePath !== tab.workspacePath
              ) {
                return t;
              }
              stamped = true;
              return { ...t, sessionId: result.sessionId, effort: undefined, claudeUltracode: undefined };
            }),
          );
          // Only the active tab adopts the native id on `active`; a
          // background drain leaves the user's current tab untouched.
          const active =
            s.active &&
            s.active.engine === engine &&
            s.active.sessionId === null &&
            s.active.workspacePath === tab.workspacePath
              ? { ...s.active, sessionId: result.sessionId, effort: undefined, claudeUltracode: undefined }
              : s.active;
          const drafts = { ...s.drafts };
          if (newKey !== key) {
            adoptedDraftKeys.set(key, newKey);
          }
          if (newKey !== key && key in drafts) {
            if (drafts[key] || !(newKey in drafts)) {
              drafts[newKey] = drafts[key];
            }
            delete drafts[key];
          }
          return {
            bySession,
            drafts,
            openTabs,
            active,
            streamingByKey: moveStreamingFlag(s.streamingByKey, key, newKey),
          };
        });
        persistTabs(get().openTabs, get().active);
        // Sidebar row + tab title pick the new session up immediately
        // instead of waiting for the post-turn rescan.
        upsertSessionMetaInto(
          set,
          optimisticMeta(
            engine,
            result.sessionId,
            tab.workspacePath,
            firstLineTitle(prompt),
          ),
        );
      } else if (!runRouting.has(result.runId) && !settled && get().bySession[key]) {
        // The engine can announce its session id while the invoke is in
        // flight; onSession rekeys the run to the native key then, and
        // routing it back to the pre-send key would strand the live turn
        // there while the tab renders the native key. If the pending state
        // is already gone the turn migrated (and possibly settled): routing
        // the id back would resurrect a dead pending key on the next event.
        routeAndReconcileRun(set, result.runId, key);
      }
      // Stop can precede native spawn while invoke is still in flight.
      // Retry the interrupt now that the backend has registered the child.
      // A native id adopted
      // just above moved the state to a new key, so read the key the turn
      // actually lives under.
      const liveKey = runRouting.get(result.runId) ?? knownKey ?? (
        result.sessionId && !tab.sessionId
          ? sessionKey(engine, result.sessionId, tab.workspacePath)
          : key);
      if (result.runId !== requestedRunId && get().bySession[liveKey]?.nativeTaskRunId === requestedRunId) {
        patchSession(set, liveKey, { nativeTaskRunId: result.runId });
      }
      if (result.runId !== requestedRunId && get().bySession[liveKey]?.codexRunId === requestedRunId) {
        patchSession(set, liveKey, { codexRunId: result.runId });
      }
      if (get().bySession[liveKey]?.interrupted && !usesNativeInterrupt(liveKey)) {
        patchSession(set, liveKey, { settledRunIds: rememberSettledRun(get().bySession[liveKey], result.runId) });
        runRouting.delete(result.runId);
        untrackRun(result.runId);
        dropRunUsage(result.runId);
        await Promise.all([
          ipc.interruptSession(result.runId).catch(() => false),
          ...(result.sessionId
            ? [ipc.interruptSession(result.sessionId).catch(() => false)]
            : []),
        ]);
      } else if (nativeLaunch?.retryInterrupt && get().bySession[liveKey]?.nativeTaskRunId === result.runId &&
        shouldInterruptTurn(get().bySession[liveKey], liveKey)) {
        await interruptReplyOnly(liveKey, get().bySession[liveKey]?.queueParked === true, true);
      }
    } catch (error) {
      const failedKey = runRouting.get(requestedRunId) ?? Object.keys(get().bySession).find(
        (candidate) => get().bySession[candidate]?.nativeTaskRunId === requestedRunId || get().bySession[candidate]?.codexRunId === requestedRunId,
      ) ?? key;
      if (isDeliveryOutcomeUnknown(error)) {
        const current = get().bySession[failedKey];
        const ownsRun = engine === "claude" ? current?.nativeTaskRunId === requestedRunId
          : engine === "codex" ? current?.codexRunId === requestedRunId
          : runRouting.get(requestedRunId) === failedKey;
        if (current && ownsRun && !current.settledRunIds?.includes(requestedRunId)) {
          // The native side may already own this run. Keep Stop/event routing,
          // its optimistic row and streaming state until real events settle it.
          patchSession(set, failedKey, { error: errorText(error), queueParked: true });
        }
        if (options?.requestedRunId) throw error;
        return;
      }
      runRouting.delete(requestedRunId);
      untrackRun(requestedRunId);
      dropRunUsage(requestedRunId);
      const failed = get().bySession[failedKey];
      if (engine === "claude" && (!failed || failed.nativeTaskRunId !== requestedRunId ||
        failed.settledRunIds?.includes(requestedRunId))) {
        // A native event already settled/replaced this launch. Its late IPC
        // error must not clear the new run or drain a second process into it.
        if (options?.requestedRunId) throw error;
        return;
      }
      if (engine === "codex" && (!failed || failed.codexRunId !== requestedRunId ||
        failed.settledRunIds?.includes(requestedRunId))) {
        if (options?.requestedRunId) throw error;
        return;
      }
      if (options?.computerUse) {
        void ipc.computerUseSetActive?.(false)?.catch(() => {});
      }
      set((s) => ({
        streamingByKey: setStreamingFlag(s.streamingByKey, failedKey, false),
      }));
      patchSession(set, failedKey, {
        error: String(error),
        streaming: false,
        turnStartedAt: null,
        throughput: settleThroughput(get().bySession[failedKey]?.throughput, requestedRunId, true),
      });
      // The send never became a turn, so no engine event will report one:
      // without this the rest of the queue waits for a settle that is not
      // coming. Each drain consumes one item, so a run of failures empties
      // the queue instead of looping.
      void get().refreshSessionUsage(failedKey);
      if (!get().bySession[failedKey]?.interrupted) drainQueue(failedKey);
      if (options?.requestedRunId) throw error;
    } finally {
      pendingNativeLaunches.delete(requestedRunId);
    }
  }

  /** Flag a finished background session as unseen so the sidebar shows the
   * green dot until the user opens it; the watched active tab never flags. */
  function markUnseenIfBackground(key: string) {
    const active = get().active;
    const activeKey = active
      ? sessionKey(active.engine, active.sessionId, active.workspacePath)
      : null;
    if (key === activeKey) return;
    set((s) => (s.unseen[key] ? {} : { unseen: { ...s.unseen, [key]: true } }));
  }

  /** After a turn ends, send the oldest queued message for that session. */
  function drainQueue(key: string) {
    if (isRuntimeSubmissionPaused()) return;
    const s = get();
    const session = s.bySession[key];
    if (!session || session.streaming || session.draftLaunching || session.queue.length === 0 ||
      session.queue[0].manualOnly || codexSteersInFlight.has(key)) return;
    const tab = s.openTabs.find(
      (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
    );
    if (!tab) return;
    const [head, ...rest] = session.queue;
    if (tab.sessionId) {
      const meta = s.sessions?.find(
        (item) =>
          item.engine === tab.engine &&
          item.sessionId === tab.sessionId &&
          (!item.workspacePath || item.workspacePath === tab.workspacePath),
      );
      if (meta) {
        const review = crossSessionCostReview(meta, s, "idle");
        const cache = review.cache;
        const ttlMs = cache ? (cache.reference?.maxTtlSeconds ?? cache.ttlSeconds) * 1000 : 0;
        const stalePreTurnCache = !!cache && cache.observedAt < head.queuedAt &&
          review.capturedAt - head.queuedAt < ttlMs;
        const guardStore = useSessionSendCostGuardStore.getState();
        if (!stalePreTurnCache && requiresQueueDrainCostApproval(review) && !guardStore.isApproved(key, review)) {
          set((prev) => {
            const cur = prev.bySession[key] ?? EMPTY_SESSION;
            if (!cur.queue.length) return {};
            return {
              bySession: {
                ...prev.bySession,
                [key]: {
                  ...cur,
                  queue: [{ ...cur.queue[0], manualOnly: true }, ...cur.queue.slice(1)],
                },
              },
            };
          });
          guardStore.hold({
            sessionKey: key,
            engine: tab.engine,
            sessionId: tab.sessionId,
            workspacePath: tab.workspacePath,
            prompt: head.text,
            images: head.images,
            computerUse: head.computerUse,
            mode: "queue_drain",
            queuedItemId: head.id,
            review,
          });
          return;
        }
      }
    }
    set((prev) => ({
      bySession: {
        ...prev.bySession,
        [key]: { ...(prev.bySession[key] ?? EMPTY_SESSION), queue: rest },
      },
    }));
    void sendPrompt(tab, head.text, head.images, {
      computerUse: head.computerUse,
    });
  }

  /** The CLI idles while background tasks run: take a queued message out of the
   *  queue and hand it to the live process. Without `only` this is the idle
   *  boundary's release (head only, never while a Stop parked the queue or an
   *  earlier delivery is still unconfirmed); with `only` it is the user's own
   *  "send now" on that row. Returns whether a delivery started; a row the live
   *  path cannot take stays queued until the final done (today's drain). */
  function releaseQueuedLive(key: string, only?: string): boolean {
    if (isRuntimeSubmissionPaused()) return false;
    const s = get();
    const session = s.bySession[key];
    if (!session || session.queue.length === 0) return false;
    const tab = s.openTabs.find(
      (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
    );
    const item = only ? session.queue.find((q) => q.id === only) : session.queue[0];
    if (!tab || !item || item.noLive) return false;
    if (
      !only &&
      (session.queueParked || session.interrupted || followUpGuardActive(session))
    ) {
      return false;
    }
    if (liveFollowUpBlocker(s, tab, session, { computerUse: item.computerUse === true })) {
      return false;
    }
    // Claim the boundary synchronously: the duplicate `waiting` event of the
    // same idle cycle must find the guard set, even while the agent-block
    // resolve below is still pending.
    set((prev) => {
      const cur = prev.bySession[key] ?? EMPTY_SESSION;
      return {
        bySession: {
          ...prev.bySession,
          [key]: {
            ...cur,
            queue: cur.queue.filter((q) => q.id !== item.id),
            followUpAt: Date.now(),
          },
        },
      };
    });
    void sendPrompt(
      tab,
      item.text,
      item.images,
      { computerUse: item.computerUse },
      { origin: "queue", item },
    );
    return true;
  }

  /** Park a message in the session's queue (the tail). */
  function enqueue(
    tab: ActiveSession,
    text: string,
    images: string[],
    options?: SendOptions,
  ) {
    const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
    set((s) => {
      const prev = s.bySession[key] ?? EMPTY_SESSION;
      return {
        bySession: {
          ...s.bySession,
          [key]: {
            ...prev,
            queue: [
              ...prev.queue,
              {
                id: newId(),
                text,
                images,
                queuedAt: Date.now(),
                computerUse: options?.computerUse === true,
              },
            ],
          },
        },
      };
    });
  }

  /** Put a message back at the head of the queue: it was taken out for a live
   *  delivery that did not happen. */
  function requeueFirst(key: string, item: QueuedMessage, patch: Partial<SessionState> = {}) {
    set((s) => {
      const session = s.bySession[key];
      return session
        ? { bySession: { ...s.bySession, [key]: { ...session, ...patch, queue: [item, ...session.queue] } } }
        : {};
    });
  }

  function requeueCodexInput(key: string, item: QueuedMessage, patch: Partial<SessionState> = {}) {
    set((s) => {
      const session = s.bySession[key];
      if (!session) return {};
      const queue = session.queue.filter((q) => q.id !== item.id);
      // An ACK's arrival order must never reverse concurrent user inputs.
      const index = queue.findIndex((q) => q.steerOrder == null || q.steerOrder > (item.steerOrder ?? 0));
      queue.splice(index < 0 ? queue.length : index, 0, item);
      return { bySession: { ...s.bySession, [key]: { ...session, ...patch, queue } } };
    });
  }

  /** A row taken out for a live delivery that did not happen has been put back
   *  at the head of the queue. If the run ended meanwhile, its final done has
   *  already drained the queue (empty, or onto a later run), so nothing else
   *  would ever send the row: it goes out the ordinary way now. A Stop (kill or
   *  interrupt park) keeps it queued: the next message is the user's to send. */
  function drainWhenRunEnded(key: string) {
    const after = get().bySession[key];
    if (after && !after.streaming && !after.interrupted && !after.queueParked) drainQueue(key);
  }

  /** Park a message the user explicitly sent behind the run in flight. Any
   *  explicit send is the user's next move and lifts a Stop's park, in every CLI
   *  state: left parked, nothing would ever send this message (the release
   *  refuses while parked and the final done keeps a parked queue), so it would
   *  sit behind a run that has long ended. The interrupt that may still be
   *  winding down (interruptRequestedAt) stays until the CLI ends the reply.
   *  The queue is released at the next idle boundary, FIFO
   *  and one item per boundary, or right now when the CLI already idles (a head
   *  the live path can take). */
  function enqueueExplicit(
    tab: ActiveSession,
    text: string,
    images: string[],
    options?: SendOptions,
  ) {
    if (options?.hostContinuation) throw new HostChatBusyError("Host continuation remains in its durable queue");
    const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
    enqueue(tab, text, images, options);
    if (get().bySession[key]?.queueParked) {
      patchSession(set, key, { queueParked: false });
      releaseQueuedLive(key);
    }
  }

  /** Steering keeps the current turn's timer, usage, output and transport.
   * A rejected RPC remains visible for manual retry; an unavailable
   * turn queues until the original run actually settles. */
  async function deliverCodexSteer(
    tab: ActiveSession,
    key: string,
    prompt: string,
    typedPrompt: string,
    images: string[],
    options: SendOptions | undefined,
    live: LiveDelivery,
    agentResolveError: string | null,
  ) {
    const item: QueuedMessage = live.item ?? {
      id: newId(), text: typedPrompt, images, queuedAt: Date.now(), computerUse: options?.computerUse,
    };
    const current = get().bySession[key];
    const runId = current?.codexRunId;
    if (!current || !runId || codexSteerBlocker(get(), tab, current, options)) {
      if (options?.hostContinuation) throw new HostChatBusyError();
      // The turn/settings may have changed while the selected agent resolved.
      if (get().bySession[key]) requeueCodexInput(key, item);
      return;
    }
    if (options?.hostContinuation) {
      await options.hostContinuation.beforeDelivery("steer", runId);
      if (get().bySession[key]?.codexRunId !== runId || codexSteerBlocker(get(), tab, get().bySession[key], options)) throw new HostChatBusyError();
    }
    // Fold all received text before input, but steering is not an item end:
    // subsequent deltas of the same native document must keep Markdown whole.
    const pending = drainPending(key);
    patchSession(set, key, {
      messages: pending
        ? applyStreamParts(current.messages, pending.parts, pending.model, pending.effort)
        : current.messages,
    });
    appendCommittedRows(set, key, [{
      role: "user", text: prompt, ts: new Date().toISOString(), steer: true,
      images: images.length ? [...images] : undefined,
    }], { error: agentResolveError });
    const userSeq = get().bySession[key]?.messages.at(-1)?.seq;
    const hostUserRow = get().bySession[key]?.messages.at(-1);
    const rollback = () => set((s) => {
      const session = s.bySession[key];
      return session ? { bySession: { ...s.bySession, [key]: {
        ...session, messages: session.messages.filter((m) => !(m.seq === userSeq && m.role === "user")),
      } } } : {};
    });
    try {
      if (options?.hostUserRow && hostUserRow?.role === "user") await options.hostUserRow({ runId, seq: hostUserRow.seq, ts: hostUserRow.ts, text: hostUserRow.text, ...(hostUserRow.images ? { images: [...hostUserRow.images] } : {}) });
      if (options?.hostUserRow && (get().bySession[key]?.codexRunId !== runId || codexSteerBlocker(get(), tab, get().bySession[key], options))) throw new HostChatBusyError("Exact host steer changed during row persistence");
      const accepted = await ipc.sendFollowUp({
        sessionId: runId, engine: tab.engine, workspacePath: tab.workspacePath,
        prompt, imagePaths: images.length ? images : null,
      });
      if (!accepted) {
        rollback();
        if (options?.hostContinuation) throw new HostChatBusyError("Native turn did not accept the continuation");
        requeueCodexInput(key, item);
      }
      if (accepted) options?.hostContinuation?.onReceived("steer", runId);
    } catch (error) {
      if (options?.hostContinuation) {
        if (!isDeliveryOutcomeUnknown(error)) rollback();
        throw error;
      }
      if (isDeliveryOutcomeUnknown(error)) {
        // An accepted steer cannot become a second queued instruction. Keep
        // the committed row and let actual native events settle the run.
        patchSession(set, key, { error: errorText(error), queueParked: true });
        return;
      }
      rollback();
      requeueCodexInput(key, { ...item, manualOnly: true }, { error: errorText(error) });
    }
  }

  /** Write a message straight into the live CLI behind `key`, which is idle
   *  while its background tasks run (the native CLI takes a typed message at
   *  once). The row, activity and timer are optimistic; whatever the CLI cannot
   *  take is rolled back so nothing is shown twice or lost. */
  async function deliverFollowUp(
    tab: ActiveSession,
    key: string,
    prompt: string,
    typedPrompt: string,
    images: string[],
    options: SendOptions | undefined,
    live: LiveDelivery,
    agentResolveError: string | null,
  ) {
    // The preparation before this (built-in agent resolve) can yield: the CLI
    // may have moved on since the caller looked. Give the message back to
    // whoever it came from and let the ordinary rules decide.
    const cur = get().bySession[key];
    const runId = cur?.nativeTaskRunId;
    if (!cur || !runId || (live.origin === "queue" && cur.queueParked) ||
      liveFollowUpBlocker(get(), tab, cur, { computerUse: options?.computerUse === true })) {
      patchSession(set, key, { followUpAt: null });
      if (options?.hostContinuation) throw new HostChatBusyError();
      if (live.origin === "queue" && live.item) {
        requeueFirst(key, live.item);
        // The run may have ended during the preparation: its final done drained
        // a queue that no longer held this row.
        drainWhenRunEnded(key);
      } else if (get().bySession[key]?.streaming) {
        // An explicit send: the park the direct-live path never lifted goes now.
        enqueueExplicit(tab, typedPrompt, images, options);
      } else {
        await sendPrompt(tab, typedPrompt, images, options);
      }
      return;
    }
    if (options?.hostContinuation) {
      await options.hostContinuation.beforeDelivery("live", runId);
      if (get().bySession[key]?.nativeTaskRunId !== runId || liveFollowUpBlocker(get(), tab, get().bySession[key], options)) throw new HostChatBusyError();
    }
    const claimedAt = Date.now();
    const before = {
      activity: cur.nativeActivity ?? null,
      turnStartedAt: cur.turnStartedAt,
      turnUsage: cur.turnUsage,
      throughput: cur.throughput,
      error: cur.error,
    };
    appendCommittedRows(
      set,
      key,
      [
        {
          role: "user",
          text: prompt,
          ts: new Date().toISOString(),
          images: images.length ? [...images] : undefined,
        },
      ],
      {
        streaming: true,
        error: null,
        // The CLI starts the turn within ~100ms and says so; until then the
        // tail already reads "running" and the next typed message queues.
        nativeActivity: "running",
        turnStartedAt: claimedAt,
        turnUsage: null,
        throughput: startThroughput(runId),
        // An explicit send is the user's next move: it lifts a Stop's park.
        queueParked: false,
        interruptRequestedAt: null,
        followUpAt: claimedAt,
      },
    );
    const userSeq = get().bySession[key]?.messages.at(-1)?.seq;
    const hostUserRow = get().bySession[key]?.messages.at(-1);
    if (agentResolveError) patchSession(set, key, { error: agentResolveError });
    // Take the optimistic state back. What the CLI itself reported since (it
    // clears followUpAt) is newer than the snapshot and stays.
    const rollback = () =>
      set((s) => {
        const session = s.bySession[key];
        if (!session) return {};
        const untouched = session.followUpAt === claimedAt;
        return {
          bySession: {
            ...s.bySession,
            [key]: {
              ...session,
              messages: session.messages.filter(
                (m) => !(m.seq === userSeq && m.role === "user"),
              ),
              ...(untouched
                ? {
                    followUpAt: null,
                    nativeActivity: before.activity,
                    turnStartedAt: before.turnStartedAt,
                    turnUsage: before.turnUsage,
                    throughput: before.throughput,
                    error: before.error,
                  }
                : {}),
            },
          },
        };
      });
    let delivered: boolean;
    try {
      if (options?.hostUserRow && hostUserRow?.role === "user") await options.hostUserRow({ runId, seq: hostUserRow.seq, ts: hostUserRow.ts, text: hostUserRow.text, ...(hostUserRow.images ? { images: [...hostUserRow.images] } : {}) });
      if (options?.hostUserRow && (get().bySession[key]?.nativeTaskRunId !== runId || get().bySession[key]?.queueParked ||
        liveFollowUpBlocker(get(), tab, get().bySession[key], { activity: "running" }))) throw new HostChatBusyError("Exact host live input changed during row persistence");
      delivered = await ipc.sendFollowUp({
        sessionId: runId,
        engine: tab.engine,
        workspacePath: tab.workspacePath,
        prompt,
        imagePaths: images.length ? images : null,
      });
    } catch (error) {
      if (options?.hostContinuation) {
        if (!isDeliveryOutcomeUnknown(error)) rollback();
        throw error;
      }
      if (isDeliveryOutcomeUnknown(error)) {
        // A lost ACK is not permission to launch this prompt again. Retain the
        // optimistic row/activity and park later work without requeueing it.
        patchSession(set, key, { error: errorText(error), queueParked: true });
        return;
      }
      rollback();
      // A real failure (image load, pipe write): surface it and keep the text
      // where the user can see and resend it, in the queue. It is not retried
      // at every idle boundary; the final done sends it the ordinary way.
      requeueFirst(
        key,
        { ...(live.item ?? { id: newId(), text: typedPrompt, images, queuedAt: Date.now() }), noLive: true },
        { error: errorText(error) },
      );
      // The run may have ended while the write was failing (the broken pipe is
      // often that very exit): its final done already drained the queue, so
      // nothing is left to send the row the ordinary way. Without this it would
      // sit in an idle session until some later run's done.
      drainWhenRunEnded(key);
      return;
    }
    if (!delivered) {
      // The run ended while the message was on its way (final done, stdin
      // closed): nothing took it, so it is an ordinary send now. The row it
      // would have shown twice is taken back first.
      rollback();
      if (options?.hostContinuation) throw new HostChatBusyError("Native process did not accept the continuation");
      const item = live.item ?? { id: newId(), text: typedPrompt, images, queuedAt: Date.now() };
      if (get().bySession[key]?.interrupted || get().bySession[key]?.queueParked) {
        // Stop may have interrupted the reply while the write was pending.
        // A failed delivery must not launch the turn the user just stopped.
        requeueFirst(key, item);
        return;
      }
      const now = get().bySession[key];
      if (now?.streaming && now.nativeTaskRunId !== runId) {
        // The final done that closed the CLI can arrive before this reply, and
        // its queue drain may already have started the next run: a second
        // launch now would run two processes on one session. The message waits
        // in the queue (ahead of what is left, as an explicit send does) and
        // goes with that run's final done. A session still streaming the SAME
        // run is the done not having arrived yet: the backend said nothing live
        // takes the message, so the ordinary send is the right answer there.
        requeueFirst(key, item);
        return;
      }
      await sendPrompt(tab, prompt, images, options);
    }
    if (delivered) options?.hostContinuation?.onReceived("live", runId);
  }

  /** Native Esc never escalates to a process kill. Keep routing and partial
   *  output until the CLI ends the reply; a write is not an acknowledgement.
   *  A later click resends an ignored request, and an IPC failure stays visible. */
  async function interruptReplyOnly(key: string, park: boolean, afterSpawn = false): Promise<boolean> {
    const session = get().bySession[key];
    if (!shouldInterruptTurn(session, key)) return false;
    const runId = session!.nativeTaskRunId!;
    // Stop also parks a queue whose Send Now already requested an interrupt.
    if (park) patchSession(set, key, { queueParked: true });
    const requestedAt = session!.interruptRequestedAt;
    if (requestedAt != null && interruptsInFlight.get(runId)?.at === requestedAt) return true;
    if (!afterSpawn && requestedAt != null && Date.now() - requestedAt < INTERRUPT_GRACE_MS) return true;
    // Park before the IPC: a final done racing the call must not drain the
    // queue behind the user's Stop.
    const requested = Date.now();
    patchSession(set, key, {
      interruptRequestedAt: requested,
      lastInterruptAt: requested,
      ...(park ? { queueParked: true } : {}),
    });
    const launch = pendingNativeLaunches.get(runId);
    const request = { at: requested };
    // Session adoption and a completed/newer run may race the IPC response.
    // Always apply its result to its own still-live run, never a captured key.
    const ownerKey = () => {
      const currentRun = launch?.ready ? launch.runId : runId;
      const routed = runRouting.get(currentRun);
      const current = routed ? get().bySession[routed] : undefined;
      return interruptsInFlight.get(runId) === request && routed && current?.streaming && !current.interrupted &&
        current.nativeTaskRunId === currentRun && current.interruptRequestedAt === requested
        ? routed : undefined;
    };
    interruptsInFlight.set(runId, request);
    try {
      const accepted = await ipc.interruptTurn(runId);
      if (accepted) return true;
      const currentKey = ownerKey();
      if (!currentKey) return true;
      if (launch && !launch.ready) {
        launch.retryInterrupt = true;
      } else if (launch?.ready) {
        // Registration won the race against this false reply. Readdress the
        // registered child once (including an older backend's chosen run id).
        interruptsInFlight.delete(runId);
        await interruptReplyOnly(currentKey, get().bySession[currentKey]?.queueParked === true, true);
      } else {
        // The backend confirmed there is no live input channel. Settle locally;
        // there is nothing to kill. Send Now may now drain, Stop remains parked.
        const currentRun = get().bySession[currentKey]!.nativeTaskRunId!;
        const parked = get().bySession[currentKey]?.queueParked === true;
        settleStopped(currentKey);
        patchSession(set, currentKey, {
          settledRunIds: rememberSettledRun(get().bySession[currentKey], currentRun),
          interrupted: parked,
        });
        runRouting.delete(currentRun);
        untrackRun(currentRun);
        dropRunUsage(currentRun);
        if (!parked) drainQueue(currentKey);
      }
    } catch (error) {
      const currentKey = ownerKey();
      if (currentKey) patchSession(set, currentKey, { error: i18n.t("chat.interruptFailed", { error: errorText(error) }) });
    } finally {
      if (interruptsInFlight.get(runId) === request) interruptsInFlight.delete(runId);
    }
    return true;
  }

  /** End a stopped session's busy state: fold unflushed chunks into settled
   *  rows and park the queue (`interrupted`). */
  function settleStopped(key: string) {
    const pending = drainPending(key);
    set((s) => {
      const cur = s.bySession[key] ?? EMPTY_SESSION;
      const messages = settleLiveRows(
        pending
          ? applyStreamParts(cur.messages, pending.parts, pending.model)
          : cur.messages,
      );
      return {
        bySession: {
          ...s.bySession,
          [key]: {
            ...cur,
            messages: abortAutoReviews(messages),
            streaming: false,
            interrupted: true,
            // The run is retired: no interrupt or delivery remains pending;
            // `interrupted` is what parks the queue now.
            followUpAt: null,
            queueParked: false,
            interruptRequestedAt: null,
            lastInterruptAt: null,
            turnStartedAt: null,
            throughput: settleThroughput(cur.throughput, undefined, true),
            retry: null,
            // A stop ends following a Codex Desktop turn here, even before
            // its terminal event lands.
            handoff: null,
          },
        },
        streamingByKey: setStreamingFlag(s.streamingByKey, key, false),
        retryingByKey: setRetryingFlag(s.retryingByKey, key, false),
      };
    });
  }

  /** 按会话 key 停止，并取消仍在准备中的发送。 */
  async function interruptByKey(key: string) {
    if (get().bySession[key]?.draftLaunching && !get().bySession[key]?.streaming) {
      patchSession(set, key, { interrupted: true, queueParked: true, draftLaunching: undefined });
      return;
    }
    for (const preparation of preparingLive) {
      if (preparation.key === key) preparation.stopped = true;
    }
    // Right behind a Stop whose interrupt the CLI already acknowledged (it acks
    // and idles within milliseconds): a double click, not a request to end the
    // tasks that Stop preserved.
    if (isInterruptEcho(get().bySession[key])) {
      patchSession(set, key, { queueParked: true });
      return;
    }
    if (usesNativeInterrupt(key)) {
      // Inspect before yielding: an idle Stop must not settle a new send that
      // starts in the microtask while an ineligible helper returns false.
      if (shouldInterruptTurn(get().bySession[key], key)) await interruptReplyOnly(key, true);
      else if (get().bySession[key]?.streaming) settleStopped(key);
      return;
    }
    await killByKey(key);
  }

  /** Stop that ends the run: kill the process tree (and with it any background
   *  task) and park the queue. */
  async function killByKey(key: string) {
    const deadRunIds = [...runRouting].filter(([, routed]) => routed === key).map(([runId]) => runId);
    // Settle locally FIRST: the killed run's done event can arrive while
    // the kill IPCs below are still in flight, and onDone drains the queue
    // whenever interrupted is still false — that would fire the next
    // queued message right after the user pressed stop.
    settleStopped(key);
    if (key.startsWith("codex/") || key.startsWith("new:codex:")) {
      // Retire exactly the runs Stop targeted before its first await. Late
      // Done must not clear parking or let an in-flight steer restart work.
      for (const runId of deadRunIds) {
        patchSession(set, key, { settledRunIds: rememberSettledRun(get().bySession[key], runId) });
        runRouting.delete(runId);
        untrackRun(runId);
        dropRunUsage(runId);
      }
    }
    // Registry is keyed by native session id once known; before that the
    // run id routes. Try both.
    const sessionId = key.includes("/") ? key.slice(key.indexOf("/") + 1) : "";
    if (sessionId && !key.startsWith("new:") && !(key.startsWith("codex/") && deadRunIds.length))
      await ipc.interruptSession(sessionId).catch(() => false);
    // Independent kills, one IPC call per routed run — fired together.
    await Promise.all(
      deadRunIds.map((runId) => ipc.interruptSession(runId).catch(() => false)),
    );
    // The runs are dead: drop their routing and usage entries so the maps
    // cannot grow forever. (A late done event would also remove them.)
    for (const runId of deadRunIds) {
      patchSession(set, key, {
        settledRunIds: rememberSettledRun(get().bySession[key], runId),
      });
      runRouting.delete(runId);
      untrackRun(runId);
      dropRunUsage(runId);
    }
    // A late event from a stopped run can adopt it again while the kills
    // were in flight, and its terminal event is now filtered as settled.
    // Unless a new run took this session over, settle it again so the tab
    // cannot stay busy for good (a Codex Desktop hand-off reports every
    // poll, which makes that window easy to hit).
    if (![...runRouting.values()].includes(key) && get().bySession[key]?.streaming) {
      settleStopped(key);
    }
    // Refresh without holding Stop: the read can take three loads with
    // backoff, and Stop must complete immediately (every other caller
    // fires and forgets).
    void get().refreshSessionUsage(key);
  }

  /** A granted directory is stored for the NEXT launch: `--add-dir` is a launch
   *  argument and a running CLI cannot widen its allowed dirs. Every live CLI
   *  launched before the grant (the grant is global, not per session) would deny
   *  the same path again, and the duplicate denial is deduped away, so the user
   *  would see "granted but still fails". Their follow-ups queue instead and the
   *  next launch carries the grant, as every message did before live follow-ups.
   *  The flag lives in liveLaunch, so the next launch starts without it. */
  function markLiveRunsLaunchedBeforeGrant() {
    set((s) => {
      let bySession: typeof s.bySession | undefined;
      for (const [liveKey, cur] of Object.entries(s.bySession)) {
        if (!cur.streaming || !cur.liveLaunch || cur.liveLaunch.grantedSinceLaunch) continue;
        bySession ??= { ...s.bySession };
        bySession[liveKey] = { ...cur, liveLaunch: { ...cur.liveLaunch, grantedSinceLaunch: true } };
      }
      return bySession ? { bySession } : {};
    });
  }

  return guardRuntimeActions<ReturnType<typeof createMessagingActions>>({
    drainQueue,
    drainQueueLive: (key) => {
      releaseQueuedLive(key);
    },
    markUnseenIfBackground,

    send: async (prompt, images, options, target) => {
      const session = resolveLiveSessionTab(target === undefined ? get().active : target, get().openTabs);
      if (session) await sendPrompt(session, prompt, images, options);
    },

    respondToGrant: async (key, seq, accept) => {
      const message = get().bySession[key]?.messages.find((m) => m.seq === seq);
      if (!message || message.role !== "grant" || message.grant?.status !== "pending") {
        return;
      }
      if (!accept) {
        patchGrantBySeq(set, key, seq, () => ({ status: "declined" }));
        return;
      }
      const path = message.path;
      if (!path) return;
      try {
        await ipc.grantRoot(path);
        patchGrantBySeq(set, key, seq, (grant) => ({
          ...grant,
          status: "granted",
        }));
        markLiveRunsLaunchedBeforeGrant();
      } catch (error) {
        patchSession(set, key, { error: errorText(error) });
      }
    },

    respondToPlanReview: async (key, planId, expectedRevision, decision, feedback) => {
      const row = (get().bySession[key]?.messages ?? []).find(
        (m) =>
          m.planReview?.planId === planId &&
          m.planReview?.revision === expectedRevision,
      );
      const record = row?.planReview;
      // Only an open revision can be decided; anything else (already
      // submitted, settled, unknown) is a stale click the backend CAS would
      // reject anyway.
      if (
        !record ||
        (record.status !== "awaiting_review" && record.status !== "deferred")
      ) {
        return { kind: "error", error: i18n.t("chat.planReviewNotPending") };
      }
      const text = feedback?.trim() || undefined;
      if (decision === "request_changes" && !text) {
        return { kind: "error", error: i18n.t("chat.planReviewFeedbackRequired") };
      }
      if (decision !== "defer" && !record.complete) {
        return { kind: "error", error: i18n.t("chat.planReviewIncomplete") };
      }
      const revertTo = record.status;
      patchPlanReview(set, key, planId, expectedRevision, (cur) => ({
        ...cur,
        status: "submitting",
      }));
      try {
        const outcome = await ipc.respondPlanReview(
          planId,
          expectedRevision,
          decision,
          text,
        );
        // Applied or conflict, the returned record is the backend's truth:
        // a conflict replaces the card with the current state instead of
        // pretending the submit landed.
        patchPlanReview(set, key, planId, expectedRevision, () => outcome.review);
        // A landed decision closes a dock the user reopened from the card.
        if (get().bySession[key]?.planReviewResume === `${planId}:${expectedRevision}`) {
          patchSession(set, key, { planReviewResume: null });
        }
        return outcome.outcome === "applied"
          ? { kind: "applied", record: outcome.review }
          : { kind: "conflict", record: outcome.review };
      } catch (error) {
        // Never fake success: the card returns to its pre-submit status so
        // the user can retry (or the next settled event resolves it).
        patchPlanReview(set, key, planId, expectedRevision, (cur) =>
          cur.status === "submitting" ? { ...cur, status: revertTo } : cur,
        );
        return { kind: "error", error: errorText(error) };
      }
    },

    resumePlanReview: (key, resume) => {
      patchSession(set, key, { planReviewResume: resume });
    },

    respondToQuestion: async (key, seq, answers) => {
      const message = get().bySession[key]?.messages.find((m) => m.seq === seq);
      const question = message?.question;
      if (
        !message ||
        message.role !== "question" ||
        !question ||
        question.status !== "pending" || question.submitting
      ) {
        return;
      }
      if (question.codexApproval) {
        const decision = answers?.decision;
        if ((decision !== "allow_once" && decision !== "decline") ||
          (decision === "allow_once" && !question.codexApproval.canApprove)) return;
        patchQuestionByRequestId(set, key, question.runId, question.requestId, (cur) => ({ ...cur, submitting: true, error: undefined }));
      }
      // A multi-select round is answered through the CLI's free-form row, whose
      // editor then carries the picked labels: replying to the select frame with
      // a label only toggles the CLI's own set and re-asks the same question.
      const loop = answers && !question.codexApproval ? beginAskSubmit(key, question.runId, seq, answerText(answers)) : undefined;
      try {
        await ipc.answerQuestion(
          question.runId,
          question.requestId,
          loop ? { [loop.base]: ASK_OTHER_OPTION } : answers,
        );
        patchQuestionByRequestId(set, key, question.runId, question.requestId, (cur) => cur.status !== "pending" ? cur : ({
          ...cur,
          status: answers ? ("answered" as const) : ("dismissed" as const),
          submitting: false,
          error: undefined,
          ...(answers ? { answers } : {}),
        }));
        // Skipping abandons the round: the CLI settles it as cancelled.
        if (!answers && askLoops.get(key)?.runId === question.runId) askLoops.delete(key);
      } catch (error) {
        // The answer never reached the process (the run is gone): surface it;
        // a later question_settled event resolves the still-pending card.
        if (loop) revertAskSubmit(key, question.runId, seq);
        if (question.codexApproval) patchQuestionByRequestId(set, key, question.runId, question.requestId, (cur) => cur.status !== "pending" ? cur : ({ ...cur, submitting: false, error: errorText(error) }));
        if (!get().bySession[key]?.settledRunIds?.includes(question.runId)) patchSession(set, key, { error: errorText(error) });
      }
    },

    resendLastUser: async (key) => {
      const s = get();
      if (s.streamingByKey[key]) return; // a turn is already running
      const messages = s.bySession[key]?.messages ?? [];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUser) return;
      const tab =
        s.openTabs.find(
          (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
        ) ?? s.active;
      if (tab)
        await sendPrompt(tab, lastUser.text, lastUser.images ?? [], {
          computerUse: s.bySession[key]?.activeComputerUse === true,
        });
    },

    queueMessage: (text, images, options, target) => {
      const session = resolveLiveSessionTab(target === undefined ? get().active : target, get().openTabs);
      if (!session || (!text.trim() && images.length === 0)) return;
      enqueue(session, text, images, options);
    },

    /** A message typed while a turn is in flight. A Claude CLI that is idle
     *  with background tasks running takes it at once (as the native CLI
     *  does); anything else queues, as before. */
    sendWhileBusy: async (text, images, options, target) => {
      const tab = options?.hostContinuation
        ? get().openTabs.find(t => target && t.engine === target.engine && t.sessionId === target.sessionId && t.workspacePath === target.workspacePath)
        : resolveLiveSessionTab(target === undefined ? get().active : target, get().openTabs);
      if (options?.hostContinuation && !tab) throw new HostChatBusyError("Exact host conversation is no longer open");
      if (!tab || (!text.trim() && images.length === 0)) return;
      const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
      const session = get().bySession[key];
      if (session?.draftLaunching && !session.streaming) {
        enqueueExplicit(tab, text, images, options);
        return;
      }
      // The turn ended between the composer's look and this call: nothing is
      // left to queue behind, so it is an ordinary send.
      if (!session?.streaming) {
        await sendPrompt(tab, text, images, options);
        return;
      }
      if (tab.engine === "codex") {
        if (!codexSteerBlocker(get(), tab, session, options)) {
          await sendPrompt(tab, text, images, options, { origin: "composer" });
        } else {
          enqueueExplicit(tab, text, images, options);
          patchSession(set, key, { error: i18n.t("chat.steerUnavailable") });
        }
        return;
      }
      if (!liveFollowUpBlocker(get(), tab, session, { computerUse: options?.computerUse === true })) {
        // Claim the idle boundary before anything yields, so a queued item
        // cannot overtake this explicit send.
        patchSession(set, key, { followUpAt: Date.now() });
        await sendPrompt(tab, text, images, options, { origin: "composer" });
        return;
      }
      enqueueExplicit(tab, text, images, options);
    },

    removeQueued: (id, key) => {
      const targetKey = resolveKey(key, get().active);
      if (!targetKey) return;
      if (useSessionSendCostGuardStore.getState().bySessionKey[targetKey]?.queuedItemId === id) {
        useSessionSendCostGuardStore.getState().dismiss(targetKey);
      }
      set((s) => {
        const prev = s.bySession[targetKey];
        if (!prev) return {};
        return {
          bySession: {
            ...s.bySession,
            [targetKey]: {
              ...prev,
              queue: prev.queue.filter((item) => item.id !== id),
            },
          },
        };
      });
      drainWhenRunEnded(targetKey);
    },
    /** Reorder one queued message a single step. The card paints newest
     *  first, so "up" walks the row toward the end of the send order (sent
     *  later) and "down" toward the head (sent sooner); a move past either
     *  end is a no-op. */
    moveQueued: (id, direction, key) => {
      const targetKey = resolveKey(key, get().active);
      if (!targetKey) return;
      set((s) => {
        const prev = s.bySession[targetKey];
        if (!prev) return {};
        const index = prev.queue.findIndex((item) => item.id === id);
        if (index < 0) return {};
        const target = direction === "up" ? index + 1 : index - 1;
        if (target < 0 || target >= prev.queue.length) return {};
        const queue = [...prev.queue];
        [queue[index], queue[target]] = [queue[target], queue[index]];
        return {
          bySession: {
            ...s.bySession,
            [targetKey]: { ...prev, queue },
          },
        };
      });
    },
    clearQueue: (key) => {
      const targetKey = resolveKey(key, get().active);
      if (!targetKey) return;
      if (useSessionSendCostGuardStore.getState().bySessionKey[targetKey]?.mode === "queue_drain") {
        useSessionSendCostGuardStore.getState().dismiss(targetKey);
      }
      set((s) => {
        const prev = s.bySession[targetKey];
        if (!prev || prev.queue.length === 0) return {};
        return {
          bySession: {
            ...s.bySession,
            [targetKey]: { ...prev, queue: [] },
          },
        };
      });
    },

    /** Jump the queue with one message. An engine takes one prompt at a time,
     *  so "now" means stopping the turn in flight; the row moves to the head
     *  and the stop's own park is lifted, so the exit drain sends this message
     *  instead of waiting the turn out. The rows behind it follow on the next
     *  settle. */
    sendQueuedNow: async (id, key) => {
      const targetKey = resolveKey(key, get().active);
      if (!targetKey) return;
      const session = get().bySession[targetKey];
      const item = session?.queue.find((entry) => entry.id === id);
      if (!item || !session) return;
      const running = session.streaming;
      const tab = get().openTabs.find((t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === targetKey);
      if (tab?.sessionId) {
        const meta = get().sessions?.find(
          (m) => m.engine === tab.engine && m.sessionId === tab.sessionId && (!m.workspacePath || m.workspacePath === tab.workspacePath),
        );
        if (meta) {
          useSessionSendCostGuardStore.getState().markApproved(targetKey, crossSessionCostReview(meta, get(), running ? "busy" : "idle"));
        } else {
          useSessionSendCostGuardStore.getState().dismiss(targetKey);
        }
      }
      if (running && tab?.engine === "codex") {
        // Sending a queued Codex instruction steers the existing turn; no
        // interrupt/kill is ever a substitute for an unavailable steer.
        if (codexSteerBlocker(get(), tab, session, { computerUse: item.computerUse })) {
          patchSession(set, targetKey, { error: i18n.t("chat.steerUnavailable") });
          return;
        }
        patchSession(set, targetKey, { queue: session.queue.filter((q) => q.id !== id) });
        await sendPrompt(tab, item.text, item.images, { computerUse: item.computerUse }, {
          origin: "queue", item: { ...item, manualOnly: false },
        });
        return;
      }
      set((s) => {
        const prev = s.bySession[targetKey] ?? EMPTY_SESSION;
        return {
          bySession: {
            ...s.bySession,
            [targetKey]: {
              ...prev,
              queue: [item.manualOnly ? { ...item, manualOnly: false } : item, ...prev.queue.filter((entry) => entry.id !== id)],
              interrupted: false,
              queueParked: false,
            },
          },
        };
      });
      // A live CLI needs no kill: an idle one takes the row right now, a busy
      // one only has its reply interrupted (the tasks survive) and the row
      // leaves at the idle boundary that follows.
      if (running && releaseQueuedLive(targetKey, id)) return;
      // Launch settings, grants and noLive govern message delivery, not Esc.
      if (running && await interruptReplyOnly(targetKey, false)) return;
      if (running && usesNativeInterrupt(targetKey)) return;
      if (running) await killByKey(targetKey);
      drainQueue(targetKey);
    },

    interrupt: async (target) => {
      const key = keyOfTarget(target === undefined ? get().active : target, null);
      if (!key) return;
      await interruptByKey(key);
    },

    compactContext: async (key?: string, instructions?: string) => {
      const { active, streamingByKey, openTabs } = get();
      const targetKey =
        key ??
        (active
          ? sessionKey(active.engine, active.sessionId, active.workspacePath)
          : "");
      if (!targetKey) return;
      if (streamingByKey[targetKey]) return;
      const targetTab =
        openTabs.find(
          (t) =>
            sessionKey(t.engine, t.sessionId, t.workspacePath) === targetKey,
        ) ?? active;
      if (!targetTab?.sessionId || !engineSupportsCompact(get().engines, targetTab.engine)) return;

      // Manual-compaction flag: the tail status strip swaps to the compacting
      // label for the whole run. Cleared in the finally below.
      patchSession(set, targetKey, {
        compaction: { automatic: false, startedAt: Date.now() },
      });

      // Track the compaction turn completion so callers (and UI) can await it.
      let cleanup: (() => void) | undefined;
      const completionPromise = new Promise<void>((resolve) => {
        let started = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const unsub = subscribe(() => {
          const currentStreaming = get().streamingByKey;
          const isStreaming = Boolean(
            currentStreaming[targetKey] ||
              (targetTab.sessionId &&
                currentStreaming[
                  sessionKey(
                    targetTab.engine,
                    targetTab.sessionId,
                    targetTab.workspacePath,
                  )
                ]),
          );
          if (isStreaming) {
            started = true;
          } else if (started) {
            done();
          }
        });

        const done = () => {
          if (timeoutId) clearTimeout(timeoutId);
          unsub();
          resolve();
        };

        timeoutId = setTimeout(done, 120_000);
        cleanup = () => {
          if (timeoutId) clearTimeout(timeoutId);
          unsub();
        };
      });

      try {
        const trimmedInstructions = instructions?.trim();
        const compactPrompt = trimmedInstructions ? `/compact ${trimmedInstructions}` : "/compact";
        await sendPrompt(targetTab, compactPrompt, []);
      } catch (error) {
        cleanup?.();
        patchSession(set, targetKey, { compaction: null });
        throw error;
      }

      await completionPromise;
      // After compaction turn finishes, wait briefly for engine to persist session file,
      // then refresh session usage snapshot.
      await new Promise((r) => setTimeout(r, 400));
      const latestTab =
        get().openTabs.find(
          (t) =>
            sessionKey(t.engine, t.sessionId, t.workspacePath) === targetKey,
        ) ?? get().active;
      const finalKey = latestTab
        ? sessionKey(
            latestTab.engine,
            latestTab.sessionId,
            latestTab.workspacePath,
          )
        : targetKey;
      await get().refreshSessionUsage(finalKey);
      // The settle paths clear the flag as well; this covers the subscription
      // timing out while the run keeps streaming in the background — the
      // indicator then belongs to that turn, not to compaction.
      if (get().bySession[targetKey]?.compaction?.automatic === false) {
        patchSession(set, targetKey, { compaction: null });
      }
    },

    refreshSessionUsage: async (key?: string) => {
      const { active, openTabs } = get();
      const targetKey =
        key ??
        (active
          ? sessionKey(active.engine, active.sessionId, active.workspacePath)
          : "");
      if (!targetKey) return;
      // A background/closed tab must never fall back to the active session.
      const targetTab = openTabs.find(
        (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === targetKey,
      );
      const slashIdx = targetKey.indexOf("/");
      const engine = targetTab?.engine ?? targetKey.slice(0, slashIdx);
      const sessionId = targetTab?.sessionId ?? targetKey.slice(slashIdx + 1);
      if (targetKey.startsWith("new:") || slashIdx < 1 || !engine || !sessionId) return;
      const before = get().bySession[targetKey];
      if (!before) return;
      const snapshotTotal = (u: unknown) =>
        parseUsage((u as Record<string, unknown> | null)?.context_usage)?.total ??
        parseUsage(u)?.total ??
        null;
      const beforeTotal = snapshotTotal(before.usage);

      try {
        // The engine flushes a turn's final usage into the transcript file a
        // moment after the settle event fires, so a read that still shows the
        // pre-turn snapshot is retried briefly instead of leaving the meter
        // stale. A read that resolves *behind* a newer live report is dropped
        // outright — live data wins and the file catches up on a later
        // refresh; patching it back would resurrect the stale totals and drop
        // the live context window.
        //
        // "Newer" is decided by object identity, not by comparing totals: a
        // claude result line carries the turn's *summed* billing (every
        // request of the turn added up), so the settled value is always
        // larger than the file's occupancy snapshot. A magnitude test would
        // therefore read every claude re-read as stale and leave the meter
        // parked on the sum, far past the window it is measured against.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const page = await loadHistoryPage(
            engine,
            sessionId,
            targetTab?.workspacePath ?? "",
            100,
          );
          const latestUsage = latestMessageUsage(page.messages);
          if (!latestUsage) return;
          const current = get().bySession[targetKey]?.usage;
          // A report that landed while this read was in flight replaced the
          // usage object; anything else left it untouched (patches spread the
          // session and pass `usage` through by reference).
          if (current !== before.usage) return;
          const latestTotal = snapshotTotal(latestUsage);
          if (beforeTotal !== null && latestTotal === beforeTotal && attempt < 2) {
            const wait = Promise.withResolvers<void>();
            setTimeout(wait.resolve, 300);
            await wait.promise;
            continue;
          }
          // The transcript carries the API's per-message usage and no window;
          // only the live result line reports one. Keep the window already
          // known for this session so the gauge holds its scale.
          patchSession(set, targetKey, {
            usage: mergeUsage(latestUsage, current),
          });
          return;
        }
      } catch (error) {
        console.error("Failed to refresh session usage:", error);
      }
    },
  }, ["send", "respondToGrant", "respondToPlanReview", "respondToQuestion", "resumePlanReview",
    "resendLastUser", "queueMessage", "sendWhileBusy", "removeQueued", "moveQueued", "clearQueue", "sendQueuedNow", "interrupt", "compactContext"]);
}
