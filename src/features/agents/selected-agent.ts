import { useCallback } from "react";
import { create } from "zustand";
import type { AgentConfig } from "@/lib/ipc";
import { readStoredJson, writeStored } from "@/lib/storage";

/**
 * Per-thread selected agent, persisted across restarts. Draft tabs (no
 * session id yet) share the `${root}::draft` slot; when the engine stamps a
 * native session id, `migrateSelectedAgent` moves the entry onto the real
 * key so the selection survives the draft → session transition.
 */
const STORAGE_KEY = "ccgui-next.selectedAgentByThread:v1";
const DRAFT_SESSION = "draft";

export function selectedAgentKey(
  root: string,
  sessionId: string | null,
): string {
  return `${root}::${sessionId ?? DRAFT_SESSION}`;
}

function validate(
  value: unknown,
): Record<string, AgentConfig> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, AgentConfig> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const agent = entry as AgentConfig;
    if (typeof agent.id !== "string" || typeof agent.name !== "string") {
      continue;
    }
    // `source` rides along untyped: absent (older entries) means "custom";
    // "builtIn" entries resolve their prompt at send time.
    out[key] = agent;
  }
  return out;
}

interface SelectedAgentState {
  byThread: Record<string, AgentConfig>;
  select(key: string, agent: AgentConfig): void;
  clear(key: string): void;
  migrate(root: string, sessionId: string): void;
}

function persist(
  byThread: Record<string, AgentConfig>,
): { byThread: Record<string, AgentConfig> } {
  writeStored(STORAGE_KEY, JSON.stringify(byThread));
  return { byThread };
}

const useSelectedAgentStore = create<SelectedAgentState>((set) => ({
  byThread: readStoredJson(STORAGE_KEY, validate) ?? {},
  select: (key, agent) =>
    set((s) => persist({ ...s.byThread, [key]: agent })),
  clear: (key) =>
    set((s) => {
      if (!(key in s.byThread)) return s;
      const next = { ...s.byThread };
      delete next[key];
      return persist(next);
    }),
  migrate: (root, sessionId) =>
    set((s) => {
      const draftKey = selectedAgentKey(root, null);
      const nextKey = selectedAgentKey(root, sessionId);
      const agent = s.byThread[draftKey];
      if (!agent || s.byThread[nextKey]) return s;
      const next = { ...s.byThread, [nextKey]: agent };
      delete next[draftKey];
      return persist(next);
    }),
}));

/** Hook for the composer pickers: the agent pinned to this thread. */
export function useSelectedAgent(root: string, sessionId: string | null) {
  const key = selectedAgentKey(root, sessionId);
  const agent = useSelectedAgentStore((s) => s.byThread[key] ?? null);
  const selectEntry = useSelectedAgentStore((s) => s.select);
  const clearEntry = useSelectedAgentStore((s) => s.clear);
  return {
    agent,
    select: useCallback(
      (next: AgentConfig) => selectEntry(key, next),
      [selectEntry, key],
    ),
    clear: useCallback(() => clearEntry(key), [clearEntry, key]),
  };
}

/** Non-hook read for the send path. */
export function getSelectedAgent(
  root: string,
  sessionId: string | null,
): AgentConfig | null {
  return (
    useSelectedAgentStore.getState().byThread[
      selectedAgentKey(root, sessionId)
    ] ?? null
  );
}
/** Non-hook select, the write half of getSelectedAgent (send path, tests). */
export function selectSelectedAgent(
  root: string,
  sessionId: string | null,
  agent: AgentConfig,
): void {
  useSelectedAgentStore.getState().select(selectedAgentKey(root, sessionId), agent);
}

/** Non-hook clear for the send path (e.g. a built-in pick whose catalog
 *  entry was disabled since). */
export function clearSelectedAgent(
  root: string,
  sessionId: string | null,
): void {
  useSelectedAgentStore.getState().clear(selectedAgentKey(root, sessionId));
}

/** Move a draft-tab selection onto the freshly stamped native session id. */
export function migrateSelectedAgent(root: string, sessionId: string): void {
  useSelectedAgentStore.getState().migrate(root, sessionId);
}
