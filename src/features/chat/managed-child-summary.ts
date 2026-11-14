import type { HostHandoffApi, HostHandoffSnapshot, HostHandoffSelection } from "@ccgui/plugin-sdk";
import { ipc } from "@/lib/ipc";
import { newId } from "@/lib/id";
import { runtimeCheckpoint } from "@/lib/runtime-checkpoint";
import { createHandoffCompressionRuntime } from "./handoff-compression-runtime";
import { readHandoffCompressionPreferences } from "./handoff-preferences";
import { crossSessionParticipantKey, useCrossSessionActivityStore, type CrossSessionCommunicationRecord } from "./cross-session";

const STORAGE_KEY = "ccgui.managed-child-summary:v1";
const LIMIT = 64;
const sameRecord = (a: CrossSessionCommunicationRecord | undefined, b: CrossSessionCommunicationRecord) => !!a &&
  a.status === "awaiting_cost_approval" && a.scopedId === b.scopedId && a.message === b.message &&
  a.leaderCostApproval?.branchId === b.leaderCostApproval?.branchId && a.leaderCostApproval?.requestId === b.leaderCostApproval?.requestId &&
  a.leaderCostApproval?.model === b.leaderCostApproval?.model && crossSessionParticipantKey(a.sender) === crossSessionParticipantKey(b.sender) &&
  crossSessionParticipantKey(a.target) === crossSessionParticipantKey(b.target) && JSON.stringify(a.imageRefs ?? []) === JSON.stringify(b.imageRefs ?? []);

/** The preview page only establishes that a readable source exists. Native owns
 * full-history loading; no page contents or task text enter the runtime request. */
export function managedChildHistoryText(messages: ReadonlyArray<{ role: string; text?: string }>): string {
  return messages.some(row => (row.role === "user" || row.role === "assistant") && row.text?.trim()) ? "managed-child-full-v2" : "";
}

interface Options {
  storage?: Pick<Storage, "getItem" | "setItem">;
  currentRecord?(id: string): CrossSessionCommunicationRecord | undefined;
  summarize?: typeof ipc.summarizeSessionHandoff;
  fullHistorySupported?: typeof ipc.handoffFullHistorySupported;
  preferences?: typeof readHandoffCompressionPreferences;
  checkpoint?: Pick<typeof runtimeCheckpoint, "assertAllowed" | "registerBlocker">;
}
export interface ManagedChildSummaryService extends Pick<HostHandoffApi, "inspect" | "discard" | "onEvent" | "preferences"> {
  prepare(record: CrossSessionCommunicationRecord, text: string, historyVersion: string, isCurrent: () => boolean, retry?: boolean, selection?: HostHandoffSelection): Promise<HostHandoffSnapshot>;
}

/** Host-owned draft preparation only. Native successor creation and transmission
 * remain in the separate human-confirmed managed-child Handoff command. */
export function createManagedChildSummaryService(options: Options = {}): ManagedChildSummaryService {
  const storage = options.storage ?? localStorage;
  const bindings = new Map<string, { record: CrossSessionCommunicationRecord; isCurrent: () => boolean }>();
  const preparing = new Map<string, Promise<HostHandoffSnapshot>>();
  // Discard only abandons the result. A different model must not start another
  // paid call for this source while the abandoned native flight is still alive.
  const sourceFlights = new Map<string, string>();
  const current = options.currentRecord ?? (id => useCrossSessionActivityStore.getState().records.find(record => record.scopedId === id));
  const read = (): Record<string, unknown> => {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !/^managed-[a-f0-9]{64}$/.test(key))) throw new Error("Invalid managed child summary storage");
    return value as Record<string, unknown>;
  };
  const runtime = createHandoffCompressionRuntime({ scope: "managed-child-handoff-summary", checkpoint: options.checkpoint,
    preferences: options.preferences ?? readHandoffCompressionPreferences,
    load: async id => read()[id],
    save: async (id, value) => {
      const records = read(); delete records[id]; records[id] = value;
      for (const key of Object.keys(records)) {
        if (Object.keys(records).length <= LIMIT) break;
        const row = records[key] as { snapshot?: { status?: string } };
        if (key !== id && ["completed", "failed", "discarded"].includes(row?.snapshot?.status ?? "")) delete records[key];
      }
      if (Object.keys(records).length > LIMIT) throw new Error("Too many unresolved managed child summaries; inspect or discard an existing one");
      storage.setItem(STORAGE_KEY, JSON.stringify(records));
    },
    submit: async (input, selection) => {
      const binding = bindings.get(input.handoffId);
      try {
        if (!binding || !binding.isCurrent() || !sameRecord(current(binding.record.scopedId), binding.record)) throw new Error("Managed child source changed before compression");
        const summary = await (options.summarize ?? ipc.summarizeSessionHandoff)({ engine: binding.record.target.engine, sessionId: binding.record.target.sessionId,
          title: input.title, historyScope: "full", compressionSelection: selection });
        if (!binding.isCurrent() || !sameRecord(current(binding.record.scopedId), binding.record)) throw new Error("Managed child source changed during compression");
        return summary;
      } finally {
        if (binding && sourceFlights.get(binding.record.scopedId) === input.handoffId) sourceFlights.delete(binding.record.scopedId);
        if (bindings.get(input.handoffId) === binding) bindings.delete(input.handoffId);
      }
    },
  });
  return {
    inspect: runtime.inspect, discard: runtime.discard, onEvent: runtime.onEvent, preferences: runtime.preferences,
    async prepare(record, text, historyVersion, isCurrent, retry = false, selection) {
      if (!record.leaderCostApproval || !record.target.sessionId || !text.trim() || !isCurrent() || !sameRecord(current(record.scopedId), record)) throw new Error("Managed child source changed or history unavailable before compression");
      const chosen = structuredClone(selection ?? (await runtime.preferences()).selection);
      // One durable source identity across model choices: changing a model must
      // not evade a running/unknown generation after renderer recovery.
      const identity = JSON.stringify(["full-v2",
        record.scopedId, record.leaderCostApproval, record.sender.engine, record.sender.sessionId, record.sender.workspacePath,
        record.target.engine, record.target.sessionId, record.target.workspacePath, record.message, historyVersion,
        ...(record.imageRefs?.length ? [record.imageRefs] : [])]);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
      const handoffId = "managed-" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const existing = preparing.get(handoffId); if (existing) return existing;
      const flight = (async () => {
        const prior = await runtime.inspect(handoffId);
        const sameChoice = prior && prior.selection.engine === chosen.engine && prior.selection.model === chosen.model &&
          prior.selection.providerId === chosen.providerId && prior.selection.effort === chosen.effort;
        if (prior && (["running", "unknown"].includes(prior.status) || !retry && sameChoice)) return prior;
        if (!await (options.fullHistorySupported ?? ipc.handoffFullHistorySupported)()) throw new Error("Managed child full-history compression is not supported by this host; update the application before generating a summary");
        if (!isCurrent() || !sameRecord(current(record.scopedId), record)) throw new Error("Managed child source changed before compression");
        if (sourceFlights.has(record.scopedId)) throw new Error("Managed child compression is still running; discard does not stop the model call or billing. Wait for it to finish before generating again");
        sourceFlights.set(record.scopedId, handoffId);
        bindings.set(handoffId, { record: structuredClone(record), isCurrent });
        try {
          return await runtime.summarize({ handoffId, requestId: newId(), expectedRevision: prior?.revision ?? 0, text: `managed-child-full-v2:${handoffId}`, selection: chosen,
            title: (record.target.title || record.target.sessionId).slice(0, 512) });
        } catch (error) {
          if (sourceFlights.get(record.scopedId) === handoffId) sourceFlights.delete(record.scopedId);
          bindings.delete(handoffId); throw error;
        }
      })().finally(() => { if (preparing.get(handoffId) === flight) preparing.delete(handoffId); });
      preparing.set(handoffId, flight);
      return flight;
    },
  };
}

let singleton: ManagedChildSummaryService | undefined;
export function managedChildSummaryService(): ManagedChildSummaryService {
  return singleton ??= createManagedChildSummaryService();
}
