import { ipc } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import type { ChatStore } from "./types";
import { writeSettingsPatch } from "./settings-persist";

// Only this switch's writes are serialized. Pending values protect a newer
// local pick from a sessions-changed refresh emitted by an older write.
let writes = Promise.resolve();
let nextWrite = 0;
const pending = new Map<string, { id: number; enabled: boolean }>();

export function claudeUltracodeWriteVersion(): number {
  return nextWrite;
}

export function pendingClaudeUltracode(sessionId?: string): boolean | undefined {
  return pending.get(sessionId ?? "default")?.enabled;
}

export function snapshotPendingClaudeUltracode(): Map<string, boolean> {
  return new Map([...pending].map(([key, value]) => [key, value.enabled]));
}

export function persistClaudeUltracode(
  set: (update: () => Pick<ChatStore, "actionError">) => void,
  enabled: boolean,
  sessionId?: string,
): Promise<void> {
  const key = sessionId ?? "default";
  const id = ++nextWrite;
  pending.set(key, { id, enabled });
  set(() => ({ actionError: null }));
  const result = writes.then(async () => {
    if (sessionId) {
      await ipc.rememberClaudeUltracode(sessionId, enabled);
    } else {
      await writeSettingsPatch(() => ({ defaultClaudeUltracode: enabled }));
    }
  }).catch((error) => {
    if (pending.get(key)?.id === id) set(() => ({ actionError: errorText(error) }));
  }).finally(() => {
    if (pending.get(key)?.id === id) pending.delete(key);
  });
  writes = result;
  return result;
}
