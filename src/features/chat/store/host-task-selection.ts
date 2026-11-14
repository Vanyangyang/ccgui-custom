import { resolveSessionModel, resolveSessionEffort, resolveSessionProvider, type SessionState } from "./stream";
import type { ActiveSession } from "./persistence";

export interface HostLaunchChoices {
  model?: string;
  effort?: string;
  providerId?: string;
  /** Per-run override supplied by an explicitly configured coordinator. */
  codexServiceTierOverride?: "default" | "priority";
  defaultModel?: string | null;
  defaultEffort?: string | null;
  defaultProvider?: string | null;
  /** Per-continuation fence, including an absent native choice. Not persisted
   * as the original task's launch configuration. */
  expectedNativeSelection?: { model: string | null; effort: string | null; providerId: string | null };
}

/** Existing chats must prove their retained choices, never inherit task defaults. */
export function matchesHostTaskSelection(tab: ActiveSession, session: SessionState | undefined, launch: HostLaunchChoices): boolean {
  if (launch.expectedNativeSelection) {
    const expected = launch.expectedNativeSelection;
    if ((resolveSessionModel(tab, session) ?? null) !== expected.model ||
      (resolveSessionEffort(tab, session) ?? null) !== expected.effort ||
      (resolveSessionProvider(tab, session) ?? null) !== expected.providerId) return false;
  }
  return (launch.model === undefined || resolveSessionModel(tab, session) === launch.model) &&
    (launch.effort === undefined || resolveSessionEffort(tab, session) === launch.effort) &&
    (launch.providerId === undefined || resolveSessionProvider(tab, session) === launch.providerId);
}
