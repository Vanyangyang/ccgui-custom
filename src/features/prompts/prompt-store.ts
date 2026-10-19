/**
 * Custom prompts: markdown files with `---` frontmatter (description,
 * argument-hint) that the composer `!` menu inserts into the input and the
 * settings page manages. Workspace scope lives under
 * `<root>/.ccgui/prompts/`, global scope under `~/.ccgui-next/prompts/`.
 *
 * Per-root cache modeled on create-root-cache-store (stale-while-
 * revalidate, one in-flight IPC per root) with an added forced refresh()
 * so CRUD and PROMPTS_CHANGED_EVENT revalidate immediately instead of
 * waiting out the TTL. All mutations go through the helpers below — they
 * refresh the root and broadcast PROMPTS_CHANGED_EVENT for other surfaces.
 */

import { create } from "zustand";
import { ipc, type CustomPromptEntry, type PromptScope } from "@/lib/ipc";
import type { RootCache } from "@/components/application/ai-chat/create-root-cache-store";

/** Broadcast after any prompt mutation; detail carries the workspace root. */
export const PROMPTS_CHANGED_EVENT = "ccgui-next:prompts-changed";

/** Subscribe to prompt mutations; `root` is the affected workspace root,
 *  null when the event carries none. Returns the unlisten fn. */
export function subscribePromptsChanged(
  listener: (root: string | null) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ root?: string }>).detail;
    listener(detail?.root ?? null);
  };
  window.addEventListener(PROMPTS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(PROMPTS_CHANGED_EVENT, handler);
}

function notifyPromptsChanged(root: string): void {
  window.dispatchEvent(new CustomEvent(PROMPTS_CHANGED_EVENT, { detail: { root } }));
}

/** One root's cached prompts: a stale-while-revalidate snapshot. */
export type RootPrompts = RootCache<CustomPromptEntry>;

const PROMPTS_TTL_MS = 60_000;

interface PromptStore {
  byRoot: Record<string, RootPrompts>;
  /** Fetch once per root, then again only once stale; concurrent calls
   *  share one IPC. Never throws. */
  ensure: (root: string) => void;
  /** Force a re-fetch regardless of TTL; concurrent calls share one IPC.
   *  Never rejects: a failure keeps the previous entries. */
  refresh: (root: string) => Promise<void>;
}

/** In-flight fetches keyed by root: ensure/refresh share one IPC. */
const inFlight = new Map<string, Promise<void>>();

export const usePromptStore = create<PromptStore>()((set, get) => {
  const load = (root: string): Promise<void> => {
    const existing = inFlight.get(root);
    if (existing) return existing;
    const p = ipc
      .listPrompts(root)
      .then((entries) => {
        set((s) => {
          // Pruned while the fetch was in flight (workspace removed): stay gone.
          if (!(root in s.byRoot)) return {};
          return {
            byRoot: {
              ...s.byRoot,
              [root]: { entries, status: "ready", fetchedAt: Date.now() },
            },
          };
        });
      })
      .catch(() => {
        set((s) => {
          if (!(root in s.byRoot)) return {};
          const prev = s.byRoot[root];
          return {
            byRoot: {
              ...s.byRoot,
              // A failed refresh keeps serving the stale entries; only a
              // failed first fetch leaves the picker empty.
              [root]: {
                entries: prev?.entries ?? [],
                status: "error",
                fetchedAt: prev?.fetchedAt ?? 0,
              },
            },
          };
        });
      })
      .finally(() => {
        inFlight.delete(root);
      });
    inFlight.set(root, p);
    return p;
  };

  const startLoading = (root: string) => {
    set((s) => ({
      byRoot: { ...s.byRoot, [root]: { entries: [], status: "loading", fetchedAt: 0 } },
    }));
  };

  return {
    byRoot: {},
    ensure: (root) => {
      if (!root) return;
      const cur = get().byRoot[root];
      if (cur && cur.status === "ready" && Date.now() - cur.fetchedAt < PROMPTS_TTL_MS) return;
      if (!cur) startLoading(root);
      void load(root);
    },
    refresh: (root) => {
      if (!root) return Promise.resolve();
      if (!get().byRoot[root]) startLoading(root);
      return load(root);
    },
  };
});

/** Drop one workspace root's cache when its workspace is removed; the
 *  per-root map would otherwise accumulate every root ever opened. */
export function prunePrompts(root: string): void {
  usePromptStore.setState((s) => {
    if (!(root in s.byRoot)) return {};
    const byRoot = { ...s.byRoot };
    delete byRoot[root];
    return { byRoot };
  });
}

export interface PromptInput {
  name: string;
  description?: string;
  argumentHint?: string;
  content: string;
}
export type PromptUpdates = Partial<PromptInput>;

// CRUD helpers — dispatch before refreshing so subscribers' refreshes join
// the in-flight fetch below instead of firing a second one.

export async function createPrompt(
  root: string,
  scope: PromptScope,
  input: PromptInput,
): Promise<CustomPromptEntry> {
  const entry = await ipc.createPrompt(root, scope, input);
  notifyPromptsChanged(root);
  await usePromptStore.getState().refresh(root);
  return entry;
}

export async function updatePrompt(
  root: string,
  promptPath: string,
  updates: PromptUpdates,
): Promise<CustomPromptEntry> {
  const entry = await ipc.updatePrompt(root, promptPath, updates);
  notifyPromptsChanged(root);
  await usePromptStore.getState().refresh(root);
  return entry;
}

export async function deletePrompt(root: string, promptPath: string): Promise<void> {
  await ipc.deletePrompt(root, promptPath);
  notifyPromptsChanged(root);
  await usePromptStore.getState().refresh(root);
}

export async function movePrompt(
  root: string,
  promptPath: string,
  scope: PromptScope,
): Promise<CustomPromptEntry> {
  const entry = await ipc.movePrompt(root, promptPath, scope);
  notifyPromptsChanged(root);
  await usePromptStore.getState().refresh(root);
  return entry;
}

// Mutations from any surface revalidate the affected root's cache (every
// cached root when the event carries none).
subscribePromptsChanged((root) => {
  if (root) {
    void usePromptStore.getState().refresh(root);
    return;
  }
  const { byRoot, refresh } = usePromptStore.getState();
  for (const key of Object.keys(byRoot)) void refresh(key);
});

/** `!` picker filter: case-insensitive substring over name, description,
 *  and content, keeping the backend's order. */
export function matchPrompts(
  entries: CustomPromptEntry[],
  query: string,
): CustomPromptEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().includes(q) ||
      (entry.description ?? "").toLowerCase().includes(q) ||
      entry.content.toLowerCase().includes(q),
  );
}
