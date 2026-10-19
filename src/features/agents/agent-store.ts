/**
 * Agent personas: user-named prompt presets stored in
 * ~/.ccgui-next/agents.json behind the agent_* IPC commands, plus the
 * bundled read-only built-in catalog (list_built_in_agents) whose enabled
 * entries merge into the same composer `#` menu. The settings page manages
 * both lists. This store is the app-wide cache — every mutation goes
 * through it, then refreshes and broadcasts AGENTS_CHANGED_EVENT so
 * non-store listeners (e.g. selected-agent persistence pruning deleted
 * agents) re-read too.
 */

import { create } from "zustand";
import i18n from "@/lib/i18n";
import {
  ipc,
  type AgentConfig,
  type BuiltInAgentDivisionView,
  type BuiltInAgentView,
} from "@/lib/ipc";

/** Broadcast after any agent mutation (window CustomEvent, no detail). */
export const AGENTS_CHANGED_EVENT = "ccgui-next:agents-changed";

/** Subscribe to agent-list mutations; returns the unlisten fn. */
export function subscribeAgentsChanged(listener: () => void): () => void {
  window.addEventListener(AGENTS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(AGENTS_CHANGED_EVENT, listener);
}

function notifyAgentsChanged(): void {
  window.dispatchEvent(new CustomEvent(AGENTS_CHANGED_EVENT));
}

/** Locale argument for `listBuiltInAgents`: catalog names/descriptions
 *  ship per-language, so pickers follow the UI language. */
export function currentCatalogLocale(): string {
  return i18n.resolvedLanguage ?? i18n.language;
}

export interface AgentInput {
  name: string;
  prompt?: string;
  icon?: string;
}
export type AgentUpdates = Partial<AgentInput>;

interface AgentStore {
  agents: AgentConfig[];
  /** Enabled built-in catalog agents, merged into the `#` menu. */
  builtInAgents: BuiltInAgentView[];
  /** Catalog divisions in display order, for the menu's section headers. */
  builtInDivisions: BuiltInAgentDivisionView[];
  /** False until the first refresh settles — lets pickers show loading. */
  loaded: boolean;
  /** Re-fetch both lists; concurrent calls share one IPC round-trip. Never
   *  rejects: a failure keeps the previous list (the
   *  create-root-cache-store stale-on-error model). */
  refresh: () => Promise<void>;
  create: (input: AgentInput) => Promise<AgentConfig>;
  update: (id: string, updates: AgentUpdates) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** In-flight refresh shared by concurrent callers. */
let refreshInFlight: Promise<void> | null = null;

export const useAgentStore = create<AgentStore>()((set, get) => ({
  agents: [],
  builtInAgents: [],
  builtInDivisions: [],
  loaded: false,
  refresh: () => {
    if (refreshInFlight) return refreshInFlight;
    const p = Promise.all([
      ipc.listAgents().catch(() => null),
      // The catalog is a bundled read-only resource; a failure keeps the
      // previous built-in list.
      ipc.listBuiltInAgents(currentCatalogLocale()).catch(() => null),
    ])
      .then(([agents, catalog]) =>
        set((s) => ({
          agents: agents ?? s.agents,
          builtInAgents: catalog
            ? catalog.agents.filter((agent) => agent.enabled)
            : s.builtInAgents,
          builtInDivisions: catalog ? catalog.divisions : s.builtInDivisions,
          loaded: true,
        })),
      )
      .finally(() => {
        refreshInFlight = null;
      });
    refreshInFlight = p;
    return p;
  },
  create: async (input) => {
    const agent = await ipc.addAgent(input);
    // Dispatch before refreshing: subscribers' refreshes then join the
    // in-flight fetch below instead of firing a second one.
    notifyAgentsChanged();
    await get().refresh();
    return agent;
  },
  update: async (id, updates) => {
    await ipc.updateAgent(id, updates);
    notifyAgentsChanged();
    await get().refresh();
  },
  remove: async (id) => {
    await ipc.deleteAgent(id);
    notifyAgentsChanged();
    await get().refresh();
  },
}));

// Mutations from any surface revalidate the cache.
subscribeAgentsChanged(() => {
  void useAgentStore.getState().refresh();
});

// Catalog strings are localized: re-fetch when the UI language changes.
i18n.on("languageChanged", () => {
  void useAgentStore.getState().refresh();
});

/** `#` picker filter: case-insensitive substring over name and prompt,
 *  keeping the backend's order. */
export function matchAgents(agents: AgentConfig[], query: string): AgentConfig[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(q) ||
      (agent.prompt ?? "").toLowerCase().includes(q),
  );
}

/** Same filter for built-in catalog rows: name + description (they carry
 *  no prompt — that resolves at send time). */
export function matchBuiltInAgents(
  agents: BuiltInAgentView[],
  query: string,
): BuiltInAgentView[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(q) ||
      agent.description.toLowerCase().includes(q),
  );
}
