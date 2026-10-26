import { resolveSessionModel, resolveSessionEffort, resolveSessionProvider, type SessionState } from "./stream";
import type { ActiveSession } from "./persistence";

export interface HostLaunchChoices {
  model?: string;
  effort?: string;
  providerId?: string;
  defaultModel?: string | null;
  defaultEffort?: string | null;
  defaultProvider?: string | null;
}

/** Existing chats must prove their retained choices, never inherit task defaults. */
export function matchesHostTaskSelection(tab: ActiveSession, session: SessionState | undefined, launch: HostLaunchChoices): boolean {
  return (launch.model === undefined || resolveSessionModel(tab, session) === launch.model) &&
    (launch.effort === undefined || resolveSessionEffort(tab, session) === launch.effort) &&
    (launch.providerId === undefined || resolveSessionProvider(tab, session) === launch.providerId);
}
