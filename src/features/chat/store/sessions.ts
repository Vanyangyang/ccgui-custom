import { normalizeOmpServiceTier } from "@/lib/omp-service-tier";
import {
  ipc,
  type EngineInfo,
  type SessionMeta,
  type Workspace,
} from "@/lib/ipc";
import type { EffortLevel } from "@/components/application/ai-chat/cli-menu";
import { encodedModelEffort } from "@/components/application/ai-chat/model-effort";
import { listenEngineEvents, listenSessionsChanged, listenComputerUseEscape } from "@/lib/events";
import { errorText } from "@/lib/errors";
import { writeStored } from "@/lib/storage";
import { hasRestoredChatCheckpoint } from "./runtime-checkpoint";
import {
  CLI_CONFIG_CHANGED_EVENT,
  engineCurrents,
} from "@/features/settings/providers";
import {
  ENGINE_PREF_KEY,
  persistTabs,
  readPersistedActive,
  readPersistedTabs,
  sameTab,
  sessionKey,
  type ActiveSession,
} from "./persistence";
import { EMPTY_SESSION, patchSession } from "./stream";
import { claudeUltracodeWriteVersion, pendingClaudeUltracode, snapshotPendingClaudeUltracode } from "./claude-ultracode";
import { handleEngineEvents, upsertSessionMetaInto } from "./engine-events";
import { needsLeaderHistory, leaderHistoryLoaded, isReclaimedLeaderSession } from "@/features/leader/event-state";
import { mergePlanReviewHistory } from "./plan-review";
import i18n from "@/lib/i18n";
import {
  listExternalSessionMetas,
  setSessionSourcesChangedCallback,
} from "@/features/plugins/runtime/session-source";
import { emitSessionActivated } from "@/features/plugins/runtime/events";
import {
  mergeExternalSessions,
  preserveUnscannedSessions,
  visibleSessions,
} from "./session-utils";
import type { ChatStore } from "./types";
import type { LoadHistoryPage, StoreGet, StoreSet, StoreSubscribe } from "./context";
import { hasReadableUsage, latestMessageUsage, mergeUsage } from "../usage";

function omitKey(rec: Record<string, boolean>, key: string) {
  const next = { ...rec };
  delete next[key];
  return next;
}

function archivedKeyMap(sessions: SessionMeta[]): Record<string, true> {
  return Object.fromEntries(
    sessions.map((session) => [
      sessionKey(session.engine, session.sessionId, session.workspacePath),
      true as const,
    ]),
  );
}

function withoutArchived(
  sessions: SessionMeta[],
  archived: Record<string, true>,
): SessionMeta[] {
  return sessions.filter(
    (session) =>
      !archived[sessionKey(session.engine, session.sessionId, session.workspacePath)] && !isReclaimedLeaderSession(sessionKey(session.engine, session.sessionId, session.workspacePath)),
  );
}

/**
 * Session lifecycle: init/refresh of the session/engine catalogs, history
 * paging, and sidebar session ops (archive/delete/pin/rename).
 */

export interface SessionDeps {
  set: StoreSet;
  get: StoreGet;
  loadHistoryPage: LoadHistoryPage;
  subscribe?: StoreSubscribe;
  nativeProcessRunning?: (sessionId: string) => Promise<boolean>;
  subscribeProcessRetired?: (callback: () => void) => Promise<() => void>;
  /** Module-scope unlisteners (store.ts) init pushes into; HMR dispose runs them. */
  eventTeardowns: Array<() => void>;
  activateTab: (tab: ActiveSession | null) => void;
  removeTab: (
    engine: string,
    sessionId: string | null,
    workspacePath: string,
  ) => void;
  forgetClosedTab: (key: string) => void;
  drainQueue: (key: string) => void;
  /** Optional: hosts that never run a live Claude CLI (tests) can omit it. */
  drainQueueLive?: (key: string) => void;
  markUnseenIfBackground: (key: string) => void;
}

export function createSessionActions(
  deps: SessionDeps,
): Pick<
  ChatStore,
  | "init"
  | "refreshSessions"
  | "refreshEngines"
  | "selectSession"
  | "loadEarlier"
  | "archiveSession"
  | "restoreSession"
  | "deleteSession"
  | "pinSession"
  | "renameSession"
> {
  const {
    set,
    get,
    loadHistoryPage,
    eventTeardowns,
    activateTab,
    removeTab,
    forgetClosedTab,
    drainQueue,
    drainQueueLive,
    markUnseenIfBackground,
  } = deps;

  // Foreground selection and host background preparation share one history
  // load. A second caller must never replay history over a newly started turn.
  const historyLoads = new Map<string, Promise<void>>();
  const loadedHistory = new Set<string>();
  interface RefreshNeeded {
    engine: string; sessionId: string; workspacePath: string;
    failed: boolean; preserveUsage: boolean; error?: string; nativeBusy?: boolean;
  }
  const refreshNeeded = new Map<string, RefreshNeeded>();
  const activeReadOffs = new Set<() => void>();
  let refreshOff: (() => void) | undefined;
  let refreshScheduled = false;
  let disposed = false;
  let retirementGeneration = 0;
  let retirementReady: Promise<void> | undefined;
  let retirementOff: (() => void) | undefined;
  function observeRetirement() {
    if (!retirementReady && deps.subscribeProcessRetired) {
      retirementReady = deps.subscribeProcessRetired(() => {
        if (disposed) return;
        retirementGeneration++;
        for (const target of refreshNeeded.values()) target.nativeBusy = false;
        scheduleRefresh();
      }).then((off) => { if (disposed) off(); else retirementOff = off; }).catch((error) => {
        // A transient event-transport failure must not poison explicit retries.
        retirementReady = undefined;
        throw error;
      });
    }
    return retirementReady;
  }
  const isOpen = (target: RefreshNeeded) => get().openTabs.some((t) => sameTab(t, target.engine, target.sessionId, target.workspacePath));
  const isStable = (key: string) => {
    const session = get().bySession[key];
    const refresh = refreshNeeded.get(key);
    // Failed optimistic prompts may never have reached the native file.
    // Keep them available to resend; only our own history-read error is retryable here.
    return session && !session.loading && !session.streaming && !session.queue.length &&
      (!session.error || session.error === refresh?.error) && !session.messages.some((m) =>
      m.question?.status === "pending" || m.grant?.status === "pending" ||
      ["awaiting_review", "deferred", "submitting"].includes(m.planReview?.status ?? ""));
  };

  // Observe only outstanding open refreshes. Closed stale timelines retain
  // their marker so reopening cannot mistake their live rows for full history.
  function watchRefreshes() {
    let watch = false;
    for (const [key, target] of refreshNeeded) {
      if (get().archivedSessionKeys[key] || !get().bySession[key]) {
        refreshNeeded.delete(key);
        loadedHistory.delete(key);
      } else if (!target.failed && isOpen(target)) watch = true;
    }
    if (!watch || disposed) { refreshOff?.(); refreshOff = undefined; return; }
    if (!refreshOff && deps.subscribe) refreshOff = deps.subscribe(() => { watchRefreshes(); scheduleRefresh(); });
  }
  function scheduleRefresh() {
    if (disposed || refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(() => {
      refreshScheduled = false;
      if (disposed) return;
      watchRefreshes();
      for (const [key, target] of refreshNeeded) {
        if (!target.failed && !target.nativeBusy && isOpen(target) && isStable(key) && !historyLoads.has(key)) {
          void loadSession(target.engine, target.sessionId, target.workspacePath).catch(() => {});
        }
      }
    });
  }
  eventTeardowns.push(() => {
    disposed = true; refreshOff?.(); refreshOff = undefined;
    retirementOff?.(); retirementOff = undefined;
    for (const off of [...activeReadOffs]) off();
  });

  function loadSession(engine: string, sessionId: string, workspacePath: string, explicit = false) {
    const key = sessionKey(engine, sessionId, workspacePath);
    const pending = historyLoads.get(key);
    if (pending) return pending;
    const existing = get().bySession[key];
    // Closed-tab cache eviction can happen after its observer was detached.
    // Reopening that key needs a fresh cold load rather than waiting on absent state.
    if (!existing) { refreshNeeded.delete(key); loadedHistory.delete(key); }
    const refresh = refreshNeeded.get(key);
    if (refresh && explicit) refresh.failed = false;
    if (refresh && (!isStable(key) || !isOpen(refresh))) {
      watchRefreshes();
      return Promise.resolve();
    }
    if (!refresh && existing && needsLeaderHistory(key) && existing.streaming) {
      refreshNeeded.set(key, { engine, sessionId, workspacePath, failed: false, preserveUsage: true });
      watchRefreshes();
      return Promise.resolve();
    }
    if (!refresh && existing && !needsLeaderHistory(key) && (existing.messages.length > 0 || existing.streaming || loadedHistory.has(key))) {
      if (!existing.streaming && existing.messages.length > 0 && !loadedHistory.has(key) && !hasReadableUsage(existing.usage)) {
        void get().refreshSessionUsage(key).catch(() => {});
      }
      return Promise.resolve();
    }
    // A deferred read observes an already live timeline. Keep it reachable
    // to normal sends; a new turn invalidates this read instead of blocking it.
    if (!refresh) patchSession(set, key, { loading: true });
    const originalMessages = get().bySession[key].messages;
    const originalUsage = get().bySession[key].usage;
    let sawActivity = false;
    let readOff: (() => void) | undefined;
    const stopReadObserver = () => { readOff?.(); readOff = undefined; activeReadOffs.delete(stopReadObserver); };
    if (deps.subscribe) {
      readOff = deps.subscribe(() => {
        const current = get().bySession[key];
        if (!current || current.messages !== originalMessages || current.streaming) sawActivity = true;
        if (!current || get().archivedSessionKeys[key] || !get().openTabs.some((t) => sameTab(t, engine, sessionId, workspacePath))) {
          sawActivity = true; stopReadObserver();
        }
      });
      activeReadOffs.add(stopReadObserver);
    }
    const plansPromise = ipc.listPlanReviews(engine, sessionId).catch(() => null);
    const load = (async () => {
      try {
        if (refresh && engine === "claude" && deps.nativeProcessRunning) {
          // Done may arrive before Claude flushes its transcript and exits.
          // Subscribe before probing so retirement during the await is not lost.
          await observeRetirement();
          while (!disposed) {
            const generation = retirementGeneration;
            const running = await deps.nativeProcessRunning(sessionId);
            if (generation !== retirementGeneration) continue;
            if (running) { refresh.nativeBusy = true; return; }
            refresh.nativeBusy = false;
            break;
          }
          if (disposed) return;
        }
        const page = await loadHistoryPage(engine, sessionId, workspacePath, 100);
        const plans = await plansPromise;
        if (disposed) return;
        const current = get().bySession[key];
        if (!current || get().archivedSessionKeys[key]) throw new Error("Session became unavailable during history load");
        const interactive = current.messages.some((m) => m.question?.status === "pending" || m.grant?.status === "pending" ||
          ["awaiting_review", "deferred", "submitting"].includes(m.planReview?.status ?? ""));
        const failedPrompt = !!current.error && current.error !== refresh?.error;
        if (!sawActivity && (!refresh || isOpen(refresh)) && current.messages === originalMessages && !current.streaming && !current.queue.length && !interactive && !failedPrompt) {
          const messages = plans?.length ? mergePlanReviewHistory(page.messages, plans) ?? page.messages : page.messages;
          const preserveUsage = refresh?.preserveUsage || current.usage !== originalUsage;
          const pageUsage = latestMessageUsage(page.messages);
          refreshNeeded.delete(key);
          loadedHistory.add(key);
          leaderHistoryLoaded(key);
          patchSession(set, key, {
            messages, subagentHistory: page.subagentHistory,
            nextBefore: page.nextBefore, loading: false,
            usage: preserveUsage && current.usage != null ? mergeUsage(current.usage, pageUsage) : pageUsage,
            error: refresh?.error === current.error ? null : current.error,
          });
        } else {
          // Never infer overlap from seq values. Keep live row/approval
          // identities and re-read the latest authoritative native page later.
          refreshNeeded.set(key, { engine, sessionId, workspacePath, failed: false, preserveUsage: true, error: refresh?.error });
          loadedHistory.delete(key);
          patchSession(set, key, { loading: false, subagentHistory: page.subagentHistory, nextBefore: page.nextBefore });
        }
        watchRefreshes();
      } catch (error) {
        if (disposed) throw error;
        refreshNeeded.set(key, { engine, sessionId, workspacePath, failed: true, preserveUsage: !!refresh?.preserveUsage || get().bySession[key]?.usage !== originalUsage, error: String(error) });
        loadedHistory.delete(key);
        watchRefreshes();
        if (get().bySession[key] && !get().archivedSessionKeys[key]) {
          patchSession(set, key, { loading: false, error: String(error) });
        }
        throw error;
      }
    })();
    historyLoads.set(key, load);
    void load.finally(() => {
      stopReadObserver();
      if (historyLoads.get(key) === load) historyLoads.delete(key);
      watchRefreshes();
      scheduleRefresh();
    }).catch(() => {});
    return load;
  }

  /** Migrate the engine pref off a CLI that is gone or disabled in
   * settings. All CLIs disabled: leave the pref alone — the composer shows
   * the "no CLI enabled" placeholder instead of a misleading fallback. */
  function ensureUsableEngine(engines: EngineInfo[]) {
    const usable = engines.filter((e) => e.enabled);
    if (usable.length === 0 || usable.some((e) => e.id === get().activeEngine))
      return;
    get().setActiveEngine(usable.find((e) => e.available)?.id ?? usable[0].id);
  }

  let initialization: Promise<void> | undefined;
  return {
    init: () => initialization ??= (async () => {
      if (get().initialized) return;
      const restoring = hasRestoredChatCheckpoint(get);
      set({ initialized: true });
      let cancelled = false;
      const installed: Array<() => void> = [];
      const subscribe = async (setup: Promise<() => void>) => {
        const off = await setup;
        if (cancelled || disposed) off();
        else { installed.push(off); eventTeardowns.push(off); }
      };
      try {
        await Promise.all([
          subscribe(listenEngineEvents((events) =>
            handleEngineEvents(events, {
              set,
              get,
              drainQueue,
              drainQueueLive,
              markUnseenIfBackground,
              upsertSessionMeta: (meta) => upsertSessionMetaInto(set, meta),
              refreshSessionUsage: (k) => get().refreshSessionUsage(k),
            }),
          )),
          subscribe(listenSessionsChanged(() => void get().refreshSessions())),
        // Global Esc during a computer-use run: the backend arms that hotkey
        // only while a run is active, so this fires exactly when the user
        // needs the escape hatch out of a machine-driving turn.
          subscribe(listenComputerUseEscape(() => void get().interrupt())),
        ]);
      } catch (error) {
        cancelled = true;
        for (const off of installed) off();
        throw error;
      }
      if (disposed) throw new Error("Chat store was disposed during event subscription");
      // Settings' CLI enable switch / channel edits: re-filter history and
      // picker options without a restart.
      const onCliConfigChanged = () => void get().refreshEngines();
      window.addEventListener(CLI_CONFIG_CHANGED_EVENT, onCliConfigChanged);
      eventTeardowns.push(() =>
        window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, onCliConfigChanged),
      );
      const [workspaces, sessions, archivedSessions, engines] = await Promise.all([
        ipc.listWorkspaces().catch(() => restoring ? get().workspaces : [] as Workspace[]),
        ipc.listSessions().catch(() => restoring ? get().sessions : [] as SessionMeta[]),
        ipc.listArchivedSessions().catch(() => [] as SessionMeta[]),
        ipc.listEngines().catch(() => restoring ? get().engines : [] as EngineInfo[]),
      ]);
      // Plugin session sources (remote/容器内 CLI) merge under the local
      // scan so WSL 等远端会话进侧栏,且重启时已开标签不至于因“会话表无
      // 此会话”被清掉。
      setSessionSourcesChangedCallback(() => void get().refreshSessions());
      const external = await listExternalSessionMetas();
      const archivedSessionKeys = archivedKeyMap(archivedSessions);
      const allSessions = withoutArchived(
        mergeExternalSessions(sessions, external, workspaces.map((w) => w.path)),
        archivedSessionKeys,
      );
      set({
        workspaces,
        sessions: visibleSessions(restoring ? preserveUnscannedSessions(allSessions, get().sessions, get().bySession) : allSessions, engines),
        archivedSessionKeys,
        engines,
      });
      if (!restoring) {
      ensureUsableEngine(engines);
      // Restore persisted tabs; drop ones whose workspace/session is gone.
      const restoredTabs = readPersistedTabs().filter(
        (t) =>
          workspaces.some((w) => w.path === t.workspacePath) &&
          (t.sessionId === null ||
            allSessions.some(
              (s) => s.engine === t.engine && s.sessionId === t.sessionId,
            )),
      );
      set({ openTabs: restoredTabs });
      const persistedActive = readPersistedActive();
      const activeTab =
        persistedActive &&
        restoredTabs.some((t) =>
          sameTab(
            t,
            persistedActive.engine,
            persistedActive.sessionId,
            persistedActive.workspacePath,
          ),
        )
          ? persistedActive
          : (restoredTabs[0] ?? null);
      if (activeTab) activateTab(activeTab);
      }
      const ultracodeVersion = claudeUltracodeWriteVersion();
      const pendingUltracodeDefault = pendingClaudeUltracode();
      ipc
        .getAppSettings()
        .then((settings) =>
          set({
            efforts: (settings.defaultEfforts ?? {}) as Record<
              string,
              EffortLevel
            >,
            defaultClaudeUltracode: pendingClaudeUltracode() ?? (claudeUltracodeWriteVersion() === ultracodeVersion ? pendingUltracodeDefault ?? settings.defaultClaudeUltracode ?? false : get().defaultClaudeUltracode),
            ompServiceTier: normalizeOmpServiceTier(
              settings.ompOpenaiServiceTier,
            ),
            codexServiceTier: normalizeOmpServiceTier(
              settings.codexServiceTier,
            ),
            models: settings.defaultModels ?? {},
            threadLimit: settings.sidebarThreadLimit ?? 5,
            workspaceGroups: settings.workspaceGroups ?? [],
            workspaceAliases: settings.workspaceAliases ?? {},
            archivedWorkspaces: settings.archivedWorkspaces ?? [],
            sendShortcut: settings.composerSendShortcut ?? "enter",
            thinkingAutoCollapse: settings.thinkingAutoCollapse ?? true,
          }),
        )
        .catch(() => {});
      ipc
        .getCliConfig?.()
        ?.then((config) => set({ providers: engineCurrents(config) }))
        .catch(() => {});
    })().catch((error) => {
      initialization = undefined;
      set({ initialized: false });
      throw error;
    }),

    refreshSessions: async () => {
      const ultracodeVersion = claudeUltracodeWriteVersion();
      const pendingUltracode = snapshotPendingClaudeUltracode();
      const [sessions, external, archivedSessions] = await Promise.all([
        ipc.listSessions().catch(() => null),
        listExternalSessionMetas(),
        ipc.listArchivedSessions().catch(() => null),
      ]);
      if (!sessions || !archivedSessions) return;
      const archivedSessionKeys = archivedKeyMap(archivedSessions);
      const merged = withoutArchived(
        mergeExternalSessions(sessions, external, get().workspaces.map((w) => w.path)),
        archivedSessionKeys,
      );
      set((s) => {
        // Reconcile the metadata cache too: after a closed tab is evicted,
        // selectSession restores its choice from this list, not bySession.
        const ultracodeChanged = claudeUltracodeWriteVersion() !== ultracodeVersion;
        const refreshed = merged.map((meta) => {
          if (meta.engine !== "claude") return meta;
          const current = s.bySession[sessionKey(meta.engine, meta.sessionId, meta.workspacePath)];
          const claudeUltracode = pendingClaudeUltracode(meta.sessionId) ??
            (ultracodeChanged
              ? current?.claudeUltracode ?? pendingUltracode.get(meta.sessionId) ?? meta.claudeUltracode
              : pendingUltracode.get(meta.sessionId) ?? meta.claudeUltracode ?? current?.claudeUltracode);
          return claudeUltracode == null || claudeUltracode === meta.claudeUltracode
            ? meta
            : { ...meta, claudeUltracode };
        });
        const visible = visibleSessions(
          withoutArchived(
            preserveUnscannedSessions(refreshed, s.sessions, s.bySession),
            archivedSessionKeys,
          ),
          s.engines,
        );
        const bySession = { ...s.bySession };
        const drafts = { ...s.drafts };
        const unseen = { ...s.unseen };
        const streamingByKey = { ...s.streamingByKey };
        const retryingByKey = { ...s.retryingByKey };
        for (const key of Object.keys(archivedSessionKeys)) {
          delete bySession[key];
          delete drafts[key];
          delete unseen[key];
          delete streamingByKey[key];
          delete retryingByKey[key];
        }
        for (const meta of refreshed) {
          const key = sessionKey(meta.engine, meta.sessionId, meta.workspacePath);
          const current = bySession[key];
          if (!current) continue;
          const activeModel = meta.model ?? current.activeModel;
          const activeEffort =
            activeModel && encodedModelEffort(meta.engine, activeModel)
              ? null
              : (meta.effort ?? current.activeEffort);
          bySession[key] = {
            ...current,
            activeModel,
            activeEffort,
            ...(meta.engine === "claude" ? {
              claudeUltracode: meta.claudeUltracode ?? current.claudeUltracode,
            } : {}),
            activeProvider: meta.provider ?? current.activeProvider,
          };
        }
        const openTabs = s.openTabs.filter(
          (tab) =>
            tab.sessionId === null ||
            !archivedSessionKeys[sessionKey(tab.engine, tab.sessionId, tab.workspacePath)],
        );
        const active =
          s.active?.sessionId &&
          archivedSessionKeys[
            sessionKey(s.active.engine, s.active.sessionId, s.active.workspacePath)
          ]
            ? (openTabs[0] ?? null)
            : s.active;
        persistTabs(openTabs, active);
        return {
          sessions: visible,
          archivedSessionKeys,
          bySession,
          drafts,
          unseen,
          streamingByKey,
          retryingByKey,
          openTabs,
          active,
        };
      });
    },

    refreshEngines: async () => {
      const [engines, sessions, external, archivedSessions, config] = await Promise.all([
        ipc.listEngines().catch(() => null),
        ipc.listSessions().catch(() => null),
        listExternalSessionMetas(),
        ipc.listArchivedSessions().catch(() => null),
        ipc.getCliConfig?.().catch(() => null) ?? Promise.resolve(null),
      ]);
      if (!engines) return;
      set((s) => {
        const keys = archivedSessions
          ? archivedKeyMap(archivedSessions)
          : s.archivedSessionKeys;
        return {
          engines,
          archivedSessionKeys: keys,
          ...(sessions
            ? {
                sessions: visibleSessions(
                  withoutArchived(
                    preserveUnscannedSessions(
                      mergeExternalSessions(
                        sessions,
                        external,
                        s.workspaces.map((w) => w.path),
                      ),
                      s.sessions,
                      s.bySession,
                    ),
                    keys,
                  ),
                  engines,
                ),
              }
            : {}),
          ...(config ? { providers: engineCurrents(config) } : {}),
        };
      });
      ensureUsableEngine(engines);
    },

    selectSession: async (engine, sessionId, workspacePath, options) => {
      const key = sessionKey(engine, sessionId, workspacePath);
      if (isReclaimedLeaderSession(key)) return;
      // Metadata patches below recreate an empty cache entry. Retire proof
      // from an evicted cache lifetime before those patches can hide eviction.
      if (!get().bySession[key]) {
        loadedHistory.delete(key);
        refreshNeeded.delete(key);
      }
      const meta = options?.meta ?? get().sessions.find(
        (x) => x.engine === engine && x.sessionId === sessionId && x.workspacePath === workspacePath,
      );
      // The session remembers the model it ran, and our own record is the
      // only place that carries the provider ("agentrouter qunyou/x", while
      // the engine transcript keeps the bare "x"). Without it a session
      // reopened here — after a restart, or in another window — showed the
      // engine default and sent that instead.
      const remembered = meta?.model;
      if (remembered && !get().bySession[key]?.activeModel) {
        patchSession(set, key, { activeModel: remembered });
      }
      // Same for the reasoning level: the picker and the next send follow the
      // session, so an unset level adopts the one this session last ran.
      const effectiveModel = get().bySession[key]?.activeModel ?? remembered;
      const modelEncodesEffort = Boolean(effectiveModel && encodedModelEffort(engine, effectiveModel));
      const rememberedEffort = modelEncodesEffort ? undefined : meta?.effort;
      if (modelEncodesEffort && get().bySession[key]?.activeEffort) {
        patchSession(set, key, { activeEffort: null });
      } else if (rememberedEffort && !get().bySession[key]?.activeEffort) {
        patchSession(set, key, { activeEffort: rememberedEffort });
      }
      const rememberedProvider = meta?.provider;
      const rememberedUltracode = pendingClaudeUltracode(sessionId) ?? meta?.claudeUltracode;
      if (engine === "claude" && rememberedUltracode != null && get().bySession[key]?.claudeUltracode === undefined) {
        patchSession(set, key, { claudeUltracode: rememberedUltracode });
      }
      if (rememberedProvider && !get().bySession[key]?.activeProvider) {
        patchSession(set, key, { activeProvider: rememberedProvider });
      }
      const background = options?.background === true;
      const syncEngine = !background && engine !== get().activeEngine;
      if (syncEngine) writeStored(ENGINE_PREF_KEY, engine);
      set((s) => {
        // Native sessions read effort from SessionState/database. Strip the
        // legacy per-tab field so an old localStorage value cannot shadow it.
        const stored = s.openTabs.find((t) =>
          sameTab(t, engine, sessionId, workspacePath),
        );
        const tab: ActiveSession = stored
          ? { ...stored, effort: undefined, provider: undefined, claudeUltracode: undefined }
          : { engine, sessionId, workspacePath };
        const openTabs = stored
          ? s.openTabs.map((t) => (t === stored ? tab : t))
          : [...s.openTabs, tab];
        persistTabs(openTabs, background ? s.active : tab);
        const unseen = !background && key in s.unseen ? omitKey(s.unseen, key) : s.unseen;
        return background ? { openTabs } : { openTabs, active: tab, unseen, activeEngine: engine };
      });
      if (!background) emitSessionActivated(engine, sessionId);
      try {
        await loadSession(engine, sessionId, workspacePath, true);
      } catch (error) {
        if (background) throw error;
      }
    },

    loadEarlier: async (key) => {
      const { active, bySession, openTabs } = get();
      // 分屏里每格各自向上加载历史：不带 key 时仍按激活会话。
      const targetKey =
        key ??
        (active
          ? sessionKey(active.engine, active.sessionId, active.workspacePath)
          : "");
      if (!targetKey) return;
      const tab = openTabs.find(
        (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === targetKey,
      );
      if (!tab?.sessionId) return;
      if (refreshNeeded.has(targetKey)) {
        try { await loadSession(tab.engine, tab.sessionId, tab.workspacePath, true); } catch { /* Banner already carries the failure. */ }
        return;
      }
      const state = bySession[targetKey];
      if (!state?.nextBefore || state.loading) return;
      patchSession(set, targetKey, { loading: true });
      try {
        const page = await loadHistoryPage(
          tab.engine,
          tab.sessionId,
          tab.workspacePath,
          100,
          state.nextBefore,
        );
        patchSession(set, targetKey, {
          messages: [
            ...page.messages,
            ...(get().bySession[targetKey] ?? EMPTY_SESSION).messages,
          ],
          nextBefore: page.nextBefore,
          subagentHistory: page.subagentHistory,
          loading: false,
        });
      } catch {
        patchSession(set, targetKey, { loading: false });
      }
    },

    archiveSession: async (session) => {
      const { engine, sessionId, workspacePath } = session;
      const key = sessionKey(engine, sessionId, workspacePath);
      if (get().streamingByKey[key]) {
        set({ actionError: i18n.t("chat.archiveRunning") });
        return;
      }
      try {
        await ipc.archiveSession(session);
      } catch (error) {
        set({ actionError: errorText(error) });
        return;
      }
      set((s) => {
        const bySession = { ...s.bySession };
        delete bySession[key];
        return {
          sessions: s.sessions.filter(
            (item) => !(item.engine === engine && item.sessionId === sessionId),
          ),
          archivedSessionKeys: { ...s.archivedSessionKeys, [key]: true },
          bySession,
          unseen: omitKey(s.unseen, key),
          actionError: null,
        };
      });
      forgetClosedTab(key);
      const tab = get().openTabs.find(
        (item) => item.engine === engine && item.sessionId === sessionId,
      );
      if (tab) removeTab(engine, sessionId, tab.workspacePath);
    },

    restoreSession: async (session) => {
      const { engine, sessionId, workspacePath } = session;
      const key = sessionKey(engine, sessionId, workspacePath);
      try {
        await ipc.restoreSession(engine, sessionId);
      } catch (error) {
        set({ actionError: errorText(error) });
        return;
      }
      set((s) => {
        const exists = s.sessions.some(
          (item) => item.engine === engine && item.sessionId === sessionId,
        );
        const archivedSessionKeys = { ...s.archivedSessionKeys };
        delete archivedSessionKeys[key];
        return {
          sessions: exists ? s.sessions : [session, ...s.sessions],
          archivedSessionKeys,
          actionError: null,
        };
      });
    },

    deleteSession: async (engine, sessionId) => {
      // 远程(插件会话源,如 WSL 发行版内 CLI)会话没有本地 db 行,本地
      // delete_session 只会 "session not found";走远程通道删 remotePath。
      const meta = get().sessions.find(
        (x) => x.engine === engine && x.sessionId === sessionId,
      );
      try {
        if (meta?.remote && meta.remotePath) {
          await ipc.deleteRemoteSession(meta.workspacePath, engine, meta.remotePath);
        } else {
          await ipc.deleteSession(engine, sessionId);
        }
      } catch (error) {
        set({ actionError: errorText(error) });
        return;
      }
      set({ actionError: null });
      const key = sessionKey(engine, sessionId, "");
      const tab = get().openTabs.find(
        (t) => t.engine === engine && t.sessionId === sessionId,
      );
      set((s) => {
        // Permanent delete: the cached session state is dead weight.
        const bySession = { ...s.bySession };
        const drafts = { ...s.drafts };
        const streamingByKey = { ...s.streamingByKey };
        const retryingByKey = { ...s.retryingByKey };
        delete bySession[key];
        delete drafts[key];
        // Deleting a running session must clear its flat-map flags too:
        // nothing re-scans a deleted key later (archive is swept by
        // refreshSessions; a delete is gone for good).
        delete streamingByKey[key];
        delete retryingByKey[key];
        return {
          sessions: s.sessions.filter(
            (x) => !(x.engine === engine && x.sessionId === sessionId),
          ),
          bySession,
          drafts,
          streamingByKey,
          retryingByKey,
          unseen: omitKey(s.unseen, key),
        };
      });
      // The closed-tab reopen cache must not keep the dead key either.
      forgetClosedTab(key);
      if (tab) {
        // removeTab activates the neighboring tab when the deleted one was active.
        removeTab(engine, sessionId, tab.workspacePath);
      } else {
        set((s) => ({
          active:
            s.active?.sessionId === sessionId && s.active.engine === engine
              ? null
              : s.active,
        }));
      }
    },

    pinSession: async (engine, sessionId, pinned) => {
      try {
        await ipc.pinSession(engine, sessionId, pinned);
        await get().refreshSessions();
        set({ actionError: null });
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },

    renameSession: async (engine, sessionId, title) => {
      try {
        await ipc.renameSession(engine, sessionId, title);
        await get().refreshSessions();
        set({ actionError: null });
      } catch (error) {
        set({ actionError: errorText(error) });
      }
    },
  };
}
