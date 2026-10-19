import { cursorLaunchModel } from "@/components/application/ai-chat/cursor-models";
import type { Message } from "@/lib/ipc";
import { sessionKey as toSessionKey, useChatStore, type ActiveSession } from "@/features/chat/store";
import {
  resolveLiveSessionKey,
  resolveLiveSessionTab,
  resolveSessionEffort,
  resolveSessionModel,
  resolveSessionProvider,
} from "@/features/chat/store/stream";

/** Parent settings inherited by a side run. Native history reuse can reduce
 *  repeated context work; provider cache hits are not guaranteed. */
export interface SideLaunchParams {
  sessionKey: string;
  engine: string;
  workspacePath: string;
  parentSessionId: string | null;
  parentMessages: Message[];
  model: string | null;
  effort: string | null;
  providerId: string | null;
}

type ChatState = ReturnType<typeof useChatStore.getState>;

/** Resolve the live parent tab + launch settings from the current chat store.
 *  Returns null when there is no active parent session. */
export function resolveSideLaunch(
  active: ActiveSession | null,
  state: ChatState = useChatStore.getState(),
): SideLaunchParams | null {
  const liveActive = resolveLiveSessionTab(active, state.openTabs);
  if (!liveActive) return null;
  const liveKey = resolveLiveSessionKey(
    toSessionKey(liveActive.engine, liveActive.sessionId, liveActive.workspacePath),
    state.openTabs,
  );
  const sessionState = state.bySession[liveKey];
  const storedModel =
    resolveSessionModel(liveActive, sessionState, state.models[liveActive.engine]) || null;
  const model =
    liveActive.engine === "cursor" ? cursorLaunchModel(storedModel) : storedModel;
  const effort =
    resolveSessionEffort(
      liveActive,
      sessionState,
      state.efforts[liveActive.engine],
      state.models[liveActive.engine],
    ) ?? null;
  const providerId =
    resolveSessionProvider(liveActive, sessionState, state.providers[liveActive.engine]) ?? null;
  return {
    sessionKey: liveKey,
    engine: liveActive.engine,
    workspacePath: liveActive.workspacePath,
    parentSessionId: liveActive.sessionId,
    parentMessages: sessionState?.messages ?? [],
    model,
    effort,
    providerId,
  };
}
