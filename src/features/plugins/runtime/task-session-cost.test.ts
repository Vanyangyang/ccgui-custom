import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@/lib/ipc";
import type { ChatStore } from "@/features/chat/store/types";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { sessionKey } from "@/features/chat/store/persistence";
import { evaluateTaskSessionCost } from "./task-session-cost";

const NOW = 1_800_000_000_000;
function fixture(engine = "claude", used = 50_000) {
  const ref = { engine, sessionId: "target", workspacePath: "G:/project" };
  const meta = { ...ref, model: "model-a", updatedAt: NOW,
    fileSize: 90_000_000, messageCount: 100_000,
    promptCache: { startedAt: NOW - 1000, observedAt: NOW - 1000, ttlSeconds: 300, source: "anthropic-usage" },
  } as SessionMeta;
  const session = { ...EMPTY_SESSION, messages: [], usage: { input_tokens: used } };
  const key = sessionKey(engine, ref.sessionId, ref.workspacePath);
  const state = { initialized: true, sessions: [meta], openTabs: [{ ...ref, model: "model-a" }],
    bySession: { [key]: session }, archivedSessionKeys: {}, models: { [engine]: "model-a" },
  } as unknown as ChatStore;
  return { ref, meta, session, state, key, evaluate: (now = NOW) => evaluateTaskSessionCost(ref, state, now)! };
}

describe("task session cost evaluation", () => {
  it("allows hot and expiring-soon caches but reviews cold cache at the exact threshold", () => {
    const f = fixture();
    expect(f.evaluate().required).toBe(false);
    expect(f.evaluate(NOW + 298_000).required).toBe(false);
    expect(f.evaluate(NOW + 299_000)).toMatchObject({ required: true, review: { cacheHeat: "cold" } });
  });
  it.each([0, 49_999, 50_000, 50_001])("uses measured %i tokens, not archive size", used => {
    const f = fixture("claude", used);
    expect(f.evaluate(NOW + 300_000).required).toBe(used >= 50_000);
    f.session.usage = null as never;
    expect(f.evaluate(NOW + 300_000).required).toBe(false);
  });
  it("reviews unknown cache only after one hour and never uses this idle rule for Cursor", () => {
    for (const engine of ["claude", "cursor"]) {
      const f = fixture(engine); f.meta.promptCache = null;
      expect(f.evaluate(NOW + 3_599_999).required).toBe(false);
      expect(f.evaluate(NOW + 3_600_000).required).toBe(engine !== "cursor");
    }
  });
  it("retains model mismatch review including Codex GPT, with the 50k threshold", () => {
    for (const engine of ["claude", "codex"]) {
      const f = fixture(engine);
      f.state.openTabs[0].model = "gpt-6-astra";
      f.session.messages = [{ model: "other-model", usage: f.session.usage }] as never;
      expect(f.evaluate()).toMatchObject({ required: true, review: { context: { modelMismatch: true, kind: "last_request" } } });
      f.session.usage = { input_tokens: 49_999 };
      expect(f.evaluate().required).toBe(false);
    }
  });
  it("does not review Codex GPT solely for stale or missing cache", () => {
    const f = fixture("codex"); f.state.openTabs[0].model = "gpt-6-astra";
    expect(f.evaluate(NOW + 7_200_000).required).toBe(false);
    f.meta.promptCache = null;
    expect(f.evaluate(NOW + 7_200_000).required).toBe(false);
  });
  it.each(["codex", "claude"])("skips cost approval without metadata for a loaded %s owner", engine => {
    const f = fixture(engine);
    f.state.sessions = [];
    f.state.openTabs[0].model = "gpt-6.1-terra";
    expect(f.evaluate()).toMatchObject({ required: false, review: { model: "gpt-6.1-terra" } });
    f.session.usage = null as never;
    f.state.openTabs[0].model = undefined;
    delete f.state.models[engine];
    expect(f.evaluate()).toMatchObject({ required: false, review: { model: undefined, cacheExpiryDisabled: false, context: { kind: "unknown" } } });
  });
  it.each(["codex", "claude"])("compares Windows owner paths semantically for %s and preserves the selected model", engine => {
    const f = fixture(engine);
    f.meta.workspacePath = "g:\\project";
    f.state.openTabs[0].workspacePath = "g:\\project";
    f.state.openTabs[0].model = engine === "codex" ? "gpt-6.1-terra" : "selected-claude";
    expect(f.evaluate(NOW + 7_200_000)).toMatchObject({ required: engine === "claude", review: { model: f.state.openTabs[0].model } });
    f.session.messages = [{ model: "other-model", usage: f.session.usage }] as never;
    expect(f.evaluate()).toMatchObject({ required: true, review: { context: { modelMismatch: true } } });
    f.session.usage = { input_tokens: 49_999 };
    expect(f.evaluate().required).toBe(false);
    expect(f.meta.workspacePath).toBe("g:\\project");
    expect(f.state.openTabs[0].workspacePath).toBe("g:\\project");
  });
  it.each(["g:/PROJECT", "G:/PROJECT", "G:/project/", "G:/other"])("fences distinct native owner %s", workspacePath => {
    const f = fixture();
    f.state.openTabs.push({ ...f.ref, workspacePath });
    expect(f.evaluate()).toBeNull();
  });
  it("uses legacy empty-workspace metadata only with a proven loaded owner", () => {
    const f = fixture(); f.meta.workspacePath = "";
    expect(f.evaluate(NOW + 300_000).required).toBe(true);
    expect(f.meta.workspacePath).toBe("");
    f.state.openTabs.push({ ...f.ref, workspacePath: "G:/other" });
    expect(f.evaluate()).toBeNull();
  });
  it.each(["uninitialized", "closed", "missing-session", "loading", "archived", "tab-conflict", "meta-conflict", "wrong-workspace"])("returns null for %s ownership", reason => {
    const f = fixture();
    if (reason === "uninitialized") f.state.initialized = false;
    if (reason === "closed") f.state.openTabs = [];
    if (reason === "missing-session") delete f.state.bySession[f.key];
    if (reason === "loading") f.session.loading = true;
    if (reason === "archived") f.state.archivedSessionKeys[f.key] = true;
    if (reason === "tab-conflict") f.state.openTabs.push({ ...f.ref, workspacePath: "G:/other" });
    if (reason === "meta-conflict") f.state.sessions.push({ ...f.meta, workspacePath: "G:/other" });
    if (reason === "wrong-workspace") f.ref.workspacePath = "G:/other";
    expect(f.evaluate()).toBeNull();
    if (reason !== "meta-conflict") {
      f.state.sessions = [];
      expect(f.evaluate()).toBeNull();
    }
  });
  it("keeps signatures stable across capture time and telemetry key ordering", () => {
    const f = fixture();
    f.session.usage = { input_tokens: 50_000, output_tokens: 0 } as never;
    const first = f.evaluate();
    f.session.usage = { output_tokens: 0, input_tokens: 50_000 } as never;
    expect(f.evaluate(NOW + 1000).signature).toBe(first.signature);
    expect(f.evaluate(NOW + 1000).review.capturedAt).not.toBe(first.review.capturedAt);
    f.session.usage = { input_tokens: 50_000, output_tokens: 0, unrelated_payload: "not an approval fact" } as never;
    expect(f.evaluate().signature).toBe(first.signature);
    expect(f.evaluate().signature).not.toContain("unrelated_payload");
    expect(f.evaluate(NOW + 300_000).signature).not.toBe(first.signature);
  });
  it("changes signatures at unknown-cache idle boundary and for each raw cost fact", () => {
    const f = fixture(); f.meta.promptCache = null;
    expect(f.evaluate(NOW + 3_599_999).signature).not.toBe(f.evaluate(NOW + 3_600_000).signature);
    const mutations = [
      (f: ReturnType<typeof fixture>) => { f.state.openTabs[0].model = "model-b"; },
      (f: ReturnType<typeof fixture>) => { f.session.usage = { input_tokens: 50_001 }; },
      (f: ReturnType<typeof fixture>) => { f.meta.promptCache!.startedAt -= 1; },
      (f: ReturnType<typeof fixture>) => { f.meta.promptCache!.ttlSeconds += 1; },
      (f: ReturnType<typeof fixture>) => { f.meta.promptCache!.source = "anthropic-mixed"; },
      (f: ReturnType<typeof fixture>) => { f.meta.updatedAt! -= 1; },
      (f: ReturnType<typeof fixture>) => { f.session.messages = [{ model: "model-b", usage: f.session.usage }] as never; },
    ];
    for (const mutate of mutations) {
      const current = fixture(); const before = current.evaluate().signature;
      mutate(current); expect(current.evaluate().signature).not.toBe(before);
    }
  });
});
