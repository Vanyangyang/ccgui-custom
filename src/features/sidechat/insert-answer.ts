import { useChatStore } from "@/features/chat/store";
import { resolveLiveSessionKey } from "@/features/chat/store/stream";

/** Explicit user insertion appends to the latest draft and never sends it. */
export function insertSideAnswer(sessionKey: string, answer: string) {
  if (!answer.trim()) return;
  const state = useChatStore.getState();
  const key = resolveLiveSessionKey(sessionKey, state.openTabs);
  const draft = state.drafts[key] ?? "";
  state.setDraft(key, draft ? `${draft}\n\n${answer}` : answer);
}
