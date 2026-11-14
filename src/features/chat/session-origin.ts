import { invoke, isWeb } from "@/lib/transport";

/** The human sent a message from this chat's composer: lift any
 *  session_create restriction on it (created chats cannot create chats or
 *  message other chats until then). Best-effort and idempotent; chats without
 *  a provenance record are unchanged. Only the main desktop window may call it. */
export function promoteHumanSession(engine: string, sessionId: string | null): void {
  if (!sessionId || isWeb) return;
  void Promise.resolve().then(() => invoke("session_origin_promote", { engine, sessionId })).catch(() => {});
}
