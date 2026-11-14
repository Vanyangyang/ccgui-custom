import { safeRandomUUID } from "@/lib/id";
import { readStoredJson, writeStored } from "@/lib/storage";
import { registerRuntimeCheckpointParticipant } from "@/lib/runtime-checkpoint";

export interface ConversationModeCheckpoint {
  version: 1;
  identities: Record<string, string>;
  selections: Record<string, string>;
  blocked: Record<string, string>;
}

function checkpointStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error("Invalid conversation mode checkpoint map");
  }
  return Object.fromEntries(Object.entries(value)) as Record<string, string>;
}

export class ConversationModeState {
  private identities = new Map<string, string>();
  private selections = new Map<string, string>();
  private blocked = new Map<string, string>();
  private occupationListeners = new Set<() => void>();

  constructor(
    saved: Record<string, string> = {},
    private persist: (identities: Record<string, string>) => void = () => {},
    savedLocks: Record<string, string> = {},
    private persistLocks: (locks: Record<string, string>) => void = () => {},
  ) {
    this.identities = new Map(Object.entries(saved).filter(([, identity]) => typeof identity === "string"));
    this.blocked = new Map(Object.entries(savedLocks).filter(([, mode]) => typeof mode === "string"));
    this.selections = new Map(this.blocked);
  }

  captureCheckpoint(): ConversationModeCheckpoint {
    return { version: 1, identities: Object.fromEntries(this.identities), selections: Object.fromEntries(this.selections), blocked: Object.fromEntries(this.blocked) };
  }

  /** Read-only observation of tab occupation; mode edits that keep it occupied are silent. */
  subscribeOccupation(listener: () => void): () => void {
    this.occupationListeners.add(listener);
    return () => { this.occupationListeners.delete(listener); };
  }

  private occupiedTabs(): Set<string> | undefined {
    if (!this.occupationListeners.size) return undefined;
    return new Set([...this.identities].filter(([, identity]) => this.selected(identity) !== undefined).map(([key]) => key));
  }

  private notifyOccupation(before: Set<string> | undefined): void {
    if (!before) return;
    const after = this.occupiedTabs();
    if (after && (before.size !== after.size || [...before].some(key => !after.has(key)))) {
      for (const listener of this.occupationListeners) listener();
    }
  }

  /** Validate every map before changing any state. Restoring must never write
   * preferences or mint a new draft identity. Existing callers retain this instance. */
  restoreCheckpoint(value: unknown): void {
    const snapshot = value as Partial<ConversationModeCheckpoint> | null;
    if (snapshot?.version !== 1) throw new Error("Unsupported conversation mode checkpoint");
    const identities = checkpointStrings(snapshot.identities);
    const selections = checkpointStrings(snapshot.selections);
    const blocked = checkpointStrings(snapshot.blocked);
    const before = this.occupiedTabs();
    this.identities = new Map(Object.entries(identities));
    this.selections = new Map(Object.entries(selections));
    this.blocked = new Map(Object.entries(blocked));
    this.notifyOccupation(before);
  }

  identity(sessionKey: string, workspacePath: string, draft: boolean): string {
    const key = JSON.stringify([workspacePath, sessionKey]);
    let identity = this.identities.get(key);
    if (!identity) {
      const before = this.occupiedTabs();
      identity = draft ? JSON.stringify([workspacePath, sessionKey, safeRandomUUID()]) : key;
      this.identities.set(key, identity);
      this.persist(Object.fromEntries(this.identities));
      this.notifyOccupation(before);
    }
    return identity;
  }

  retain(sessions: readonly { key: string; workspacePath: string }[]): void {
    const before = this.occupiedTabs();
    const retained = new Set(sessions.map((session) => JSON.stringify([session.workspacePath, session.key])));
    let changed = false;
    for (const [key, identity] of this.identities) {
      if (!retained.has(key) && !this.isExitBlocked(identity)) {
        this.identities.delete(key);
        this.selections.delete(identity);
        changed = true;
      }
    }
    if (changed) this.persist(Object.fromEntries(this.identities));
    this.notifyOccupation(before);
  }

  select(identity: string, mode: string, streaming: boolean, queued: number): boolean {
    if (streaming || queued > 0 || (this.isExitBlocked(identity) && this.blocked.get(identity) !== mode)) return false;
    const before = this.occupiedTabs();
    this.selections.set(identity, mode);
    this.notifyOccupation(before);
    return true;
  }

  selected(identity: string): string | undefined {
    return this.blocked.get(identity) ?? this.selections.get(identity);
  }

  exit(identity: string): void {
    if (this.isExitBlocked(identity)) return;
    const before = this.occupiedTabs();
    this.selections.delete(identity);
    this.notifyOccupation(before);
  }

  setExitBlocked(identity: string, mode: string, blocked: boolean): void {
    const before = this.occupiedTabs();
    if (blocked) {
      this.blocked.set(identity, mode);
      this.selections.set(identity, mode);
    } else if (this.blocked.get(identity) === mode) {
      this.blocked.delete(identity);
    } else return;
    this.persistLocks(Object.fromEntries(this.blocked));
    this.notifyOccupation(before);
  }

  isExitBlocked(identity: string): boolean {
    return this.blocked.has(identity);
  }

  isTabCloseBlocked(sessionKey: string, workspacePath: string): boolean {
    const identity = this.identities.get(JSON.stringify([workspacePath, sessionKey]));
    return identity !== undefined && this.isExitBlocked(identity);
  }

  hasTabMode(sessionKey: string, workspacePath: string): boolean {
    const identity = this.identities.get(JSON.stringify([workspacePath, sessionKey]));
    return identity !== undefined && this.selected(identity) !== undefined;
  }

  removeMode(mode: string): void {
    const before = this.occupiedTabs();
    for (const [identity, selected] of this.selections) {
      if (selected === mode) this.selections.delete(identity);
    }
    this.notifyOccupation(before);
  }
}

function readStringMap(key: string): Record<string, string> {
  return readStoredJson<Record<string, string>>(key, (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === "string"))
      : null,
  ) ?? {};
}

let sharedState: ConversationModeState | undefined;
const identityKey = "ccgui.plugin-conversation-identities:v1";
const lockKey = "ccgui.plugin-conversation-locks:v1";
function createSharedState(identities: Record<string, string>, locks: Record<string, string>) {
  return new ConversationModeState(identities,
    (value) => writeStored(identityKey, JSON.stringify(value)), locks,
    (value) => writeStored(lockKey, JSON.stringify(value)));
}

export function getConversationModeState(): ConversationModeState {
  return sharedState ??= createSharedState(readStringMap(identityKey), readStringMap(lockKey));
}

const unregisterCheckpoint = registerRuntimeCheckpointParticipant({
  id: "plugin-conversation-modes",
  capture: () => getConversationModeState().captureCheckpoint(),
  restore(value) {
    // The boot checkpoint is authoritative. No storage reads/writes on restore.
    const state = sharedState ?? createSharedState({}, {});
    state.restoreCheckpoint(value);
    sharedState = state;
  },
});
if (import.meta.hot) import.meta.hot.dispose(unregisterCheckpoint);
