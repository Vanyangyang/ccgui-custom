import type { ActiveSession } from "./persistence";
import { sessionKey } from "./persistence";
import { effectivePermission } from "./permissions";
import { resolveClaudeHaikuAssist } from "../claude-haiku-assist";
import {
  resolveSessionEffort,
  resolveClaudeUltracode,
  resolveSessionModel,
  resolveSessionProvider,
  runRouting,
  type SessionState,
} from "./stream";
import type { ChatStore } from "./types";

/**
 * Talking to a Claude CLI that is still alive while its background tasks run.
 * The native CLI takes a typed message the moment its reply ends; CC GUI used to
 * queue it until every task finished. These are the rules that decide when a
 * message may go straight into the live process. Stop uses native interrupt
 * regardless of whether the process can accept a direct follow-up.
 */

/** What the live CLI process was launched with. The CLI fixes all four at
 *  launch, so a later pick can only take effect on a new process. */
export interface LiveLaunch {
  /** Launch settings in the picker's spelling (what send_message was given). */
  model: string | null;
  effort: string | null;
  claudeUltracode?: boolean;
  claudeHaikuAssist?: boolean;
  provider: string | null;
  permission: string | null;
  /** What the CLI itself reported for the model / effort it runs (the full
   *  model id, say, where the picker said "opus"). The store follows reports
   *  (activeModel) and then the session refresh follows the remembered picker
   *  spelling again, so the resolved value flips between the two spellings of
   *  the same setting. Both are "unchanged"; only a different pick is a change. */
  reportedModel?: string | null;
  reportedEffort?: string | null;
  /** A directory grant was approved after launch. The CLI cannot widen its
   *  allowed dirs mid-process (--add-dir is launch-only), so this process would
   *  deny the same path again: only a new launch carries the grant. */
  grantedSinceLaunch?: boolean;
}

/** The resolved model is still what this process runs. */
export function runsModel(launch: LiveLaunch, model: string | null): boolean {
  return model === launch.model || (launch.reportedModel != null && model === launch.reportedModel);
}

/** The resolved effort is still what this process runs. */
export function runsEffort(launch: LiveLaunch, effort: string | null): boolean {
  return effort === launch.effort || (launch.reportedEffort != null && effort === launch.reportedEffort);
}

/** A message handed to an idle CLI is picked up within ~100ms. The guard only
 *  has to outlive the same idle cycle's duplicate `waiting` event and the IPC
 *  round trip; 10s is generous and bounded. */
export const FOLLOW_UP_GUARD_MS = 10_000;

/** Coalesce repeated clicks while the CLI handles an interrupt. After this
 *  window another click resends the native request; it never escalates to kill. */
export const INTERRUPT_GRACE_MS = 5_000;

/** The CLI can acknowledge and idle before a double click's second Stop.
 *  Coalesce that click for 1s; a later deliberate Stop sends another native
 *  interrupt. A new reply is immediately eligible for its own Stop. */
export const INTERRUPT_DEBOUNCE_MS = 1_000;

/** True while a delivered follow-up has not yet been confirmed by the CLI.
 *  Timestamp based on purpose: nothing to clean up, and a CLI that never reacts
 *  cannot keep the queue closed for longer than the window. */
export function followUpGuardActive(
  session: Pick<SessionState, "followUpAt"> | undefined,
  now = Date.now(),
): boolean {
  const at = session?.followUpAt;
  return at != null && now - at < FOLLOW_UP_GUARD_MS;
}

/** The values a send would launch with right now, spelled like sendPrompt
 *  resolves them. */
export function resolveLaunchSettings(
  state: Pick<ChatStore, "engines" | "permission" | "models" | "efforts" | "providers"> & Partial<Pick<ChatStore, "defaultClaudeUltracode">>,
  tab: ActiveSession,
  session: SessionState | undefined,
): LiveLaunch {
  const engine = tab.engine;
  return {
    model: resolveSessionModel(tab, session, state.models[engine]) || null,
    effort: resolveSessionEffort(tab, session, state.efforts[engine], state.models[engine]) ?? null,
    claudeUltracode: resolveClaudeUltracode(tab, session, state.defaultClaudeUltracode),
    claudeHaikuAssist: resolveClaudeHaikuAssist(tab),
    provider: resolveSessionProvider(tab, session, state.providers[engine]) ?? null,
    permission: effectivePermission(state.engines, engine, state.permission),
  };
}

/** A card the CLI is parked on (question, directory grant, plan approval). */
export function hasOpenCard(session: Pick<SessionState, "messages">): boolean {
  return session.messages.some(
    (m) =>
      m.question?.status === "pending" ||
      m.grant?.status === "pending" ||
      m.planReview?.status === "awaiting_review" ||
      m.planReview?.status === "deferred" ||
      m.planReview?.status === "submitting",
  );
}

export type LiveBlocker =
  | "engine"
  | "not-streaming"
  | "no-live-run"
  | "killed"
  | "activity"
  | "computer-use"
  | "open-card"
  | "launch-unknown"
  | "grant-after-launch"
  | "settings-changed";

/** Why a message cannot go into the live CLI right now (null = it can).
 *  `activity` is the native state the CLI must be in: "waiting" (idle with
 *  tasks running) for a send, "running" when an interrupt is about to bring it
 *  there. Every blocker keeps today's behavior: the message waits in the queue
 *  until the run ends. */
export function liveFollowUpBlocker(
  state: Pick<ChatStore, "engines" | "permission" | "models" | "efforts" | "providers"> & Partial<Pick<ChatStore, "defaultClaudeUltracode">>,
  tab: ActiveSession,
  session: SessionState | undefined,
  options: { computerUse?: boolean; activity?: "waiting" | "running" } = {},
): LiveBlocker | null {
  if (tab.engine !== "claude") return "engine";
  if (!session?.streaming) return "not-streaming";
  const runId = session.nativeTaskRunId;
  if (!runId || runRouting.get(runId) !== sessionKey(tab.engine, tab.sessionId, tab.workspacePath)) {
    return "no-live-run";
  }
  // The run was retired locally: its events are being dropped.
  if (session.interrupted) return "killed";
  if (session.nativeActivity !== (options.activity ?? "waiting")) return "activity";
  // The driver is mounted at launch; a plain follow-up would run in a process
  // that still holds machine control, and a computer-use message needs one.
  if (options.computerUse || session.activeComputerUse) return "computer-use";
  if (hasOpenCard(session)) return "open-card";
  // A run adopted from another client has no known launch settings.
  if (!session.liveLaunch) return "launch-unknown";
  const launched = session.liveLaunch;
  // Behaves like a launch-setting change: the grant only reaches a new process.
  if (launched.grantedSinceLaunch) return "grant-after-launch";
  const now = resolveLaunchSettings(state, tab, session);
  if (
    !runsModel(launched, now.model) ||
    !runsEffort(launched, now.effort) ||
    now.claudeUltracode !== (launched.claudeUltracode ?? false) ||
    now.claudeHaikuAssist !== (launched.claudeHaikuAssist ?? false) ||
    now.provider !== launched.provider ||
    now.permission !== launched.permission
  ) {
    return "settings-changed";
  }
  return null;
}

/** Codex steering appends input to the current turn. It cannot apply changed
 * launch settings, start computer use, or steer a Desktop-owned/compact turn. */
export function codexSteerBlocker(
  state: Parameters<typeof resolveLaunchSettings>[0],
  tab: ActiveSession,
  session: SessionState | undefined,
  options: { computerUse?: boolean } = {},
): LiveBlocker | null {
  if (tab.engine !== "codex") return "engine";
  if (!session?.streaming) return "not-streaming";
  if (!tab.sessionId || !session.codexRunId ||
      runRouting.get(session.codexRunId) !== sessionKey(tab.engine, tab.sessionId, tab.workspacePath)) return "no-live-run";
  if (session.interrupted || session.queueParked) return "killed";
  if (session.handoff || session.compaction) return "activity";
  if (options.computerUse || session.activeComputerUse) return "computer-use";
  if (hasOpenCard(session)) return "open-card";
  const launched = session.liveLaunch;
  if (!launched) return "launch-unknown";
  if (launched.grantedSinceLaunch) return "grant-after-launch";
  const now = resolveLaunchSettings(state, tab, session);
  if (!runsModel(launched, now.model) || !runsEffort(launched, now.effort) ||
      now.provider !== launched.provider || now.permission !== launched.permission) return "settings-changed";
  return null;
}

/** Coalesce a Stop right behind the one the CLI already acknowledged while
 *  idle; background work is not a second reply to interrupt. */
export function isInterruptEcho(
  session: SessionState | undefined,
  now = Date.now(),
): boolean {
  const at = session?.lastInterruptAt;
  return (
    !!session &&
    session.streaming &&
    !session.interrupted &&
    session.nativeActivity === "waiting" &&
    at != null &&
    now - at < INTERRUPT_DEBOUNCE_MS
  );
}

/** Every live Claude state uses native interrupt, including startup before the
 *  first activity report, idle background waiting and permission prompts.
 *  Computer-use Esc follows this same contract; the driver and hotkey remain
 *  scoped to the live run and are cleaned up when that run actually ends. */
export function usesNativeInterrupt(key: string): boolean {
  return key.startsWith("claude/") || key.startsWith("new:claude:");
}

export function shouldInterruptTurn(session: SessionState | undefined, key: string): boolean {
  const runId = session?.nativeTaskRunId;
  return (
    !!session &&
    usesNativeInterrupt(key) &&
    !!runId &&
    runRouting.get(runId) === key &&
    session.streaming &&
    !session.interrupted
  );
}
