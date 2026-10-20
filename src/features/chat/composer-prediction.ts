/**
 * Post-turn composer next-prompt prediction, uniformly powered by Codex GPT
 * across all CCGUI chat engines/channels.
 *
 * After an assistant reply settles without interruption or pending interactive
 * cards, the recent conversation turns are sent to `ipc.predictNextPrompt`.
 * When the suggestion arrives and the session is still idle, it is stored per
 * `sessionKey` and rendered as ghost text in an empty composer (accepted via
 * `Tab`, dismissed via `Escape`, never auto-submitted).
 */

import { ipc, type Message, type PredictionTurn } from "@/lib/ipc";
import { readStoredBool, writeStored } from "@/lib/storage";

const ENABLED_KEY = "ccgui-next.composerPredictionEnabled";
const CHANGED_EVENT = "ccgui-next:composer-prediction-changed";

const predictions = new Map<string, string>();
const requestTokens = new Map<string, number>();
const inFlightTurnFingerprints = new Map<string, string>();
const settledTurnFingerprints = new Map<string, string>();
const idleChecks = new Map<string, () => boolean>();

function notifyChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  }
}

function predictionTurnsFingerprint(turns: readonly PredictionTurn[]): string {
  const last = turns[turns.length - 1];
  if (!last) return "";
  return `${turns.length}\u0000${last.user}\u0000${last.assistant ?? ""}`;
}

/** Master switch for post-turn composer prompt prediction (default: on). */
export function isComposerPredictionEnabled(): boolean {
  return readStoredBool(ENABLED_KEY, true);
}

export function setComposerPredictionEnabled(enabled: boolean): void {
  writeStored(ENABLED_KEY, enabled ? "1" : "0");
  if (!enabled) {
    predictions.clear();
    requestTokens.clear();
    inFlightTurnFingerprints.clear();
    settledTurnFingerprints.clear();
    idleChecks.clear();
  }
  notifyChanged();
}

export function subscribeComposerPrediction(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}

export function getComposerPrediction(sessionKey?: string): string | null {
  if (!sessionKey || !isComposerPredictionEnabled()) return null;
  return predictions.get(sessionKey) ?? null;
}

export function setComposerPrediction(sessionKey: string, suggestion: string | null): void {
  if (!sessionKey) return;
  const clean = suggestion?.trim() ?? "";
  const prev = predictions.get(sessionKey) ?? null;
  if (!clean) {
    if (prev === null) return;
    predictions.delete(sessionKey);
    notifyChanged();
    return;
  }
  if (!isComposerPredictionEnabled() || prev === clean) return;
  predictions.set(sessionKey, clean);
  notifyChanged();
}

/** Cancel any in-flight prediction request and clear stored ghost text for `sessionKey`. */
export function clearComposerPrediction(
  sessionKey?: string,
  options?: { resetTurn?: boolean },
): void {
  if (!sessionKey) return;
  requestTokens.set(sessionKey, (requestTokens.get(sessionKey) ?? 0) + 1);
  inFlightTurnFingerprints.delete(sessionKey);
  idleChecks.delete(sessionKey);
  if (options?.resetTurn) {
    settledTurnFingerprints.delete(sessionKey);
  }
  if (predictions.delete(sessionKey)) {
    notifyChanged();
  }
}

export function migrateComposerPredictionSessionKey(fromKey: string, toKey: string): void {
  if (!fromKey || !toKey || fromKey === toKey) return;
  requestTokens.set(fromKey, (requestTokens.get(fromKey) ?? 0) + 1);
  inFlightTurnFingerprints.delete(fromKey);
  idleChecks.delete(fromKey);
  const settled = settledTurnFingerprints.get(fromKey);
  if (settled !== undefined) {
    settledTurnFingerprints.delete(fromKey);
    if (!settledTurnFingerprints.has(toKey)) {
      settledTurnFingerprints.set(toKey, settled);
    }
  }
  const existing = predictions.get(fromKey);
  if (existing !== undefined) {
    predictions.delete(fromKey);
    if (!predictions.has(toKey)) {
      predictions.set(toKey, existing);
    }
    notifyChanged();
  }
}

export function clearAllComposerPredictions(): void {
  predictions.clear();
  requestTokens.clear();
  inFlightTurnFingerprints.clear();
  settledTurnFingerprints.clear();
  idleChecks.clear();
  notifyChanged();
}

/** Extract user/assistant turn pairs from settled session messages. */
export function extractPredictionTurns(messages: readonly Message[]): PredictionTurn[] {
  if (messages.some((m) => m.live)) return [];
  const turns: PredictionTurn[] = [];
  let skipSlashTurn = false;
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.text.trim();
      if (!text) continue;
      if (text.startsWith("/")) {
        skipSlashTurn = true;
        continue;
      }
      skipSlashTurn = false;
      turns.push({ user: text });
    } else if (message.role === "assistant") {
      if (skipSlashTurn) continue;
      const text = message.text.trim();
      if (!text || turns.length === 0) continue;
      turns[turns.length - 1].assistant = text;
    }
  }
  const last = turns[turns.length - 1];
  if (!last || !last.assistant?.trim()) return [];
  return turns;
}

/**
 * Request a next-prompt prediction from Codex GPT for `sessionKey`.
 * Deduplicates by turn fingerprint so repeated triggers for the same settled
 * turn (`turn_complete` followed by `done`, history load, or tab switch) do not
 * cancel an in-flight request or re-query an already-handled turn.
 */
export function requestComposerPrediction(
  sessionKey: string,
  messages: readonly Message[],
  isStillIdle?: () => boolean,
): void {
  if (!sessionKey) return;
  if (!isComposerPredictionEnabled()) {
    clearComposerPrediction(sessionKey);
    return;
  }
  const turns = extractPredictionTurns(messages);
  if (turns.length === 0) {
    clearComposerPrediction(sessionKey);
    return;
  }
  const fingerprint = predictionTurnsFingerprint(turns);
  if (inFlightTurnFingerprints.get(sessionKey) === fingerprint) {
    if (isStillIdle) idleChecks.set(sessionKey, isStillIdle);
    return;
  }
  if (settledTurnFingerprints.get(sessionKey) === fingerprint) {
    return;
  }

  clearComposerPrediction(sessionKey, { resetTurn: true });
  const token = (requestTokens.get(sessionKey) ?? 0) + 1;
  requestTokens.set(sessionKey, token);
  inFlightTurnFingerprints.set(sessionKey, fingerprint);
  if (isStillIdle) {
    idleChecks.set(sessionKey, isStillIdle);
  }

  void ipc
    .predictNextPrompt?.(turns)
    ?.then((suggestion) => {
      if (requestTokens.get(sessionKey) !== token) return;
      inFlightTurnFingerprints.delete(sessionKey);
      const check = idleChecks.get(sessionKey);
      idleChecks.delete(sessionKey);
      if (!isComposerPredictionEnabled()) return;
      if (check && !check()) return;
      settledTurnFingerprints.set(sessionKey, fingerprint);
      const clean = typeof suggestion === "string" ? suggestion.trim() : "";
      if (!clean) return;
      predictions.set(sessionKey, clean);
      notifyChanged();
    })
    .catch(() => {
      if (requestTokens.get(sessionKey) === token) {
        inFlightTurnFingerprints.delete(sessionKey);
        idleChecks.delete(sessionKey);
      }
    });
}
