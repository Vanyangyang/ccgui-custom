import type {
  HostMemoryExtractionApi, MemoryExtractionCheckpoint, MemoryExtractionCursor,
  MemoryExtractionRequest, MemoryExtractionResult, MemoryExtractionSourceRequest,
  MemoryExtractionStatus, Disposer,
  MemoryExtractionPrepareRequest, MemoryExtractionPreparation,
} from "@ccgui/plugin-sdk";

interface SourceState { status: string; error?: string }
export interface MemoryExtractionDependencies {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  /** Existing host-owned bridges reconcile persisted ownership before native
   * reads it. No projection rows cross this bridge or come from plugin input. */
  conversation(id: string): Promise<SourceState>;
  coordination(id: string): Promise<SourceState>;
  paused(): boolean;
}
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function fields(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!plain(v) || Object.keys(v).some(k => !keys.includes(k))) throw new Error("Invalid memory extraction fields");
}
const id = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max * 2 && Array.from(v).length <= max;
function cursor(v: unknown): asserts v is MemoryExtractionCursor {
  fields(v, ["sessionId", "seq", "offset", "rowDigest"]);
  if (!text(v.sessionId, 300) || !v.sessionId || !Number.isSafeInteger(v.seq) || Number(v.seq) < -1 ||
    !Number.isSafeInteger(v.offset) || Number(v.offset) < 0 || (v.seq === -1 && v.offset !== 0) ||
    (v.seq !== -1 && (typeof v.rowDigest !== "string" || !HASH.test(v.rowDigest))) ||
    (v.rowDigest !== undefined && (typeof v.rowDigest !== "string" || !HASH.test(v.rowDigest)))) throw new Error("Invalid memory extraction cursor");
}
function sourceRequest(v: unknown, mode: "source" | "extract" | "prepare" = "source"): asserts v is MemoryExtractionSourceRequest {
  fields(v, mode === "extract" ? ["projectId", "source", "requestId", "cursor", "context", "formatVersion", "expectedSourceDigest"] : mode === "prepare" ? ["projectId", "source", "cursor"] : ["projectId", "source"]);
  fields(v.source, ["kind", "id"]);
  if (!id(v.projectId) || !id(v.source.id) || !["conversation", "coordination"].includes(String(v.source.kind))) throw new Error("Invalid memory extraction source");
}
function extractionRequest(v: unknown): asserts v is MemoryExtractionRequest {
  sourceRequest(v, "extract");
  const request = v as MemoryExtractionRequest;
  if (!id(request.requestId)) throw new Error("Invalid memory extraction request ID");
  if (request.formatVersion !== undefined && request.formatVersion !== 2 ||
    request.expectedSourceDigest !== undefined && (typeof request.expectedSourceDigest !== "string" || !HASH.test(request.expectedSourceDigest)) ||
    request.formatVersion === 2 && !request.expectedSourceDigest) throw new Error("Invalid memory extraction format or digest");
  if (request.cursor != null) cursor(request.cursor);
  if (request.context !== undefined) {
    if (!Array.isArray(request.context) || request.context.length > 6 || new Set(request.context.map(c => c?.id)).size !== request.context.length) throw new Error("Invalid memory extraction context");
    for (const c of request.context) {
      fields(c, ["id", "revision", "kind", "title", "text", "conditions", "authority", "updatedAt"]);
      if (!text(c.id, 180) || !c.id || !Number.isSafeInteger(c.revision) || Number(c.revision) < 1 ||
        !text(c.kind, 30) || !["decision", "idea", "observation", "hypothesis", "handoff"].includes(String(c.kind)) ||
        !text(c.title, 160) || !text(c.text, 1600) || !Array.isArray(c.conditions) || c.conditions.length > 4 || c.conditions.some(x => !text(x, 300))) throw new Error("Invalid memory extraction context");
      if (c.authority !== undefined && !text(c.authority, 64) || c.updatedAt !== undefined && !text(c.updatedAt, 64)) throw new Error("Invalid memory extraction context metadata");
    }
    if (new TextEncoder().encode(JSON.stringify(request.context)).length > 6144) throw new Error("Memory extraction context exceeds budget");
  }
}
const deferred = (reason: string) => ({ status: "deferred" as const, reason, retryAfterMs: 30000 });
const sameCursor = (a: MemoryExtractionCursor | null, b: MemoryExtractionCursor | null) => a === null || b === null ? a === b :
  a.sessionId === b.sessionId && a.seq === b.seq && a.offset === b.offset && a.rowDigest === b.rowDigest;
function deferShape(v: Record<string, unknown>): boolean {
  return ["deferred", "unavailable", "invalid_source"].includes(String(v.status)) && text(v.reason, 512) &&
    Number.isSafeInteger(v.retryAfterMs) && Number(v.retryAfterMs) >= 0 && Number(v.retryAfterMs) <= 86400000;
}
function session(v: unknown): v is { engine: string; sessionId: string; workspacePath: string } {
  return plain(v) && text(v.engine, 40) && !!v.engine && text(v.sessionId, 300) && !!v.sessionId && text(v.workspacePath, 4096) && !!v.workspacePath;
}
function checkpointResponse(raw: unknown): MemoryExtractionCheckpoint {
  if (!plain(raw)) throw new Error("Invalid memory checkpoint response");
  if (deferShape(raw)) return raw as unknown as MemoryExtractionCheckpoint;
  if (raw.status !== "ready" || !session(raw.sessionRef)) throw new Error("Invalid memory checkpoint response");
  cursor(raw.cursor);
  if (raw.cursor.sessionId !== raw.sessionRef.sessionId) throw new Error("Memory checkpoint identity mismatch");
  return raw as unknown as MemoryExtractionCheckpoint;
}
function preparationResponse(raw: unknown, request: MemoryExtractionPrepareRequest): MemoryExtractionPreparation {
  if (!plain(raw)) throw new Error("Invalid memory preparation response");
  if (deferShape(raw)) return raw as unknown as MemoryExtractionPreparation;
  fields(raw, ["status", "query", "sourceDigest", "fromCursor", "nextCursor", "sessionRef", "partial", "hasMore"]);
  if (raw.status !== "ready" || !text(raw.query, 512) || typeof raw.sourceDigest !== "string" || !HASH.test(raw.sourceDigest) ||
    !session(raw.sessionRef) || typeof raw.partial !== "boolean" || typeof raw.hasMore !== "boolean") throw new Error("Invalid memory preparation response");
  if (raw.fromCursor !== null) cursor(raw.fromCursor);
  if (raw.nextCursor !== null) cursor(raw.nextCursor);
  if (!sameCursor(raw.fromCursor as MemoryExtractionCursor | null, request.cursor ?? null) ||
    raw.fromCursor && raw.fromCursor.sessionId !== raw.sessionRef.sessionId ||
    raw.nextCursor && raw.nextCursor.sessionId !== raw.sessionRef.sessionId) throw new Error("Memory preparation identity mismatch");
  return raw as unknown as MemoryExtractionPreparation;
}
function extractionResponse(raw: unknown, request: MemoryExtractionRequest): MemoryExtractionResult {
  if (!plain(raw)) throw new Error("Invalid memory extraction response");
  if (deferShape(raw)) return raw as unknown as MemoryExtractionResult;
  if (raw.status === "empty") {
    if (raw.cursor !== null) cursor(raw.cursor);
    if (request.cursor && raw.cursor && request.cursor.sessionId !== raw.cursor.sessionId) throw new Error("Memory cursor identity mismatch");
    return raw as unknown as MemoryExtractionResult;
  }
  const batch = raw.batch;
  if (raw.status !== "completed" || !plain(batch) || batch.version !== (request.formatVersion ?? 1) || batch.projectId !== request.projectId ||
    !plain(batch.source) || batch.source.kind !== request.source.kind || batch.source.id !== request.source.id ||
    !session(batch.sessionRef) || batch.model !== "gemini-4-argon" || typeof batch.inputDigest !== "string" || !HASH.test(batch.inputDigest) ||
    typeof batch.partial !== "boolean" || typeof batch.hasMore !== "boolean" || !Array.isArray(batch.notes) || batch.notes.length > 3) throw new Error("Memory batch identity mismatch");
  cursor(batch.nextCursor);
  if (batch.fromCursor !== null) cursor(batch.fromCursor);
  if (!sameCursor(batch.fromCursor as MemoryExtractionCursor | null, request.cursor ?? null) || batch.nextCursor.sessionId !== batch.sessionRef.sessionId ||
    (request.cursor && batch.nextCursor.sessionId !== request.cursor.sessionId)) throw new Error("Memory cursor identity mismatch");
  const from = request.cursor;
  const next = batch.nextCursor;
  if (next.seq < 0 || (from && (next.seq < from.seq || (next.seq === from.seq &&
    (from.offset === 0 || (next.offset > 0 && next.offset <= from.offset)))))) throw new Error("Memory cursor did not advance");
  // The native validator binds quotes to the original source. This second shape
  // check keeps a mismatched/older IPC implementation out of plugin persistence.
  const related = new Set(request.context?.map(c => c.id) ?? []);
  for (const note of batch.notes) {
    if (!plain(note) || !["decision", "idea", "observation", "hypothesis", "handoff"].includes(String(note.kind)) ||
      !text(note.title, 120) || !note.title.trim() || !text(note.text, 1600) || !note.text.trim() ||
      !Array.isArray(note.conditions) || note.conditions.length > 4 || note.conditions.some(c => !text(c, 300)) ||
      !Array.isArray(note.relatedIds) || note.relatedIds.length > 6 || note.relatedIds.some(c => typeof c !== "string" || !related.has(c)) ||
      !Array.isArray(note.evidence) || note.evidence.length < 1 || note.evidence.length > 3 || note.evidence.some(e => !plain(e) ||
        !Number.isSafeInteger(e.seq) || Number(e.seq) < 0 || !["user", "assistant"].includes(String(e.role)) || !text(e.quote, 400) || !e.quote.trim()) ||
      (note.kind === "decision" && !note.evidence.some(e => e.role === "user"))) throw new Error("Invalid memory extraction notes");
    if (batch.version === 1 && note.relations !== undefined) throw new Error("Unexpected legacy memory relations");
    if (batch.version === 2) {
      if (!Array.isArray(note.relations) || note.relations.length > 3) throw new Error("Invalid memory relations");
      const targets = new Set();
      for (const relation of note.relations) {
        fields(relation, ["kind", "targetId", "targetRevision", "reason"]);
        const target = request.context?.find(c => c.id === relation.targetId && c.revision === relation.targetRevision);
        if (!target || !["supersedes", "conflicts"].includes(String(relation.kind)) || !text(relation.reason, 300) || !relation.reason.trim() ||
          targets.has(relation.targetId)) throw new Error("Invalid memory relation target");
        targets.add(relation.targetId);
        if (relation.kind === "supersedes" && (note.kind !== "decision" || target.kind !== "decision" ||
          ["user_confirmed", "user_recorded"].includes(target.authority ?? "") ||
          JSON.stringify([...note.conditions].sort()) !== JSON.stringify([...target.conditions].sort()) ||
          !note.evidence.some(e => e.role === "user"))) throw new Error("Invalid memory replacement evidence");
      }
    }
  }
  return raw as unknown as MemoryExtractionResult;
}

export function createMemoryExtractionBridge(pluginId: string, deps: MemoryExtractionDependencies): HostMemoryExtractionApi & { dispose: Disposer } {
  let disposed = false;
  const pending = new Map<string, { cancelled: boolean }>();
  const alive = () => { if (disposed) throw new Error("Memory extraction facade disposed"); };
  const invoke = (command: string, args: Record<string, unknown> = {}) => deps.invoke(command, { ...args, pluginId });
  const ready = async (request: MemoryExtractionSourceRequest) => {
    const state = await (request.source.kind === "conversation" ? deps.conversation(request.source.id) : deps.coordination(request.source.id));
    return !state.error && state.status === (request.source.kind === "conversation" ? "completed" : "idle");
  };
  return {
    async status(): Promise<MemoryExtractionStatus> {
      alive();
      if (deps.paused()) return { available: true, busy: true, retryAfterMs: 30000, reason: "maintenance" };
      const value = await invoke("plugin_memory_status");
      alive();
      if (!plain(value) || typeof value.available !== "boolean" || typeof value.busy !== "boolean" ||
        !Number.isSafeInteger(value.retryAfterMs) || Number(value.retryAfterMs) < 0 || Number(value.retryAfterMs) > 86400000 ||
        (value.reason !== undefined && !text(value.reason, 512))) throw new Error("Invalid memory extraction status");
      return value as unknown as MemoryExtractionStatus;
    },
    async checkpoint(input) {
      alive(); sourceRequest(input);
      const request = structuredClone(input);
      if (deps.paused()) return deferred("maintenance");
      if (!await ready(request)) return deferred("source_not_settled");
      alive();
      if (deps.paused()) return deferred("maintenance");
      return checkpointResponse(await invoke("plugin_memory_checkpoint", { request }));
    },
    async prepare(input) {
      alive(); sourceRequest(input, "prepare");
      if (input.cursor != null) cursor(input.cursor);
      const request = structuredClone(input);
      if (deps.paused()) return deferred("maintenance");
      if (!await ready(request)) return deferred("source_not_settled");
      alive();
      if (deps.paused()) return deferred("maintenance");
      const result = await invoke("plugin_memory_prepare", { request });
      alive();
      if (deps.paused()) return deferred("maintenance");
      return preparationResponse(result, request);
    },
    async extract(input) {
      alive(); extractionRequest(input);
      const request = structuredClone(input);
      if (pending.has(request.requestId)) throw new Error("Memory extraction request already pending");
      const entry = { cancelled: false };
      pending.set(request.requestId, entry);
      try {
        if (deps.paused()) return deferred("maintenance");
        if (!await ready(request)) return deferred("source_not_settled");
        if (entry.cancelled || disposed) return deferred("cancelled");
        if (deps.paused()) return deferred("maintenance");
        const result = await invoke("plugin_memory_extract", { request });
        if (entry.cancelled || disposed) return deferred("cancelled");
        if (deps.paused()) return deferred("maintenance");
        return extractionResponse(result, request);
      } finally { if (pending.get(request.requestId) === entry) pending.delete(request.requestId); }
    },
    async cancel(requestId) {
      alive();
      if (!id(requestId)) throw new Error("Invalid memory extraction request ID");
      const entry = pending.get(requestId);
      if (entry) entry.cancelled = true;
      await invoke("plugin_memory_cancel", { requestId });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [requestId, entry] of pending) {
        entry.cancelled = true;
        void invoke("plugin_memory_cancel", { requestId }).catch(() => undefined);
      }
    },
  };
}
