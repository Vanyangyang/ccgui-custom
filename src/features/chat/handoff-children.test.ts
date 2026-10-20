import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import type { LeaderBranch, LeaderIdentity, LeaderSnapshot } from "@/features/leader/types";
import { buildHandoffChildren } from "./handoff-children";

const source: LeaderIdentity = { engine: "codex", sessionId: "root", workspacePath: "G:/project" };
function branch(id: string, overrides: Partial<LeaderBranch> = {}): LeaderBranch {
  return {
    id, parentEngine: source.engine, parentSessionId: source.sessionId, workspacePath: source.workspacePath,
    engine: "codex", sessionId: `session-${id}`, title: `Task ${id}`, task: "", model: null, effort: null,
    runId: null, state: "completed", createdAt: 1, updatedAt: 1, lastActivityAt: 1, deadlineAt: 0,
    expired: false, result: `Result ${id}`, resultTruncated: false, error: null, ...overrides,
  };
}
const digest = (branches: LeaderBranch[], root = source) =>
  buildHandoffChildren({ leaders: [], branches } satisfies LeaderSnapshot, root, 0);
const size = (text: string) => Array.from(text).length;

beforeEach(async () => { await i18n.changeLanguage("zh"); });

describe("handoff children", () => {
  it("leaves empty or unrelated snapshots unchanged", () => {
    expect(digest([])).toMatchObject({ block: "", context: "", total: 0, included: 0 });
    expect(digest([
      branch("foreign", { workspacePath: "G:/other" }),
      branch("sibling", { parentSessionId: "other" }),
      branch("removed", { state: "reclaimed" }),
    ]).total).toBe(0);
  });

  it("uses the current source as root, follows descendants, deduplicates only IDs and terminates cycles", () => {
    const branches = [
      branch("parent"), branch("sibling"),
      branch("child", { parentSessionId: "session-parent", title: "Same" }),
      branch("grandchild", { parentSessionId: "session-child", title: "Same" }),
      branch("missing", { parentSessionId: "session-parent", sessionId: null }),
      branch("cycle", { parentSessionId: "session-grandchild", sessionId: "session-parent" }),
      branch("child", { parentSessionId: "session-parent", result: "Duplicate" }),
    ];
    const result = digest(branches, { ...source, sessionId: "session-parent" });
    expect(result.total).toBe(4);
    expect(result.block).not.toContain("Task sibling");
    expect(result.block).not.toContain("Task parent");
    expect(result.block).not.toContain("Duplicate");
    expect(result.block).toContain(i18n.t("chat.handoffChildrenBranch", { id: "missing" }));
    expect(result.block.match(/Same/g)).toHaveLength(2);
  });

  it("preserves states, report-only completion, expiration, errors and empty/truncated results", () => {
    const states: LeaderBranch["state"][] = ["starting", "running", "waiting", "awaiting_cost_approval", "completed", "failed", "stopped", "unknown", "reclaiming"];
    const result = digest(states.map((state) => branch(state, {
      state, result: state === "completed" ? "" : "output",
      error: state === "failed" ? "reason" : null,
      expired: state === "running", resultTruncated: state === "stopped",
    })));
    expect(result.included).toBe(states.length);
    for (const key of ["Completed", "Waiting", "Expired", "NoResult", "Truncated", "Partial"]) {
      expect(result.block).toContain(i18n.t(`chat.handoffChildren${key}`));
    }
    for (const state of ["awaiting_cost_approval", "failed", "stopped", "unknown", "reclaiming"]) {
      expect(result.block).toContain(i18n.t(`leader.state.${state}`));
    }
    expect(result.block).toContain(i18n.t("chat.handoffChildrenError", { error: "reason" }));
    expect(result.attention).toBe(8);
    expect(result.block.startsWith(`${result.heading}\n\n> `)).toBe(true);
    expect(result.block.split("\n").slice(2).every((line) => line.startsWith("> "))).toBe(true);
  });

  it("prioritizes unresolved and expired tasks, then update time and stable ID", () => {
    const result = digest([
      branch("done", { updatedAt: 100 }),
      branch("z", { state: "failed", updatedAt: 5 }),
      branch("a", { state: "waiting", updatedAt: 5 }),
      branch("expired", { expired: true, updatedAt: 10 }),
    ]);
    expect(result.block.indexOf("Task expired")).toBeLessThan(result.block.indexOf("Task a"));
    expect(result.block.indexOf("Task a")).toBeLessThan(result.block.indexOf("Task z"));
    expect(result.block.indexOf("Task z")).toBeLessThan(result.block.indexOf("Task done"));
  });

  it.each(["zh", "en"])("bounds counts and budgets with accurate omission counts (%s)", async (language) => {
    await i18n.changeLanguage(language);
    const result = digest(Array.from({ length: 40 }, (_, index) => branch(String(index), {
      state: index < 20 ? "running" : "completed", result: "中文👨‍👩‍👧‍👦".repeat(1000),
    })));
    expect(result.included).toBeLessThanOrEqual(12);
    expect(result.included).toBeGreaterThan(0);
    expect(size(result.block)).toBeLessThanOrEqual(2400);
    expect(size(result.context)).toBeLessThanOrEqual(6000);
    expect(result.omitted).toBe(40 - result.included);
    expect(result.omittedAttention).toBe(20 - result.included);
    expect(result.block).toContain(i18n.t("chat.handoffChildrenOmitted", { count: result.omitted, attention: result.omittedAttention }));
    expect(result.context.length).toBeGreaterThan(result.block.length);
    expect(result.block.match(/codex\/session-\d+/g)).toEqual(result.context.match(/codex\/session-\d+/g));
    for (const text of [result.block, result.context]) {
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
      expect(text).not.toMatch(/\u200d(?=\n)/u);
    }
  });

  it("omits impossible references whole while bounding giant titles and errors", () => {
    const result = digest([
      branch("huge-session", { state: "running", sessionId: "S".repeat(7000) }),
      branch("B".repeat(7000), { state: "failed", sessionId: null }),
      branch("normal", { state: "failed", title: "标题".repeat(5000), error: "错误".repeat(5000), result: "ok" }),
    ]);
    expect(result).toMatchObject({ total: 3, included: 1, omitted: 2, omittedAttention: 2 });
    expect(result.block).toContain("codex/session-normal");
    expect(result.block).toContain(i18n.t("chat.handoffChildrenTruncated"));
    expect(size(result.block)).toBeLessThanOrEqual(2400);
    expect(size(result.context)).toBeLessThanOrEqual(6000);
  });

  it("keeps complete code fences and omits long or unfinished fences without splitting emoji", () => {
    const result = digest([
      branch("short", { result: "```ts\nconst n = 1;\n```\n中文😀" }),
      branch("long", { result: `~~~ts\n${"x".repeat(2000)}\n~~~` }),
      branch("open", { result: "before\n```ts\nstreaming" }),
    ]);
    expect(result.block).toContain("> ```ts\n> const n = 1;\n> ```");
    expect(result.block).toContain("中文😀");
    expect(result.block).not.toContain("~~~");
    expect(result.block).not.toContain("streaming");
    expect(result.block.match(/```/g)).toHaveLength(2);
    expect(result.context.match(/```/g)).toHaveLength(2);
    expect(result.block).toContain(i18n.t("chat.handoffChildrenExcerptOmitted"));
  });

  it("caps even tiny tasks at twelve and preserves unusual identifiers without creating fences", () => {
    const many = digest(Array.from({ length: 20 }, (_, index) => branch(String(index), { result: "" })));
    expect(many.included).toBe(12);
    expect(many.omitted).toBe(8);
    const unusual = digest([branch("id", { sessionId: "session\n```\nvalue" })]);
    expect(unusual.block).toContain('codex/"session\\n```\\nvalue"');
    expect(unusual.block.split("\n").some((line) => line === "> ```")).toBe(false);
  });

  it("keeps quoted fences atomic, including nested quotes and unfinished output", () => {
    const result = digest([
      branch("quoted", { result: "> ```ts\n> const n = 1;\n> ```" }),
      branch("long-quote", { result: `> > ~~~ts\n> > ${"x".repeat(1000)}\n> > ~~~` }),
      branch("unfinished-quote", { result: "> ```ts\n> still running" }),
    ]);
    for (const text of [result.block, result.context]) {
      expect(text).toContain("> > ```ts\n> > const n = 1;\n> > ```");
      expect(text.match(/```/g)).toHaveLength(2);
      expect(text).not.toContain("~~~");
      expect(text).not.toContain("still running");
    }
  });
});
