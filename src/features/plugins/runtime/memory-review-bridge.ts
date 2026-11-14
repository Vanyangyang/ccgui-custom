import type { Disposer, HostMemoryReviewApi, MemoryReviewRecord, MemoryReviewRequest, MemoryReviewResult, MemoryExtractionStatus } from "@ccgui/plugin-sdk";

export interface MemoryReviewDependencies {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  paused(): boolean;
  authorizeSource?(kind: "conversation" | "coordination"): void;
}
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v);
const text = (v: unknown, max: number, empty = false): v is string => typeof v === "string" && v.length <= max * 2 && Array.from(v).length <= max && (empty || !!v.trim());
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function fields(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  if (!plain(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) throw new Error("Invalid memory review fields");
}
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
function conditions(v: unknown): v is string[] { return Array.isArray(v) && v.length <= 4 && v.every(c => text(c, 300)); }
function record(v: unknown): asserts v is MemoryReviewRecord {
  fields(v, ["id", "revision", "kind", "title", "text", "conditions", "authority", "source"], ["state"]);
  if (Object.hasOwn(v, "state") && v.state !== "active" && v.state !== "withdrawn") throw new Error("Invalid memory review record state");
  if (!text(v.id, 180) || !revision(v.revision) || !["decision", "idea", "observation", "hypothesis", "handoff"].includes(String(v.kind)) ||
    !text(v.title, 160) || !text(v.text, 1600) || !conditions(v.conditions) || !text(v.authority, 64)) throw new Error("Memory review record is not reviewable; oversized records cannot be truncated");
  const s = v.source;
  const optional = ["engine", "sessionId", "messageId", "workspacePath", "hostProjectId", "sourceKind", "sourceId"];
  fields(s, ["kind", "role", "complete", "text"], optional);
  if (!text(s.kind, 80) || !text(s.role, 80) || typeof s.complete !== "boolean" || !text(s.text, 8192, true) ||
    optional.some(k => Object.hasOwn(s, k) && !text(s[k], k === "workspacePath" ? 4096 : 300))) throw new Error("Invalid memory review source");
}
export function validateMemoryReviewRequest(v: unknown): asserts v is MemoryReviewRequest {
  fields(v, ["requestId", "projectId", "batchId", "root", "candidates"], ["reconcileOnly"]);
  if (v.reconcileOnly !== undefined && typeof v.reconcileOnly !== "boolean") throw new Error("Invalid memory review reconciliation flag");
  if (!id(v.requestId) || !id(v.projectId) || !id(v.batchId) || !Array.isArray(v.candidates) || v.candidates.length > 6) throw new Error("Invalid memory review request");
  record(v.root); v.candidates.forEach(record);
  const records = [v.root, ...v.candidates];
  if (new Set(records.map(r => r.id)).size !== records.length) throw new Error("Duplicate memory review record");
  if (size(v) > 32768) throw new Error("Memory review request exceeds 32768 byte budget");
}
function cycles(edges: Map<string, string[]>): boolean {
  const done = new Set<string>(), visiting = new Set<string>();
  const visit = (n: string): boolean => {
    if (done.has(n)) return false;
    if (visiting.has(n)) return true;
    visiting.add(n);
    if ((edges.get(n) ?? []).some(visit)) return true;
    visiting.delete(n); done.add(n); return false;
  };
  return [...edges.keys()].some(visit);
}
export function validateMemoryReviewResponse(v: unknown, request: MemoryReviewRequest): MemoryReviewResult {
  if (!plain(v) || size(v) > 65536) throw new Error("Invalid memory review response");
  if (["deferred", "unavailable", "invalid_source"].includes(String(v.status))) {
    fields(v, ["status", "reason", "retryAfterMs"]);
    if (!text(v.reason, 512) || !Number.isSafeInteger(v.retryAfterMs) || Number(v.retryAfterMs) < 0 || Number(v.retryAfterMs) > 86400000) throw new Error("Invalid memory review disposition");
    return v as unknown as MemoryReviewResult;
  }
  fields(v, ["status", "batch"]);
  const b = v.batch;
  fields(b, ["version", "requestId", "projectId", "batchId", "model", "records", "judgments"]);
  const records = [request.root, ...request.candidates], byId = new Map(records.map(r => [r.id, r]));
  if (v.status !== "completed" || b.version !== 1 || b.requestId !== request.requestId || b.projectId !== request.projectId || b.batchId !== request.batchId || b.model !== "gemini-4-argon" ||
    !Array.isArray(b.records) || b.records.length !== records.length || !Array.isArray(b.judgments) || b.judgments.length !== records.length) throw new Error("Memory review batch identity mismatch");
  const versions = new Set<string>();
  for (const r of b.records) {
    fields(r, ["id", "revision"]);
    if (typeof r.id !== "string" || versions.has(r.id) || byId.get(r.id)?.revision !== r.revision) throw new Error("Memory review revision mismatch");
    versions.add(r.id);
  }
  const targets = new Set<string>(), edges = new Map<string, string[]>();
  for (const j of b.judgments) {
    fields(j, ["targetId", "targetRevision", "outcome", "reason", "successorId", "scope", "evidence", "dependsOn", "preserve"]);
    const target = typeof j.targetId === "string" ? byId.get(j.targetId) : undefined;
    if (!target || targets.has(target.id) || j.targetRevision !== target.revision || !["keep", "superseded", "needs_review", "conflicted"].includes(String(j.outcome)) ||
      !["same", "overlap", "disjoint", "unknown"].includes(String(j.scope)) || !text(j.reason, 600) || !Array.isArray(j.evidence) || j.evidence.length > 12 ||
      !Array.isArray(j.dependsOn) || j.dependsOn.length > 6 || !Array.isArray(j.preserve) || j.preserve.length > 4) throw new Error("Invalid memory review judgment");
    targets.add(target.id);
    const evidenceKeys = new Set<string>();
    for (const e of j.evidence) {
      fields(e, ["recordId", "quote"]);
      if (typeof e.recordId !== "string" || !byId.has(e.recordId) || !text(e.quote, 1600) || evidenceKeys.has(JSON.stringify([e.recordId, e.quote]))) throw new Error("Invalid memory review evidence");
      evidenceKeys.add(JSON.stringify([e.recordId, e.quote]));
    }
    const dependencies = new Set<string>();
    for (const d of j.dependsOn) {
      if (typeof d !== "string" || !byId.has(d) || d === target.id || dependencies.has(d) || !j.reason.includes(d) ||
        !j.evidence.some(e => e.recordId === d) || !j.evidence.some(e => e.recordId === target.id)) throw new Error("Unsupported memory review dependency");
      dependencies.add(d);
    }
    const preserved = new Set<string>();
    for (const p of j.preserve) {
      fields(p, ["title", "text", "conditions"]);
      if (p.title !== target.title || !text(p.text, 1600) || !target.text.includes(p.text) || !conditions(p.conditions) || JSON.stringify(p.conditions) !== JSON.stringify(target.conditions) || preserved.has(p.text)) throw new Error("Invalid memory review preservation");
      preserved.add(p.text);
    }
    if (j.outcome === "superseded") {
      const successor = typeof j.successorId === "string" ? byId.get(j.successorId) : undefined;
      // Every entry was structurally checked above; retain that narrowing in
      // the nested callback instead of closing over an unknown object field.
      const inspectedEvidence = j.evidence as Array<{ recordId: string; quote: string }>;
      const conditionsCited = (record: MemoryReviewRecord) => record.conditions.every(condition => inspectedEvidence.some(e => e.recordId === record.id && e.quote.includes(condition)));
      if (!successor || successor.id === target.id || successor.kind !== target.kind || !["decision", "observation", "handoff"].includes(target.kind) ||
        !(j.scope === "same" || j.scope === "overlap" && j.preserve.length > 0) ||
        !(JSON.stringify(target.conditions) === JSON.stringify(successor.conditions) || conditionsCited(target) && conditionsCited(successor)) ||
        !j.evidence.some(e => e.recordId === target.id) || !j.evidence.some(e => e.recordId === successor.id)) throw new Error("Invalid memory review replacement");
      dependencies.add(successor.id);
    } else if (j.successorId !== null || j.preserve.length) throw new Error("Unexpected memory review replacement");
    if (j.dependsOn.some(d => byId.get(d)?.state === "withdrawn") ||
      j.outcome === "keep" && target.state === "withdrawn" ||
      j.outcome === "superseded" && typeof j.successorId === "string" && byId.get(j.successorId)?.state === "withdrawn" ||
      ["keep", "superseded"].includes(String(j.outcome)) && j.evidence.some(e => e.recordId !== target.id && byId.get(e.recordId)?.state === "withdrawn")) throw new Error("Withdrawn memory cannot support current judgments");
    edges.set(target.id, [...dependencies]);
  }
  if (cycles(edges)) throw new Error("Cyclic memory review relations");
  return v as unknown as MemoryReviewResult;
}
const deferred = (reason: string) => ({ status: "deferred" as const, reason, retryAfterMs: 30000 });
export function createMemoryReviewBridge(pluginId: string, deps: MemoryReviewDependencies): HostMemoryReviewApi & { dispose: Disposer } {
  let disposed = false;
  const pending = new Map<string, { cancelled: boolean }>();
  const alive = () => { if (disposed) throw new Error("Memory review facade disposed"); };
  const invoke = (command: string, args: Record<string, unknown> = {}) => deps.invoke(command, { ...args, pluginId });
  return {
    async status(): Promise<MemoryExtractionStatus> {
      alive();
      if (deps.paused()) return { available: true, busy: true, retryAfterMs: 30000, reason: "maintenance" };
      const v = await invoke("plugin_memory_status"); alive();
      fields(v, ["available", "busy", "retryAfterMs"], ["reason", "automationVersion", "canReconcile"]);
      if (typeof v.available !== "boolean" || typeof v.busy !== "boolean" || !Number.isSafeInteger(v.retryAfterMs) || Number(v.retryAfterMs) < 0 || Number(v.retryAfterMs) > 86400000 || v.reason !== undefined && !text(v.reason, 512)) throw new Error("Invalid memory review status");
      if (v.automationVersion !== undefined && v.automationVersion !== 1) throw new Error("Invalid memory automation capability");
      if (v.canReconcile !== undefined && typeof v.canReconcile !== "boolean") throw new Error("Invalid memory receipt availability");
      return v as unknown as MemoryExtractionStatus;
    },
    async review(input) {
      alive(); validateMemoryReviewRequest(input);
      const request = structuredClone(input);
      for (const r of [request.root, ...request.candidates]) {
        if (r.source.kind === "ai_background_extract" && (r.source.sourceKind === "conversation" || r.source.sourceKind === "coordination")) deps.authorizeSource?.(r.source.sourceKind);
      }
      if (pending.has(request.requestId)) throw new Error("Memory review request already pending");
      const entry = { cancelled: false }; pending.set(request.requestId, entry);
      let submitted = false;
      try {
        if (deps.paused()) return deferred("maintenance");
        submitted = true;
        const response = await invoke("plugin_memory_review", { request });
        const result = validateMemoryReviewResponse(response, request);
        // Neither cancellation nor a maintenance race can turn a possibly paid
        // call into an ordinary retriable "cancelled" result.
        if (result.status !== "completed" && result.reason === "request_outcome_unknown") return result;
        if (entry.cancelled || disposed) return deferred(result.status === "completed" ? "request_outcome_unknown" : "cancelled");
        if (deps.paused()) return deferred(result.status === "completed" ? "request_outcome_unknown" : "maintenance");
        return result;
      } catch (error) {
        // Lost IPC/invalid responses cannot prove native inference never began.
        if (submitted) return deferred("request_outcome_unknown");
        throw error;
      } finally { if (pending.get(request.requestId) === entry) pending.delete(request.requestId); }
    },
    async cancel(requestId) {
      alive(); if (!id(requestId)) throw new Error("Invalid memory review request ID");
      const entry = pending.get(requestId); if (entry) { entry.cancelled = true; pending.delete(requestId); }
      await invoke("plugin_memory_cancel", { requestId });
    },
    dispose() {
      if (disposed) return; disposed = true;
      for (const [requestId, entry] of pending) {
        entry.cancelled = true;
        void invoke("plugin_memory_cancel", { requestId }).catch(() => undefined);
      }
      pending.clear();
    },
  };
}
