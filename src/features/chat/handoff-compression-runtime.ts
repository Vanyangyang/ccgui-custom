import type { HostHandoffApi, HostHandoffPreferences, HostHandoffRequest, HostHandoffSelection, HostHandoffSnapshot } from "@ccgui/plugin-sdk";
import { isHandoffCompressionSelection } from "./handoff-preferences";
import { runtimeCheckpoint } from "@/lib/runtime-checkpoint";
import { formatHandoffError } from "./handoff-error";
import { isNativeHandoffProgress, nativeHandoffProgressAdvances, type HandoffProgressCallback } from "@/lib/handoff-progress";

export interface HandoffCompressionRuntimeDependencies {
  scope: string;
  load(handoffId: string): Promise<unknown>;
  save(handoffId: string, value: unknown): Promise<void>;
  preferences(): HostHandoffPreferences;
  submit(input: HostHandoffRequest, selection: HostHandoffSelection, onProgress?: HandoffProgressCallback): Promise<string>;
  checkpoint?: Pick<typeof runtimeCheckpoint, "assertAllowed" | "registerBlocker">;
}

const copy = <T>(value: T): T => structuredClone(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const terminal = (snapshot: HostHandoffSnapshot) => ["completed", "failed", "discarded"].includes(snapshot.status);
const diagnostic = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 2000);
const advances = nativeHandoffProgressAdvances;
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid handoff fields");
}
function request(value: unknown): asserts value is HostHandoffRequest {
  fields(value, ["handoffId", "requestId", "expectedRevision", "text", "title", "childContext", "selection", "source"]);
  if (value.selection !== undefined && !isHandoffCompressionSelection(value.selection)) throw new Error("Invalid handoff selection");
  if (value.source !== undefined) {
    fields(value.source, ["kind", "conversationRequestId", "expectedRevision", "approvalId", "approvalRequestId", "sourceStamp"]);
    const source = value.source;
    if (source.kind === "coordinator") fields(source, ["kind", "conversationRequestId", "expectedRevision"]);
    if (!["managedChild", "coordinator"].includes(String(source.kind)) || !bounded(source.conversationRequestId, 128) || !/^[A-Za-z0-9._:-]+$/.test(source.conversationRequestId) ||
      !revision(source.expectedRevision) || source.expectedRevision < 1 ||
      source.kind === "managedChild" && (!bounded(source.approvalId, 4096) || !source.approvalId || !bounded(source.approvalRequestId, 4096) || !source.approvalRequestId ||
        typeof source.sourceStamp !== "string" || !/^[a-f0-9]{64}$/.test(source.sourceStamp)) || value.text !== undefined || value.childContext !== undefined) throw new Error("Invalid handoff source");
  }
  if (!id(value.handoffId) || !id(value.requestId) || !revision(value.expectedRevision) ||
    value.source === undefined && (!bounded(value.text, 48000) || !value.text.trim()) ||
    value.title !== undefined && !bounded(value.title, 512) ||
    value.childContext !== undefined && !bounded(value.childContext, 6000)) throw new Error("Invalid handoff request");
}
interface Entry { snapshot: HostHandoffSnapshot; inputHash: string; baseRevision: number }
function persisted(value: unknown, handoffId: string): Entry {
  fields(value, ["snapshot", "inputHash", "baseRevision"]);
  fields(value.snapshot, ["handoffId", "requestId", "revision", "status", "selection", "summary", "error", "startedAt", "progress"]);
  const snapshot = value.snapshot;
  if (snapshot.startedAt !== undefined && (!Number.isSafeInteger(snapshot.startedAt) || Number(snapshot.startedAt) <= 0)) throw new Error("Invalid persisted handoff start time");
  if (snapshot.progress !== undefined) {
    fields(snapshot.progress, ["phase", "completed", "total", "round", "updatedAt", "timing"]);
    const { updatedAt, ...progress } = snapshot.progress;
    if (!Number.isSafeInteger(updatedAt) || Number(updatedAt) <= 0 || !isNativeHandoffProgress(progress)) throw new Error("Invalid persisted handoff progress");
  }
  fields(snapshot.selection, ["engine", "model", "providerId", "effort"]);
  if (snapshot.handoffId !== handoffId || !id(snapshot.requestId) || !revision(snapshot.revision) ||
    !revision(value.baseRevision) || snapshot.revision <= value.baseRevision || !isHandoffCompressionSelection(snapshot.selection) ||
    !["running", "completed", "failed", "unknown", "discarded"].includes(String(snapshot.status)) ||
    !bounded(value.inputHash, 64) || !/^[a-f0-9]{64}$/.test(value.inputHash) ||
    snapshot.summary !== undefined && !bounded(snapshot.summary, 48000) ||
    snapshot.error !== undefined && !bounded(snapshot.error, 2000)) throw new Error("Invalid persisted handoff identity");
  return copy(value) as unknown as Entry;
}

export function createHandoffCompressionRuntime(deps: HandoffCompressionRuntimeDependencies): HostHandoffApi {
  const checkpoint = deps.checkpoint ?? runtimeCheckpoint;
  const entries = new Map<string, Entry>();
  const queues = new Map<string, Promise<unknown>>();
  const preparing = new Set<string>();
  const flights = new Set<string>();
  const listeners = new Set<(snapshot: HostHandoffSnapshot) => void>();
  checkpoint.registerBlocker(deps.scope, () => preparing.size || flights.size ? ["handoff-native-submission"] : []);
  const notify = (entry: Entry) => { for (const listener of listeners) { try { listener(copy(entry.snapshot)); } catch { /* A listener cannot break native ownership. */ } } };
  const persist = (entry: Entry) => deps.save(entry.snapshot.handoffId, copy(entry));
  const prune = () => {
    const settled = [...entries].filter(([key, entry]) => terminal(entry.snapshot) && !flights.has(key) && !preparing.has(key));
    for (const [key] of settled.slice(0, Math.max(0, settled.length - 64))) entries.delete(key);
  };
  const serial = <T>(handoffId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(handoffId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    queues.set(handoffId, result);
    void result.finally(() => { if (queues.get(handoffId) === result) queues.delete(handoffId); prune(); }).catch(() => undefined);
    return result;
  };
  const load = async (handoffId: string) => {
    const cached = entries.get(handoffId);
    if (cached) return cached;
    const raw = await deps.load(handoffId);
    if (raw == null) return undefined;
    const entry = persisted(raw, handoffId);
    if (entry.snapshot.status === "running" && !flights.has(handoffId)) {
      entry.snapshot = { ...entry.snapshot, revision: entry.snapshot.revision + 1, status: "unknown", error: "Native handoff outcome is unknown after reload; inspect or discard it, do not replay." };
      await persist(entry);
    }
    entries.set(handoffId, entry);
    return entry;
  };
  const preferences = (): HostHandoffPreferences => {
    const value = deps.preferences();
    if (!isHandoffCompressionSelection(value.selection)) throw new Error("Invalid host handoff preferences");
    return { enabled: value.enabled === true, selection: copy(value.selection) };
  };
  const finish = (handoffId: string, requestId: string, result: { summary: string } | { error: string }) => serial(handoffId, async () => {
    const entry = entries.get(handoffId);
    if (!entry || entry.snapshot.requestId !== requestId || entry.snapshot.status !== "running") return;
    // A recovered owner may have discarded or replaced this generation while
    // its old native flight was still returning. Do not revive that result.
    try {
      const raw = await deps.load(handoffId);
      if (raw != null) {
        const durable = persisted(raw, handoffId);
        if (durable.snapshot.requestId !== requestId || terminal(durable.snapshot)) {
          entries.set(handoffId, durable); notify(durable); return;
        }
        entry.snapshot = { ...entry.snapshot, revision: Math.max(entry.snapshot.revision, durable.snapshot.revision) };
      }
    } catch (error) {
      entry.snapshot = { ...entry.snapshot, revision: entry.snapshot.revision + 1, status: "unknown", error: `Handoff result ownership could not be checked: ${diagnostic(error)}`.slice(0, 2000) };
      notify(entry); return;
    }
    entry.snapshot = { ...entry.snapshot, revision: entry.snapshot.revision + 1,
      ...("summary" in result ? { status: "completed" as const, summary: result.summary } : { status: "failed" as const, error: result.error }) };
    try { await persist(entry); }
    catch (error) {
      entry.snapshot = { ...entry.snapshot, status: "unknown", error: `Handoff result could not be saved: ${diagnostic(error)}`.slice(0, 2000) };
    }
    notify(entry);
  });
  return {
    preferences: async () => preferences(),
    async summarize(input) {
      request(input);
      const accepted = copy(input);
      return serial(accepted.handoffId, async () => {
        checkpoint.assertAllowed();
        preparing.add(accepted.handoffId);
        try {
          const old = await load(accepted.handoffId);
          // Preserve legacy request hashes; new source/selection fields are
          // included only when supplied so changing a compressor cannot reuse an ID.
          const bytes = new TextEncoder().encode(JSON.stringify([accepted.text ?? null, accepted.title ?? null, accepted.childContext ?? null,
            ...(accepted.selection || accepted.source ? [accepted.selection ?? null, accepted.source ?? null] : [])]));
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const inputHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
          if (old?.snapshot.requestId === accepted.requestId) {
            if (old.inputHash !== inputHash || old.baseRevision !== accepted.expectedRevision) throw new Error("Handoff request ID reused with different input");
            return copy(old.snapshot);
          }
          if ((old?.snapshot.revision ?? 0) !== accepted.expectedRevision) throw new Error("Stale handoff revision");
          if (flights.has(accepted.handoffId) || old && ["running", "unknown"].includes(old.snapshot.status)) throw new Error("Handoff is still running or unknown; inspect or discard before a new request");
          const entry: Entry = { inputHash, baseRevision: accepted.expectedRevision,
            snapshot: { handoffId: accepted.handoffId, requestId: accepted.requestId, revision: accepted.expectedRevision + 1,
              status: "running", selection: copy(accepted.selection ?? preferences().selection), startedAt: Date.now() } };
          checkpoint.assertAllowed();
          // No native call can happen until its exact identity is durable.
          await persist(entry);
          entries.set(accepted.handoffId, entry);
          try { checkpoint.assertAllowed(); }
          catch (error) { await finishBeforeSubmit(entry, error); throw error; }
          flights.add(accepted.handoffId);
          const snapshot = copy(entry.snapshot);
          notify(entry);
          // Native owns its bounded timeout. Discard is intentionally not a
          // cancellation claim and cannot release this flight's blocker early.
          const onProgress: HandoffProgressCallback = progress => {
            if (!isNativeHandoffProgress(progress) || !flights.has(accepted.handoffId) || entries.get(accepted.handoffId) !== entry ||
              entry.snapshot.status !== "running" || entry.snapshot.requestId !== accepted.requestId || !advances(entry.snapshot.progress, progress)) return;
            const updatedAt = Math.max(Date.now(), entry.snapshot.progress?.updatedAt ?? 0);
            entry.snapshot = { ...entry.snapshot, progress: { ...copy(progress), updatedAt } };
            // Display-only updates do not advance business revisions or write
            // every stage to storage. Accepted identity remains the replay fence.
            notify(entry);
          };
          void Promise.resolve().then(() => { checkpoint.assertAllowed(); return deps.submit(accepted, copy(entry.snapshot.selection), onProgress); }).then(value => {
            if (!bounded(value, 48000) || !value.trim()) throw new Error("Native handoff returned an invalid summary");
            return finish(accepted.handoffId, accepted.requestId, { summary: value });
          }).catch(error => finish(accepted.handoffId, accepted.requestId, { error: formatHandoffError(error).slice(0, 2000) }))
            .finally(() => { flights.delete(accepted.handoffId); prune(); });
          return snapshot;
        } finally { preparing.delete(accepted.handoffId); }
      });
    },
    inspect(handoffId) {
      if (!id(handoffId)) return Promise.reject(new Error("Invalid handoff ID"));
      return serial(handoffId, async () => { const entry = await load(handoffId); return entry ? copy(entry.snapshot) : null; });
    },
    discard(handoffId, requestId) {
      if (!id(handoffId) || !id(requestId)) return Promise.reject(new Error("Invalid handoff identity"));
      return serial(handoffId, async () => {
        const entry = await load(handoffId);
        if (!entry) return null;
        if (entry.snapshot.requestId !== requestId) throw new Error("Handoff request identity mismatch");
        if (entry.snapshot.status === "discarded") return copy(entry.snapshot);
        const discarded: Entry = { ...entry, snapshot: { handoffId, requestId, revision: entry.snapshot.revision + 1, selection: copy(entry.snapshot.selection), status: "discarded" } };
        // Mark in memory before awaiting storage, so a rejected save still
        // cannot expose output that this caller explicitly abandoned.
        entries.set(handoffId, discarded);
        try { await persist(discarded); } catch (error) { discarded.snapshot = { ...discarded.snapshot, error: `Discard could not be saved: ${diagnostic(error)}`.slice(0, 2000) }; notify(discarded); throw error; }
        notify(discarded); return copy(discarded.snapshot);
      });
    },
    onEvent(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
  };

  async function finishBeforeSubmit(entry: Entry, error: unknown) {
    entry.snapshot = { ...entry.snapshot, revision: entry.snapshot.revision + 1, status: "failed", error: diagnostic(error) };
    try { await persist(entry); } finally { notify(entry); }
  }
}
