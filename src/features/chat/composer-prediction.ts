/**
 * Post-turn composer next-prompt prediction, uniformly powered by Codex GPT
 * across all CCGUI chat engines/channels.
 *
 * After an assistant reply settles without interruption or pending interactive
 * cards, the recent conversation turns are sent to `ipc.predictNextPrompt`.
 * When the suggestion arrives and the session is still idle, it is stored per
 * `sessionKey`, retained across restarts, and rendered as ghost text in an
 * empty composer (accepted via `Tab`, dismissed via `Escape`, never auto-submitted).
 */

import { ipc, type Message, type PredictionTurn } from "@/lib/ipc";
import { readStoredBool, readStoredJson, writeStored } from "@/lib/storage";

const ENABLED_KEY = "ccgui-next.composerPredictionEnabled";
const PREDICTIONS_KEY = "ccgui-next.composerPredictions:v1";
const CHANGED_EVENT = "ccgui-next:composer-prediction-changed";
const MAX_PREDICTIONS = 200;
// The native predictor returns at most 120 Unicode characters (240 UTF-16 units).
const MAX_PREDICTION_LENGTH = 240;

export interface ComposerPredictionSnapshot { readonly id: number; readonly text: string }
const predictions = new Map<string, ComposerPredictionSnapshot>();
const predictionTurnBindings = new Map<string, string>();
const unverifiedPredictions = new Set<string>();
let predictionsLoaded = false;
let nextPredictionId = 0;
let nextRequestToken = 0;
const requestTokens = new Map<string, number>();
const inFlightTurnFingerprints = new Map<string, string>();
const settledTurnFingerprints = new Map<string, string>();
const idleChecks = new Map<string, () => boolean>();

function loadPredictions(): void {
  if (predictionsLoaded) return;
  predictionsLoaded = true;
  if (!isComposerPredictionEnabled()) return;
  const stored = readStoredJson(PREDICTIONS_KEY, (value) => Array.isArray(value) ? value : null);
  for (const entry of stored?.slice(-MAX_PREDICTIONS) ?? []) {
    // Old two-field records have no turn evidence and cannot be restored safely.
    if (!Array.isArray(entry) || entry.length !== 3) continue;
    const [key, text, binding] = entry;
    if (typeof key !== "string" || !key || key.length > 4096 ||
        typeof text !== "string" || !text.trim() ||
        text.length > MAX_PREDICTION_LENGTH || /[\r\n]/.test(text) ||
        typeof binding !== "string" || binding.length > 96 ||
        !/^v1:\d+:\d+:[0-9a-f]{1,8}:[0-9a-f]{1,8}$/.test(binding)) continue;
    // Generation identities belong to this process; never restore old ids or
    // in-flight requests. Only the ready suggestion is durable.
    predictions.set(key, predictionSnapshot(text.trim()));
    predictionTurnBindings.set(key, binding);
    unverifiedPredictions.add(key);
  }
}

function persistPredictions(): void {
  while (predictions.size > MAX_PREDICTIONS) {
    const key = predictions.keys().next().value!;
    predictions.delete(key);
    predictionTurnBindings.delete(key);
    unverifiedPredictions.delete(key);
  }
  writeStored(PREDICTIONS_KEY, JSON.stringify(
    Array.from(predictions).flatMap(([key, prediction]) => {
      const binding = predictionTurnBindings.get(key);
      return binding ? [[key, prediction.text, binding]] : [];
    }),
  ));
}

function notifyChanged(): void {
  // Save synchronously with mutations, including dismiss/accept, so closing
  // immediately afterwards cannot revive a consumed suggestion on restart.
  if (predictionsLoaded) persistPredictions();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  }
}

function predictionTurnsFingerprint(turns: readonly PredictionTurn[]): string {
  const last = turns[turns.length - 1];
  if (!last) return "";
  const assistant = last.assistant ?? "";
  // A bounded content digest keeps conversation text out of persisted metadata.
  // Ignore older page length, seq and timestamps: live/history loaders can
  // represent the same final turn with different pagination and row identities.
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (const part of [last.user, assistant]) {
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x5bd1e995);
    }
  }
  return `v1:${last.user.length}:${assistant.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

/** Master switch for post-turn composer prompt prediction (default: on). */
export function isComposerPredictionEnabled(): boolean {
  return readStoredBool(ENABLED_KEY, true);
}

export function setComposerPredictionEnabled(enabled: boolean): void {
  writeStored(ENABLED_KEY, enabled ? "1" : "0");
  if (!enabled) {
    predictionsLoaded = true;
    predictions.clear();
    predictionTurnBindings.clear();
    unverifiedPredictions.clear();
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
  return getComposerPredictionSnapshot(sessionKey)?.text ?? null;
}

/** Ephemeral generation identity for consumers that must not dismiss a newer
 * prediction with the same text after a turn or session transition. */
export function getComposerPredictionSnapshot(sessionKey?: string): ComposerPredictionSnapshot | null {
  if (!sessionKey || !isComposerPredictionEnabled()) return null;
  loadPredictions();
  if (unverifiedPredictions.has(sessionKey)) return null;
  return predictions.get(sessionKey) ?? null;
}

/** Validate saved suggestions against the actual loaded latest turn before
 * exposing them. A history refresh also revokes requests for an older turn. */
export function reconcileComposerPrediction(sessionKey: string, messages: readonly Message[]): void {
  if (!sessionKey) return;
  loadPredictions();
  if (!messages.length) return; // An unloaded history shell proves nothing.
  const binding = predictionTurnBindings.get(sessionKey);
  const inFlight = inFlightTurnFingerprints.get(sessionKey);
  const settled = settledTurnFingerprints.get(sessionKey);
  if (!predictions.has(sessionKey) && !inFlight && !settled) return;
  const current = predictionTurnsFingerprint(extractPredictionTurns(messages));
  if ((predictions.has(sessionKey) && (!binding || binding !== current)) ||
      (inFlight && inFlight !== current) || (settled && settled !== current)) {
    clearComposerPrediction(sessionKey, { resetTurn: true });
    return;
  }
  if (unverifiedPredictions.delete(sessionKey)) {
    settledTurnFingerprints.set(sessionKey, current);
    notifyChanged();
  }
}

function predictionSnapshot(text: string): ComposerPredictionSnapshot {
  if (nextPredictionId >= Number.MAX_SAFE_INTEGER) throw new Error("Composer prediction identity exhausted");
  return Object.freeze({ id: ++nextPredictionId, text });
}

function newRequestToken(): number {
  if (nextRequestToken >= Number.MAX_SAFE_INTEGER) throw new Error("Composer prediction request identity exhausted");
  return ++nextRequestToken;
}

/** Suggestions without source messages are runtime-only; durable suggestions
 * must carry enough evidence to verify the originating turn after a restart. */
export function setComposerPrediction(
  sessionKey: string,
  suggestion: string | null,
  sourceMessages?: readonly Message[],
): void {
  if (!sessionKey) return;
  loadPredictions();
  const clean = suggestion?.trim() ?? "";
  const prev = predictions.get(sessionKey)?.text ?? null;
  if (!clean) {
    if (prev === null) return;
    predictions.delete(sessionKey);
    predictionTurnBindings.delete(sessionKey);
    unverifiedPredictions.delete(sessionKey);
    notifyChanged();
    return;
  }
  const binding = sourceMessages ? predictionTurnsFingerprint(extractPredictionTurns(sourceMessages)) : undefined;
  if (!isComposerPredictionEnabled() || (prev === clean && predictionTurnBindings.get(sessionKey) === binding &&
      !unverifiedPredictions.has(sessionKey))) return;
  predictions.delete(sessionKey);
  predictions.set(sessionKey, predictionSnapshot(clean));
  if (binding) predictionTurnBindings.set(sessionKey, binding);
  else predictionTurnBindings.delete(sessionKey);
  unverifiedPredictions.delete(sessionKey);
  notifyChanged();
}

/** Cancel any in-flight prediction request and clear stored ghost text for `sessionKey`. */
export function clearComposerPrediction(
  sessionKey?: string,
  options?: { resetTurn?: boolean },
): void {
  if (!sessionKey) return;
  loadPredictions();
  requestTokens.set(sessionKey, newRequestToken());
  inFlightTurnFingerprints.delete(sessionKey);
  idleChecks.delete(sessionKey);
  if (options?.resetTurn) {
    settledTurnFingerprints.delete(sessionKey);
  }
  predictionTurnBindings.delete(sessionKey);
  unverifiedPredictions.delete(sessionKey);
  if (predictions.delete(sessionKey)) {
    notifyChanged();
  }
}

export function migrateComposerPredictionSessionKey(fromKey: string, toKey: string): void {
  if (!fromKey || !toKey || fromKey === toKey) return;
  loadPredictions();
  requestTokens.set(fromKey, newRequestToken());
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
      const binding = predictionTurnBindings.get(fromKey);
      if (binding) predictionTurnBindings.set(toKey, binding);
      if (unverifiedPredictions.has(fromKey)) unverifiedPredictions.add(toKey);
    }
    predictionTurnBindings.delete(fromKey);
    unverifiedPredictions.delete(fromKey);
    notifyChanged();
  }
}

export function clearAllComposerPredictions(): void {
  predictionsLoaded = true;
  predictions.clear();
  predictionTurnBindings.clear();
  unverifiedPredictions.clear();
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
  let skipUnsupportedTurn = false;
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.text.trim();
      if (!text || text.startsWith("/")) {
        skipUnsupportedTurn = true;
        continue;
      }
      skipUnsupportedTurn = false;
      turns.push({ user: text });
    } else if (message.role === "assistant") {
      if (skipUnsupportedTurn) continue;
      const text = message.text.trim();
      if (!text || turns.length === 0) continue;
      turns[turns.length - 1].assistant = text;
    }
  }
  if (skipUnsupportedTurn) return [];
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
  const token = newRequestToken();
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
      setComposerPrediction(sessionKey, clean, messages);
    })
    .catch(() => {
      if (requestTokens.get(sessionKey) === token) {
        inFlightTurnFingerprints.delete(sessionKey);
        idleChecks.delete(sessionKey);
      }
    });
}
