import { describe, expect, it } from "vitest";
import { matchesHostTaskSelection } from "./host-task-selection";
import { EMPTY_SESSION } from "./stream";

const tab = { engine: "codex", sessionId: "native", workspacePath: "G:/game" };
describe("continuation native selection fence", () => {
  it.each(["activeModel", "activeEffort", "activeProvider"] as const)("detects an absent choice becoming explicit via %s", field => {
    const launch = { expectedNativeSelection: { model: null, effort: null, providerId: null } };
    const session = { ...EMPTY_SESSION, messages: [], queue: [] };
    expect(matchesHostTaskSelection(tab, session, launch)).toBe(true);
    expect(matchesHostTaskSelection(tab, { ...session, [field]: "new-choice" }, launch)).toBe(false);
  });
  it("retains the initial task's optional-selection semantics without the new fence", () => {
    expect(matchesHostTaskSelection(tab, { ...EMPTY_SESSION, activeEffort: "xhigh" }, {})).toBe(true);
    expect(matchesHostTaskSelection(tab, { ...EMPTY_SESSION, activeEffort: "xhigh" }, { effort: "max" })).toBe(false);
  });
});
