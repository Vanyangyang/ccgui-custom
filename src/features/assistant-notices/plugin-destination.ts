import type { AssistantNoticeSource } from "./types";

export type NoticeDestinationSource = Pick<AssistantNoticeSource, "engine" | "sessionId" | "workspacePath">;
export interface PluginNoticeDelivery {
  source: NoticeDestinationSource;
  requestId: string;
  noticeId: string;
  action: "open" | "draft";
  text?: string;
  signal: AbortSignal;
}
export interface PluginNoticeDestination {
  /** Returns a proven plugin-owned coordinator request, or null for another source. */
  resolve(source: NoticeDestinationSource): Promise<string | null>;
  deliver(request: PluginNoticeDelivery): Promise<boolean>;
  present(): Promise<{ windowId?: string }>;
}

const destinations = new Map<symbol, PluginNoticeDestination>();

/** Registration is owned by a loaded center tab and removed with that tab. */
export function registerPluginNoticeDestination(destination: PluginNoticeDestination): () => void {
  const key = Symbol();
  destinations.set(key, destination);
  return () => { destinations.delete(key); };
}

/** Never choose between two claims for the same source or fall back after a
 * claimant fails verification. A stale disposer cannot target a new owner. */
export async function resolvePluginNoticeDestination(source: NoticeDestinationSource): Promise<{
  requestId: string;
  deliver(request: PluginNoticeDelivery): Promise<boolean>;
  present(): Promise<{ windowId?: string }>;
} | null> {
  const matches: Array<{ key: symbol; destination: PluginNoticeDestination; requestId: string }> = [];
  for (const [key, destination] of [...destinations]) {
    const requestId = await destination.resolve(source);
    if (destinations.get(key) !== destination) continue;
    if (requestId) matches.push({ key, destination, requestId });
  }
  if (matches.length > 1) throw new Error("Ambiguous plugin notice destination");
  const match = matches[0];
  if (!match) return null;
  const current = () => destinations.get(match.key) === match.destination;
  return {
    requestId: match.requestId,
    async deliver(request) { if (!current()) throw new Error("Plugin notice destination unavailable"); return match.destination.deliver(request); },
    async present() { if (!current()) throw new Error("Plugin notice destination unavailable"); return match.destination.present(); },
  };
}
