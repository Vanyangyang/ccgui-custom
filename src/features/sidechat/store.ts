import { create } from "zustand";
import { ipc, type Message } from "@/lib/ipc";
import type { EngineEventPayload, TurnCompletePayload } from "@/lib/events";
import { errorText } from "@/lib/errors";
import i18n from "@/lib/i18n";
import type { ComposerPermission } from "@/components/application/ai-chat/permission-menu";
import { parseUsage, type ParsedUsage } from "@/features/chat/usage";

import { initialSideRunProgress, reduceSideRunProgress, type SideRunProgress } from "./progress";
export type { SideRunProgress } from "./progress";

type SideEvent = Omit<EngineEventPayload, "kind"> & { kind: string };

export const SUPPORTED_SIDECHAT_ENGINES = [
  "claude",
  "codex",
  "agy",
  "cursor",
] as const;

export type SupportedSidechatEngine = (typeof SUPPORTED_SIDECHAT_ENGINES)[number];

export function isSidechatSupportedEngine(
  engine: string | null | undefined,
): engine is SupportedSidechatEngine {
  return (
    typeof engine === "string" &&
    (SUPPORTED_SIDECHAT_ENGINES as readonly string[]).includes(engine)
  );
}

export function isSideRunId(runId: string | null | undefined): boolean {
  return (
    typeof runId === "string" &&
    (runId.startsWith("btw-") || runId.startsWith("sidechat-"))
  );
}

export function isSideRunEvent(
  event: Pick<EngineEventPayload, "runId">,
): boolean {
  return isSideRunId(event.runId);
}

export interface SideToolItem {
  id: string;
  name: string;
  path?: string | null;
  status: "running" | "done";
}

export interface BtwState {
  runId: string;
  sideSessionId: string | null;
  engine: string;
  workspacePath: string;
  parentSessionId: string | null;
  question: string;
  images?: string[];
  answer: string;
  thinking: string;
  tools: SideToolItem[];
  streaming: boolean;
  progress?: SideRunProgress;
  error: string | null;
  usage: ParsedUsage | null;
  startedAt: number;
  durationMs: number | null;
  answerCommitted?: number;
  thinkingCommitted?: number;
}

export type SidechatMode = "read-only" | "execute";

export interface SidechatState {
  open: boolean;
  /** Absent in older in-memory states means read-only. */
  mode?: SidechatMode;
  engine: string;
  workspacePath: string;
  parentSessionId: string | null;
  sideSessionId: string | null;
  runId: string | null;
  streaming: boolean;
  progress?: SideRunProgress;
  draft: string;
  draftImages?: string[];
  messages: Message[];
  error: string | null;
  usage: ParsedUsage | null;
  startedAt: number | null;
  /** Local Q&A imported after the native branch was last advanced. */
  pendingContext?: string;
}

interface SideRunTarget {
  kind: "btw" | "sidechat";
  sessionKey: string;
  lastSeq?: number;
}

const sideRunRouting = new Map<string, SideRunTarget>();
const sideOperations = new Set<string>();

function showSideError(sessionKey: string, error: unknown): void {
  useSidechatStore.setState((s) => {
    const current = s.sidechatBySession[sessionKey];
    return current ? { sidechatBySession: { ...s.sidechatBySession, [sessionKey]: { ...current, error: errorText(error) } } } : s;
  });
}

function showBtwError(sessionKey: string, runId: string, error: unknown): void {
  useSidechatStore.setState((s) => {
    const current = s.btwBySession[sessionKey];
    return current?.runId === runId
      ? { btwBySession: { ...s.btwBySession, [sessionKey]: { ...current, error: errorText(error) } } }
      : s;
  });
}

const MAX_FALLBACK_TRANSCRIPT_CHARS = 24_000;

/**
 * Build a compact, bounded transcript of the parent conversation for the rare case
 * where the parent session has not yet been flushed to disk (e.g. a brand-new tab
 * whose first turn is still in flight). When a native session file exists on disk,
 * the backend forks the native session directly for best-effort cache reuse and
 * ignores this fallback.
 */
export function buildFallbackTranscript(messages: Message[]): string | null {
  if (!messages || messages.length === 0) return null;
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user" && msg.text.trim()) {
      lines.push(`User:\n${msg.text.trim()}`);
    } else if (msg.role === "assistant" && msg.text.trim()) {
      lines.push(`Assistant:\n${msg.text.trim()}`);
    } else if (msg.role === "tool" && msg.text.trim()) {
      const label = msg.path ? `${msg.text.trim()} (${msg.path})` : msg.text.trim();
      lines.push(`[Tool: ${label}]`);
    }
  }
  if (lines.length === 0) return null;
  const joined = lines.join("\n\n");
  if (joined.length <= MAX_FALLBACK_TRANSCRIPT_CHARS) {
    return joined;
  }
  return "...(earlier context omitted)...\n\n" + joined.slice(-MAX_FALLBACK_TRANSCRIPT_CHARS);
}

function nextSeq(messages: Message[]): number {
  return messages.length > 0 ? messages[messages.length - 1].seq + 1 : 1;
}

function appendOrUpdateLiveMessage(
  messages: Message[],
  role: "assistant" | "thinking",
  delta: string,
): Message[] {
  if (!delta) return messages;
  const last = messages[messages.length - 1];
  if (last && last.role === role && last.live) {
    const updated: Message = {
      ...last,
      text: last.text + delta,
    };
    return [...messages.slice(0, -1), updated];
  }
  // Also check if the second-to-last is a live row of this role while the last is a live thinking/assistant pair
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (!candidate.live || candidate.role === "tool") break;
    if (candidate.role === role) {
      const next = [...messages];
      next[i] = { ...candidate, text: candidate.text + delta };
      return next;
    }
  }
  return [
    ...messages,
    {
      seq: nextSeq(messages),
      role,
      text: delta,
      ts: new Date().toISOString(),
      live: true,
    },
  ];
}

function settleLiveMessages(messages: Message[], durationMs?: number | null): Message[] {
  let changed = false;
  const next = messages.map((m, idx) => {
    if (!m.live) return m;
    changed = true;
    const isLastAssistant =
      m.role === "assistant" &&
      !messages.slice(idx + 1).some((later) => later.role === "assistant");
    return {
      ...m,
      live: false,
      ...(isLastAssistant && durationMs != null ? { durationMs } : {}),
    };
  });
  return changed ? next : messages;
}

export interface SidechatStore {
  btwBySession: Record<string, BtwState>;
  sidechatBySession: Record<string, SidechatState>;

  askBtw: (args: {
    sessionKey: string;
    engine: string;
    workspacePath: string;
    parentSessionId: string | null;
    question: string;
    images?: string[];
    onAccepted?: () => void;
    parentMessages: Message[];
    model?: string | null;
    effort?: string | null;
    providerId?: string | null;
  }) => Promise<void>;

  stopBtw: (sessionKey: string) => Promise<void>;
  dismissBtw: (sessionKey: string) => void;
  continueBtwInSidechat: (sessionKey: string) => void;

  openSidechat: (args: {
    sessionKey: string;
    engine: string;
    workspacePath: string;
    parentSessionId: string | null;
    initialQuestion?: string;
    images?: string[];
    onAccepted?: () => void;
    parentMessages?: Message[];
    model?: string | null;
    effort?: string | null;
    providerId?: string | null;
    parentPermission?: ComposerPermission;
  }) => Promise<void>;

  toggleSidechat: (args: {
    sessionKey: string;
    engine: string;
    workspacePath: string;
    parentSessionId: string | null;
  }) => void;

  closeSidechat: (sessionKey: string) => void;
  resetSidechat: (sessionKey: string) => Promise<void>;
  discardSidechat: (sessionKey: string) => Promise<void>;
  setSidechatDraft: (sessionKey: string, draft: string) => void;
  setSidechatMode: (sessionKey: string, mode: SidechatMode) => void;
  updateSidechatImages: (sessionKey: string, updater: (paths: string[]) => string[]) => void;

  sendSidechatMessage: (args: {
    sessionKey: string;
    engine: string;
    workspacePath: string;
    parentSessionId: string | null;
    prompt: string;
    images?: string[];
    onAccepted?: () => void;
    parentMessages: Message[];
    model?: string | null;
    effort?: string | null;
    providerId?: string | null;
    parentPermission?: ComposerPermission;
  }) => Promise<void>;

  stopSidechat: (sessionKey: string) => Promise<void>;
  promoteSidechatToTab: (sessionKey: string) => Promise<{
    engine: string;
    sessionId: string;
    workspacePath: string;
  } | null>;
}

export const useSidechatStore = create<SidechatStore>((set, get) => ({
  btwBySession: {},
  sidechatBySession: {},

  askBtw: async ({
    sessionKey,
    engine,
    workspacePath,
    parentSessionId,
    question,
    images = [],
    onAccepted,
    parentMessages,
    model,
    effort,
    providerId,
  }) => {
    const trimmed = question.trim();
    if (!trimmed && images.length === 0) return;

    const prev = get().btwBySession[sessionKey];
    if (prev) {
      try {
        if (prev.streaming) await ipc.interruptSession(prev.runId);
        if (prev.sideSessionId) await ipc.cleanupSideSession(prev.engine, prev.sideSessionId, prev.workspacePath, prev.parentSessionId);
      } catch (error) {
        showBtwError(sessionKey, prev.runId, error);
        return;
      }
      sideRunRouting.delete(prev.runId);
    }

    const runId = `btw-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    sideRunRouting.set(runId, { kind: "btw", sessionKey });

    set((s) => ({
      btwBySession: {
        ...s.btwBySession,
        [sessionKey]: {
          runId,
          sideSessionId: null,
          engine,
          workspacePath,
          parentSessionId,
          question: trimmed,
          images,
          answer: "",
          thinking: "",
          tools: [],
          streaming: true,
          progress: initialSideRunProgress(),
          error: null,
          usage: null,
          startedAt,
          durationMs: null,
        },
      },
    }));

    try {
      const fallbackTranscript = buildFallbackTranscript(parentMessages);
      const res = await ipc.sendSideMessage({
        engine,
        workspacePath,
        parentSessionId,
        sideSessionId: null,
        prompt: trimmed,
        imagePaths: images,
        ephemeral: true,
        fallbackTranscript,
        model: model ?? null,
        effort: effort ?? null,
        providerId: providerId ?? null,
        runId,
      });
      onAccepted?.();
      const resultKey = sideRunRouting.get(runId)?.sessionKey ?? sessionKey;
      if (res?.sessionId) {
        set((s) => {
          const cur = s.btwBySession[resultKey];
          if (!cur || cur.runId !== runId) return s;
          return {
            btwBySession: {
              ...s.btwBySession,
              [resultKey]: { ...cur, sideSessionId: res.sessionId },
            },
          };
        });
      }
    } catch (err) {
      const resultKey = sideRunRouting.get(runId)?.sessionKey ?? sessionKey;
      sideRunRouting.delete(runId);
      set((s) => {
        const cur = s.btwBySession[resultKey];
        if (!cur || cur.runId !== runId) return s;
        return {
          btwBySession: {
            ...s.btwBySession,
            [resultKey]: {
              ...cur,
              streaming: false,
              error: errorText(err),
              durationMs: Date.now() - cur.startedAt,
            },
          },
        };
      });
    }
  },

  stopBtw: async (sessionKey) => {
    const cur = get().btwBySession[sessionKey];
    if (!cur) return;
    try {
      await ipc.interruptSession(cur.runId);
    } catch (error) {
      showBtwError(sessionKey, cur.runId, error);
      return;
    }
    sideRunRouting.delete(cur.runId);
    set((s) => {
      const existing = s.btwBySession[sessionKey];
      if (!existing || existing.runId !== cur.runId) return s;
      return {
        btwBySession: {
          ...s.btwBySession,
          [sessionKey]: {
            ...existing,
            streaming: false,
            durationMs: existing.durationMs ?? Date.now() - existing.startedAt,
          },
        },
      };
    });
  },

  dismissBtw: (sessionKey) => {
    const cur = get().btwBySession[sessionKey];
    if (!cur) return;
    void (async () => {
      try {
        if (cur.streaming) await ipc.interruptSession(cur.runId);
        if (cur.sideSessionId) await ipc.cleanupSideSession(cur.engine, cur.sideSessionId, cur.workspacePath, cur.parentSessionId);
        sideRunRouting.delete(cur.runId);
        set((s) => {
          if (s.btwBySession[sessionKey]?.runId !== cur.runId) return s;
          const next = { ...s.btwBySession };
          delete next[sessionKey];
          return { btwBySession: next };
        });
      } catch (error) {
        set((s) => {
          const current = s.btwBySession[sessionKey];
          return current?.runId === cur.runId ? { btwBySession: { ...s.btwBySession, [sessionKey]: { ...current, error: errorText(error) } } } : s;
        });
      }
    })();
  },

  continueBtwInSidechat: (sessionKey) => {
    const btw = get().btwBySession[sessionKey];
    if (!btw || btw.streaming || get().sidechatBySession[sessionKey]?.streaming) return;
    const nowIso = new Date().toISOString();
    const seedMessages: Message[] = [
      {
        seq: 1,
        role: "user",
        text: btw.question,
        images: btw.images,
        ts: nowIso,
      },
    ];
    if (btw.thinking.trim()) {
      seedMessages.push({
        seq: nextSeq(seedMessages),
        role: "thinking",
        text: btw.thinking,
        ts: nowIso,
        live: false,
      });
    }
    if (btw.answer.trim()) {
      seedMessages.push({
        seq: nextSeq(seedMessages),
        role: "assistant",
        text: btw.answer,
        ts: nowIso,
        live: false,
        durationMs: btw.durationMs,
      });
    }

    set((s) => {
      const existingSc = s.sidechatBySession[sessionKey];
      const baseMessages = existingSc?.messages ?? [];
      const offset = baseMessages.length > 0 ? baseMessages[baseMessages.length - 1].seq : 0;
      const appended = seedMessages.map((m, idx) => ({ ...m, seq: offset + idx + 1 }));
      const nextBtw = { ...s.btwBySession };
      delete nextBtw[sessionKey];
      return {
        btwBySession: nextBtw,
        sidechatBySession: {
          ...s.sidechatBySession,
          [sessionKey]: {
            open: true,
            engine: btw.engine,
            mode: existingSc?.mode ?? "read-only",
            workspacePath: btw.workspacePath,
            parentSessionId: existingSc ? existingSc.parentSessionId : btw.parentSessionId,
            sideSessionId: existingSc?.sideSessionId ?? null,
            runId: existingSc?.runId ?? null,
            streaming: existingSc?.streaming ?? false,
            draft: existingSc?.draft ?? "",
            draftImages: existingSc?.draftImages,
            messages: [...baseMessages, ...appended],
            error: null,
            usage: btw.usage ?? existingSc?.usage ?? null,
            startedAt: existingSc?.startedAt ?? null,
            pendingContext: existingSc?.sideSessionId
              ? [existingSc.pendingContext, buildFallbackTranscript(seedMessages)].filter(Boolean).join("\n\n")
              : undefined,
          },
        },
      };
    });

    sideRunRouting.delete(btw.runId);
    if (btw.streaming) {
      void ipc.interruptSession(btw.runId).catch(() => {});
    }
    if (btw.sideSessionId) {
      void ipc.cleanupSideSession(btw.engine, btw.sideSessionId, btw.workspacePath, btw.parentSessionId).catch((error) => showSideError(sessionKey, error));
    }
  },

  openSidechat: async ({
    sessionKey,
    engine,
    workspacePath,
    parentSessionId,
    initialQuestion,
    images = [],
    onAccepted,
    parentMessages = [],
    model,
    effort,
    providerId,
    parentPermission,
  }) => {
    set((s) => {
      const existing = s.sidechatBySession[sessionKey];
      return {
        sidechatBySession: {
          ...s.sidechatBySession,
          [sessionKey]: existing
            ? {
                ...existing,
                open: true,
                engine,
                workspacePath,
                parentSessionId: existing.sideSessionId || existing.streaming ? existing.parentSessionId : parentSessionId ?? existing.parentSessionId,
              }
            : {
                open: true,
                engine,
                workspacePath,
                parentSessionId,
                sideSessionId: null,
                runId: null,
                streaming: false,
                draft: "",
                messages: [],
                error: null,
                usage: null,
                startedAt: null,
              },
        },
      };
    });

    const trimmed = initialQuestion?.trim() ?? "";
    if (trimmed || images.length > 0) {
      get().updateSidechatImages(sessionKey, (paths) => [...new Set([...paths, ...images])]);
      await get().sendSidechatMessage({
        sessionKey,
        engine,
        workspacePath,
        parentSessionId,
        prompt: trimmed,
        images,
        onAccepted,
        parentMessages,
        model,
        effort,
        providerId,
        parentPermission,
      });
    } else onAccepted?.();
  },

  toggleSidechat: ({ sessionKey, engine, workspacePath, parentSessionId }) => {
    set((s) => {
      const existing = s.sidechatBySession[sessionKey];
      if (existing) {
        return {
          sidechatBySession: {
            ...s.sidechatBySession,
            [sessionKey]: {
              ...existing,
              open: !existing.open,
              engine,
              workspacePath,
              parentSessionId: existing.sideSessionId || existing.streaming ? existing.parentSessionId : parentSessionId ?? existing.parentSessionId,
            },
          },
        };
      }
      return {
        sidechatBySession: {
          ...s.sidechatBySession,
          [sessionKey]: {
            open: true,
            engine,
            workspacePath,
            parentSessionId,
            sideSessionId: null,
            runId: null,
            streaming: false,
            draft: "",
            messages: [],
            error: null,
            usage: null,
            startedAt: null,
          },
        },
      };
    });
  },

  closeSidechat: (sessionKey) => {
    const existing = get().sidechatBySession[sessionKey];
    if (!existing) return;
    set((s) => {
      const cur = s.sidechatBySession[sessionKey];
      if (!cur) return s;
      return {
        sidechatBySession: {
          ...s.sidechatBySession,
          [sessionKey]: {
            ...cur,
            open: false,
          },
        },
      };
    });
  },

  resetSidechat: async (sessionKey) => {
    const existing = get().sidechatBySession[sessionKey];
    if (!existing || sideOperations.has(sessionKey)) return;
    sideOperations.add(sessionKey);
    try {
    if (existing.runId) {
      if (existing.streaming) {
        await ipc.interruptSession(existing.runId);
      }
    }
    if (existing.sideSessionId) {
      await ipc.cleanupSideSession(existing.engine, existing.sideSessionId, existing.workspacePath, existing.parentSessionId);
    }
    if (existing.runId) sideRunRouting.delete(existing.runId);
    set((s) => {
      const cur = s.sidechatBySession[sessionKey];
      if (!cur) return s;
      return {
        sidechatBySession: {
          ...s.sidechatBySession,
          [sessionKey]: {
            ...cur,
            sideSessionId: null,
            runId: null,
            streaming: false,
            messages: [],
            error: null,
            usage: null,
            startedAt: null,
            progress: undefined,
            pendingContext: undefined,
          },
        },
      };
    });
    } catch (error) { showSideError(sessionKey, error); }
    finally { sideOperations.delete(sessionKey); }
  },

  discardSidechat: async (sessionKey) => {
    const existing = get().sidechatBySession[sessionKey];
    if (!existing || sideOperations.has(sessionKey)) return;
    sideOperations.add(sessionKey);
    try {
    if (existing.runId) {
      if (existing.streaming) {
        await ipc.interruptSession(existing.runId);
      }
    }
    if (existing.sideSessionId) {
      await ipc.cleanupSideSession(existing.engine, existing.sideSessionId, existing.workspacePath, existing.parentSessionId);
    }
    if (existing.runId) sideRunRouting.delete(existing.runId);
    set((s) => {
      const next = { ...s.sidechatBySession };
      delete next[sessionKey];
      return { sidechatBySession: next };
    });
    } catch (error) { showSideError(sessionKey, error); }
    finally { sideOperations.delete(sessionKey); }
  },

  setSidechatMode: (sessionKey, mode) => {
    if (sideOperations.has(sessionKey)) return;
    set((s) => {
      const current = s.sidechatBySession[sessionKey];
      if (!current || current.streaming) return s;
      return { sidechatBySession: { ...s.sidechatBySession, [sessionKey]: { ...current, mode } } };
    });
  },

  setSidechatDraft: (sessionKey, draft) => {
    set((s) => {
      const cur = s.sidechatBySession[sessionKey];
      if (!cur) return s;
      return {
        sidechatBySession: {
          ...s.sidechatBySession,
          [sessionKey]: { ...cur, draft },
        },
      };
    });
  },

  updateSidechatImages: (sessionKey, updater) => set((s) => {
    const current = s.sidechatBySession[sessionKey];
    if (!current) return s;
    return { sidechatBySession: { ...s.sidechatBySession, [sessionKey]: {
      ...current, draftImages: updater(current.draftImages ?? []),
    } } };
  }),

  sendSidechatMessage: async ({
    sessionKey,
    engine,
    workspacePath,
    parentSessionId,
    prompt,
    images = [],
    onAccepted,
    parentMessages,
    model,
    effort,
    providerId,
    parentPermission,
  }) => {
    const trimmed = prompt.trim();
    if (!trimmed && images.length === 0) return;
    const current = get().sidechatBySession[sessionKey];
    if (sideOperations.has(sessionKey)) return;
    const mode = current?.mode ?? "read-only";
    if (mode === "execute" && !parentPermission) {
      showSideError(sessionKey, i18n.t("sidechat.parentPermissionUnavailable"));
      return;
    }
    if (current?.streaming) {
      const prevRunId = current.runId;
      const targetId = prevRunId ?? current.sideSessionId;
      sideOperations.add(sessionKey);
      try {
        if (targetId) await ipc.interruptSession(targetId);
      } catch (error) {
        showSideError(sessionKey, error);
        return;
      } finally {
        sideOperations.delete(sessionKey);
      }
      if (prevRunId) {
        sideRunRouting.delete(prevRunId);
      }
      const prevDurationMs = current.startedAt ? Date.now() - current.startedAt : null;
      set((s) => {
        const existing = s.sidechatBySession[sessionKey];
        if (!existing || existing.runId !== prevRunId) return s;
        return {
          sidechatBySession: {
            ...s.sidechatBySession,
            [sessionKey]: {
              ...existing,
              streaming: false,
              runId: null,
              messages: settleLiveMessages(existing.messages, prevDurationMs),
            },
          },
        };
      });
    }

    const runId = `sidechat-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const latest = get().sidechatBySession[sessionKey] ?? current;
    const effectiveParentId = latest?.sideSessionId ? latest.parentSessionId : parentSessionId ?? latest?.parentSessionId ?? null;
    const existingSideId = latest?.sideSessionId ?? null;

    sideRunRouting.set(runId, { kind: "sidechat", sessionKey });

    set((s) => {
      const prev = s.sidechatBySession[sessionKey];
      const prevMessages = prev?.messages ?? [];
      const userMsg: Message = {
        seq: nextSeq(prevMessages),
        role: "user",
        text: trimmed,
        images,
        ts: new Date().toISOString(),
      };
      return {
        sidechatBySession: {
          ...s.sidechatBySession,
          [sessionKey]: {
            open: true,
            engine,
            workspacePath,
            parentSessionId: effectiveParentId,
            mode,
            sideSessionId: existingSideId,
            runId,
            streaming: true,
            progress: initialSideRunProgress(),
            draft: "",
            draftImages: [...new Set([...(prev?.draftImages ?? []), ...images])],
            messages: [...prevMessages, userMsg],
            error: null,
            usage: prev?.usage ?? null,
            startedAt,
            pendingContext: prev?.pendingContext,
          },
        },
      };
    });

    try {
      // If we already have a prior Q&A from `continueBtwInSidechat` but no persisted `sideSessionId` yet,
      // include those seed messages in the fallback transcript if parent session isn't on disk.
      const latestMessages = get().sidechatBySession[sessionKey]?.messages ?? [];
      const priorSideMessages = latestMessages.slice(0, -1);
      const fallbackTranscript = existingSideId
        ? null
        : buildFallbackTranscript(parentMessages);
      const seed = existingSideId ? current?.pendingContext : buildFallbackTranscript(priorSideMessages);
      const promptWithSeed = seed ? `<sidechat-history>\n${seed}\n</sidechat-history>\n\n${trimmed}` : trimmed;

      const res = await ipc.sendSideMessage({
        engine,
        workspacePath,
        parentSessionId: effectiveParentId,
        sideSessionId: existingSideId,
        prompt: promptWithSeed,
        imagePaths: images,
        ephemeral: false,
        permission: mode === "execute" ? parentPermission : null,
        fallbackTranscript,
        model: model ?? null,
        effort: effort ?? null,
        providerId: providerId ?? null,
        runId,
      });
      const submitted = new Set(images);
      get().updateSidechatImages(sideRunRouting.get(runId)?.sessionKey ?? sessionKey,
        (paths) => paths.filter((path) => !submitted.has(path)));
      onAccepted?.();
      const resultKey = sideRunRouting.get(runId)?.sessionKey ?? sessionKey;
      if (res?.sessionId) {
        set((s) => {
          const cur = s.sidechatBySession[resultKey];
          if (!cur || cur.runId !== runId) return s;
          return {
            sidechatBySession: {
              ...s.sidechatBySession,
              [resultKey]: { ...cur, sideSessionId: res.sessionId, pendingContext: undefined },
            },
          };
        });
      }
    } catch (err) {
      const resultKey = sideRunRouting.get(runId)?.sessionKey ?? sessionKey;
      sideRunRouting.delete(runId);
      set((s) => {
        const cur = s.sidechatBySession[resultKey];
        if (!cur || cur.runId !== runId) return s;
        return {
          sidechatBySession: {
            ...s.sidechatBySession,
            [resultKey]: {
              ...cur,
              streaming: false,
              runId: null,
              error: errorText(err),
              draft: cur.draft || trimmed,
              messages: settleLiveMessages(cur.messages),
            },
          },
        };
      });
    }
  },

  stopSidechat: async (sessionKey) => {
    const cur = get().sidechatBySession[sessionKey];
    if (!cur || !cur.streaming) return;
    const targetId = cur.runId ?? cur.sideSessionId;
    try {
      if (targetId) await ipc.interruptSession(targetId);
    } catch (error) { showSideError(sessionKey, error); return; }
    if (cur.runId) {
      sideRunRouting.delete(cur.runId);
    }
    const durationMs = cur.startedAt ? Date.now() - cur.startedAt : null;
    set((s) => {
      const existing = s.sidechatBySession[sessionKey];
      if (!existing || existing.runId !== cur.runId) return s;
      return {
        sidechatBySession: {
          ...s.sidechatBySession,
          [sessionKey]: {
            ...existing,
            streaming: false,
            runId: null,
            messages: settleLiveMessages(existing.messages, durationMs),
          },
        },
      };
    });
  },

  promoteSidechatToTab: async (sessionKey) => {
    const cur = get().sidechatBySession[sessionKey];
    if (!cur || !cur.sideSessionId || sideOperations.has(sessionKey)) return null;
    sideOperations.add(sessionKey);
    try {
    if (cur.streaming && cur.runId) {
      await ipc.interruptSession(cur.runId);
    }
    await ipc.promoteSideSession(cur.engine, cur.sideSessionId, cur.workspacePath, cur.parentSessionId);
    if (cur.runId) sideRunRouting.delete(cur.runId);
    const promoted = {
      engine: cur.engine,
      sessionId: cur.sideSessionId,
      workspacePath: cur.workspacePath,
    };
    set((s) => {
      const next = { ...s.sidechatBySession };
      delete next[sessionKey];
      return { sidechatBySession: next };
    });
    return promoted;
    } catch (error) { showSideError(sessionKey, error); return null; }
    finally { sideOperations.delete(sessionKey); }
  },
}));

export function migrateSidechatSessionKey(
  fromKey: string,
  toKey: string,
  newParentSessionId: string,
): void {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const state = useSidechatStore.getState();
  const hasBtw = fromKey in state.btwBySession;
  const hasSc = fromKey in state.sidechatBySession;
  if (!hasBtw && !hasSc) return;

  for (const [runId, target] of sideRunRouting.entries()) {
    if (target.sessionKey === fromKey) {
      sideRunRouting.set(runId, { ...target, sessionKey: toKey });
    }
  }

  useSidechatStore.setState((s) => {
    const nextBtw = { ...s.btwBySession };
    const nextSc = { ...s.sidechatBySession };
    if (fromKey in nextBtw) {
      const item = nextBtw[fromKey];
      delete nextBtw[fromKey];
      if (!(toKey in nextBtw)) {
        nextBtw[toKey] = {
          ...item,
          parentSessionId: item.parentSessionId,
        };
      }
    }
    if (fromKey in nextSc) {
      const item = nextSc[fromKey];
      delete nextSc[fromKey];
      if (!(toKey in nextSc)) {
        nextSc[toKey] = {
          ...item,
          parentSessionId: item.sideSessionId || item.streaming ? item.parentSessionId : item.parentSessionId ?? newParentSessionId,
        };
      }
    }
    return { btwBySession: nextBtw, sidechatBySession: nextSc };
  });
}

export function handleSideRunEvent(event: SideEvent): void {
  const target = sideRunRouting.get(event.runId);
  if (!target) return;
  if (event.seq <= (target.lastSeq ?? -1)) return;
  target.lastSeq = event.seq;

  if (target.kind === "btw") {
    handleBtwEvent(target.sessionKey, event);
  } else {
    handleSidechatPanelEvent(target.sessionKey, event);
  }
}

/** Fold progress into the same notification as text/tool changes. */
function sideEventSetter(sessionKey: string, event: SideEvent, kind: SideRunTarget["kind"]) {
  const receivedAt = Date.now();
  return (update: (state: SidechatStore) => Partial<SidechatStore>) => {
    useSidechatStore.setState((state) => {
      const key = kind === "btw" ? "btwBySession" : "sidechatBySession";
      const current = state[key][sessionKey];
      if (!current?.streaming || current.runId !== event.runId) return state;
      const change = update(state);
      const progress = reduceSideRunProgress(current.progress, event, receivedAt);
      if (progress === current.progress) return change;
      const entries = change[key] ?? state[key];
      return { ...change, [key]: { ...entries, [sessionKey]: { ...entries[sessionKey], progress } } };
    });
  };
}

function handleBtwEvent(sessionKey: string, event: SideEvent): void {
  const state = useSidechatStore.getState();
  const cur = state.btwBySession[sessionKey];
  if (!cur || !cur.streaming || cur.runId !== event.runId) return;

  const setEventState = sideEventSetter(sessionKey, event, "btw");

  switch (event.kind) {
    case "session": {
      const sid = typeof event.data === "string" ? event.data.trim() : "";
      if (!sid) return;
      setEventState((s) => {
        const b = s.btwBySession[sessionKey];
        if (!b || b.runId !== event.runId) return s;
        return {
          btwBySession: {
            ...s.btwBySession,
            [sessionKey]: { ...b, sideSessionId: sid },
          },
        };
      });
      return;
    }
    case "delta": {
      const delta = typeof event.data === "string" ? event.data : "";
      if (!delta) return;
      setEventState((s) => {
        const b = s.btwBySession[sessionKey];
        if (!b || b.runId !== event.runId) return s;
        return {
          btwBySession: {
            ...s.btwBySession,
            [sessionKey]: { ...b, answer: b.answer + delta },
          },
        };
      });
      return;
    }
    case "thinking": {
      const delta = typeof event.data === "string" ? event.data : "";
      if (!delta) return;
      setEventState((s) => {
        const b = s.btwBySession[sessionKey];
        if (!b || b.runId !== event.runId) return s;
        return {
          btwBySession: {
            ...s.btwBySession,
            [sessionKey]: { ...b, thinking: b.thinking + delta },
          },
        };
      });
      return;
    }
    case "message": {
      const raw = event.data as {
        role?: string;
        text?: string;
        path?: string | null;
        patch?: boolean;
      } | null;
      if (!raw || typeof raw !== "object") return;
      if (raw.role === "assistant" && typeof raw.text === "string" && raw.text.trim()) {
        setEventState((s) => {
          const b = s.btwBySession[sessionKey];
          if (!b || b.runId !== event.runId) return s;
          const nextAnswer = b.answer.slice(0, b.answerCommitted ?? 0) + raw.text!;
          return {
            btwBySession: {
              ...s.btwBySession,
              [sessionKey]: { ...b, answer: nextAnswer, answerCommitted: nextAnswer.length },
            },
          };
        });
      } else if (raw.role === "thinking" && typeof raw.text === "string" && raw.text.trim()) {
        setEventState((s) => {
          const b = s.btwBySession[sessionKey];
          if (!b || b.runId !== event.runId) return s;
          const nextThinking = b.thinking.slice(0, b.thinkingCommitted ?? 0) + raw.text!;
          return {
            btwBySession: {
              ...s.btwBySession,
              [sessionKey]: { ...b, thinking: nextThinking, thinkingCommitted: nextThinking.length },
            },
          };
        });
      } else if (raw.role === "tool" || raw.role === "tool_result") {
        const name = (raw.text ?? "tool").trim();
        const isPatch = raw.patch === true || raw.role === "tool_result";
        setEventState((s) => {
          const b = s.btwBySession[sessionKey];
          if (!b || b.runId !== event.runId) return s;
          const tools = [...b.tools];
          if (isPatch && tools.length > 0) {
            let idx = tools.findLastIndex((t) => t.status === "running" && t.name === name);
            if (idx < 0) idx = tools.findLastIndex((t) => t.status === "running");
            if (idx < 0) idx = tools.findLastIndex((t) => t.name === name);
            if (idx >= 0) {
              tools[idx] = { ...tools[idx], status: "done" };
            }
          } else {
            tools.push({
              id: `${event.seq}-${tools.length}`,
              name,
              path: raw.path ?? null,
              status: "running",
            });
          }
          return {
            btwBySession: {
              ...s.btwBySession,
              [sessionKey]: { ...b, tools },
            },
          };
        });
      }
      return;
    }
    case "usage": {
      const parsed = parseUsage(event.data);
      if (!parsed) { setEventState((s) => s); return; }
      setEventState((s) => {
        const b = s.btwBySession[sessionKey];
        if (!b || b.runId !== event.runId) return s;
        return {
          btwBySession: {
            ...s.btwBySession,
            [sessionKey]: { ...b, usage: parsed },
          },
        };
      });
      return;
    }
    case "turn_complete": {
      const payload = event.data as TurnCompletePayload | null;
      const parsed = payload?.usage ? parseUsage(payload.usage) : null;
      if (!parsed) { setEventState((s) => s); return; }
      setEventState((s) => {
        const b = s.btwBySession[sessionKey];
        if (!b || b.runId !== event.runId) return s;
        return {
          btwBySession: {
            ...s.btwBySession,
            [sessionKey]: { ...b, usage: parsed },
          },
        };
      });
      return;
    }
    case "error": {
      const msg = typeof event.data === "string" ? event.data : errorText(event.data);
      sideRunRouting.delete(event.runId);
      setEventState((s) => {
        const b = s.btwBySession[sessionKey];
        if (!b || b.runId !== event.runId) return s;
        return {
          btwBySession: {
            ...s.btwBySession,
            [sessionKey]: {
              ...b,
              streaming: false,
              error: msg,
              durationMs: Date.now() - b.startedAt,
              tools: b.tools.map((t) => ({ ...t, status: "done" as const })),
            },
          },
        };
      });
      return;
    }
    case "done": {
      const data = event.data as { sessionId?: string | null; usage?: unknown } | null;
      const parsed = data?.usage ? parseUsage(data.usage) : null;
      sideRunRouting.delete(event.runId);
      setEventState((s) => {
        const b = s.btwBySession[sessionKey];
        if (!b || b.runId !== event.runId) return s;
        return {
          btwBySession: {
            ...s.btwBySession,
            [sessionKey]: {
              ...b,
              sideSessionId: data?.sessionId ?? b.sideSessionId,
              streaming: false,
              usage: parsed ?? b.usage,
              durationMs: Date.now() - b.startedAt,
              tools: b.tools.map((t) => ({ ...t, status: "done" as const })),
            },
          },
        };
      });
      return;
    }
    default:
      setEventState((s) => s);
      return;
  }
}

function handleSidechatPanelEvent(
  sessionKey: string,
  event: SideEvent,
): void {
  const state = useSidechatStore.getState();
  const cur = state.sidechatBySession[sessionKey];
  if (!cur || !cur.streaming || cur.runId !== event.runId) return;

  const setEventState = sideEventSetter(sessionKey, event, "sidechat");

  switch (event.kind) {
    case "session": {
      const sid = typeof event.data === "string" ? event.data.trim() : "";
      if (!sid) return;
      setEventState((s) => {
        const sc = s.sidechatBySession[sessionKey];
        if (!sc || sc.runId !== event.runId) return s;
        return {
          sidechatBySession: {
            ...s.sidechatBySession,
            [sessionKey]: { ...sc, sideSessionId: sid },
          },
        };
      });
      return;
    }
    case "delta": {
      const delta = typeof event.data === "string" ? event.data : "";
      if (!delta) return;
      setEventState((s) => {
        const sc = s.sidechatBySession[sessionKey];
        if (!sc || sc.runId !== event.runId) return s;
        return {
          sidechatBySession: {
            ...s.sidechatBySession,
            [sessionKey]: {
              ...sc,
              messages: appendOrUpdateLiveMessage(sc.messages, "assistant", delta),
            },
          },
        };
      });
      return;
    }
    case "thinking": {
      const delta = typeof event.data === "string" ? event.data : "";
      if (!delta) return;
      setEventState((s) => {
        const sc = s.sidechatBySession[sessionKey];
        if (!sc || sc.runId !== event.runId) return s;
        return {
          sidechatBySession: {
            ...s.sidechatBySession,
            [sessionKey]: {
              ...sc,
              messages: appendOrUpdateLiveMessage(sc.messages, "thinking", delta),
            },
          },
        };
      });
      return;
    }
    case "message": {
      const raw = event.data as {
        role?: string;
        text?: string;
        path?: string | null;
        args?: unknown;
        result?: unknown;
        patch?: boolean;
      } | null;
      if (!raw || typeof raw !== "object") return;
      if (raw.role === "assistant" && typeof raw.text === "string" && raw.text.trim()) {
        setEventState((s) => {
          const sc = s.sidechatBySession[sessionKey];
          if (!sc || sc.runId !== event.runId) return s;
          const liveIndex = sc.messages.findLastIndex((m) => m.live && m.role === "assistant");
          if (liveIndex >= 0) {
            const messages = [...sc.messages];
            messages[liveIndex] = { ...messages[liveIndex], text: raw.text!, live: false };
            return { sidechatBySession: { ...s.sidechatBySession, [sessionKey]: { ...sc, messages } } };
          }
          return {
            sidechatBySession: {
              ...s.sidechatBySession,
              [sessionKey]: {
                ...sc,
                messages: [
                  ...sc.messages,
                  {
                    seq: nextSeq(sc.messages),
                    role: "assistant",
                    text: raw.text!,
                    ts: new Date().toISOString(),
                    live: false,
                  },
                ],
              },
            },
          };
        });
      } else if (raw.role === "thinking" && typeof raw.text === "string" && raw.text.trim()) {
        setEventState((s) => {
          const sc = s.sidechatBySession[sessionKey];
          if (!sc || sc.runId !== event.runId) return s;
          const liveIndex = sc.messages.findLastIndex((m) => m.live && m.role === "thinking");
          if (liveIndex >= 0) {
            const messages = [...sc.messages];
            messages[liveIndex] = { ...messages[liveIndex], text: raw.text!, live: false };
            return { sidechatBySession: { ...s.sidechatBySession, [sessionKey]: { ...sc, messages } } };
          }
          return {
            sidechatBySession: {
              ...s.sidechatBySession,
              [sessionKey]: {
                ...sc,
                messages: [
                  ...sc.messages,
                  {
                    seq: nextSeq(sc.messages),
                    role: "thinking",
                    text: raw.text!,
                    ts: new Date().toISOString(),
                    live: false,
                  },
                ],
              },
            },
          };
        });
      } else if (raw.role === "tool" || raw.role === "tool_result") {
        const name = (raw.text ?? "tool").trim();
        const isPatch = raw.patch === true || raw.role === "tool_result";
        setEventState((s) => {
          const sc = s.sidechatBySession[sessionKey];
          if (!sc || sc.runId !== event.runId) return s;
          const msgs = [...sc.messages];
          if (isPatch) {
            let idx = msgs.findLastIndex((m) => m.role === "tool" && m.live && m.text === name);
            if (idx < 0) idx = msgs.findLastIndex((m) => m.role === "tool" && m.live);
            if (idx < 0) idx = msgs.findLastIndex((m) => m.role === "tool" && m.text === name);
            if (idx >= 0) {
              msgs[idx] = {
                ...msgs[idx],
                result: raw.result ?? "done",
                live: false,
              };
              return {
                sidechatBySession: {
                  ...s.sidechatBySession,
                  [sessionKey]: { ...sc, messages: msgs },
                },
              };
            }
          }
          msgs.push({
            seq: nextSeq(msgs),
            role: "tool",
            text: name,
            path: raw.path ?? null,
            args: raw.args,
            result: raw.result,
            ts: new Date().toISOString(),
            live: !isPatch,
          });
          return {
            sidechatBySession: {
              ...s.sidechatBySession,
              [sessionKey]: { ...sc, messages: msgs },
            },
          };
        });
      }
      return;
    }
    case "usage": {
      const parsed = parseUsage(event.data);
      if (!parsed) { setEventState((s) => s); return; }
      setEventState((s) => {
        const sc = s.sidechatBySession[sessionKey];
        if (!sc || sc.runId !== event.runId) return s;
        return {
          sidechatBySession: {
            ...s.sidechatBySession,
            [sessionKey]: { ...sc, usage: parsed },
          },
        };
      });
      return;
    }
    case "turn_complete": {
      const payload = event.data as TurnCompletePayload | null;
      const parsed = payload?.usage ? parseUsage(payload.usage) : null;
      if (!parsed) { setEventState((s) => s); return; }
      setEventState((s) => {
        const sc = s.sidechatBySession[sessionKey];
        if (!sc || sc.runId !== event.runId) return s;
        return {
          sidechatBySession: {
            ...s.sidechatBySession,
            [sessionKey]: { ...sc, usage: parsed },
          },
        };
      });
      return;
    }
    case "error": {
      const msg = typeof event.data === "string" ? event.data : errorText(event.data);
      sideRunRouting.delete(event.runId);
      setEventState((s) => {
        const sc = s.sidechatBySession[sessionKey];
        if (!sc || sc.runId !== event.runId) return s;
        const durationMs = sc.startedAt ? Date.now() - sc.startedAt : null;
        return {
          sidechatBySession: {
            ...s.sidechatBySession,
            [sessionKey]: {
              ...sc,
              streaming: false,
              runId: null,
              error: msg,
              messages: settleLiveMessages(sc.messages, durationMs),
            },
          },
        };
      });
      return;
    }
    case "done": {
      const data = event.data as { sessionId?: string | null; usage?: unknown } | null;
      const parsed = data?.usage ? parseUsage(data.usage) : null;
      sideRunRouting.delete(event.runId);
      setEventState((s) => {
        const sc = s.sidechatBySession[sessionKey];
        if (!sc || sc.runId !== event.runId) return s;
        const durationMs = sc.startedAt ? Date.now() - sc.startedAt : null;
        return {
          sidechatBySession: {
            ...s.sidechatBySession,
            [sessionKey]: {
              ...sc,
              sideSessionId: data?.sessionId ?? sc.sideSessionId,
              streaming: false,
              runId: null,
              usage: parsed ?? sc.usage,
              pendingContext: undefined,
              messages: settleLiveMessages(sc.messages, durationMs),
            },
          },
        };
      });
      return;
    }
    default:
      setEventState((s) => s);
      return;
  }
}
