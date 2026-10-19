import { describe, expect, it } from "vitest";
import { initialSideRunProgress, reduceSideRunProgress, type SideRunProgress } from "./progress";

describe("side run progress evidence", () => {
  it("records response boundaries without erasing explicit native waits", () => {
    for (const phase of ["responding", "thinking", "tool", "waiting_task", "waiting_user"] as const) {
      const previous = { phase, lastEventAt: 1 };
      expect(reduceSideRunProgress(previous, { kind: "turn_complete", data: { usage: null } }, 2))
        .toEqual({ phase: phase.startsWith("waiting_") ? phase : "waiting", lastEventAt: 2 });
    }
  });

  it("recognizes display-only approval cards without an ordinary question list", () => {
    const previous = initialSideRunProgress();
    for (const kind of ["command", "file", "permissions", "mcp"]) {
      expect(reduceSideRunProgress(previous, { kind: "question", data: {
        requestId: "approval-1", input: { codexApproval: { kind, canApprove: false, grantScope: "once", details: {} } },
      } }, 3)).toEqual({ phase: "waiting_user", lastEventAt: 3 });
    }
    for (const codexApproval of [null, {}, { kind: "command" }, { kind: "unknown", canApprove: true, grantScope: "once" }]) {
      expect(reduceSideRunProgress(previous, { kind: "question", data: { requestId: "approval-1", input: { codexApproval } } }, 3)).toBe(previous);
    }
  });

  it("starts without activity evidence and preserves specific phases across session/running events", () => {
    let progress: SideRunProgress | undefined = initialSideRunProgress();
    expect(progress).toEqual({ phase: "starting", lastEventAt: null });
    const event = (kind: string, data: unknown) => progress = reduceSideRunProgress(progress, { kind, data }, 123);
    expect(event("session", "side")?.phase).toBe("waiting");
    expect(event("thinking", "想一下")?.phase).toBe("thinking");
    expect(event("session", "late")?.phase).toBe("thinking");
    expect(event("message", { role: "tool", text: "Read" })).toEqual({ phase: "tool", toolName: "Read", lastEventAt: 123 });
    expect(event("activity", { state: "running" })?.toolName).toBe("Read");
    expect(event("message", { role: "tool_result", text: "Read" })).toEqual({ phase: "waiting", lastEventAt: 123 });
    expect(event("message", { role: "thinking", text: "thought" })?.phase).toBe("thinking");
    expect(event("message", { role: "assistant", text: "answer" })?.phase).toBe("responding");
    expect(event("delta", "中文😀")?.phase).toBe("responding");
    expect(event("usage", { input_tokens: 2 })?.phase).toBe("responding");
  });

  it("uses only supported retry, warning, compaction and activity payloads", () => {
    let progress: SideRunProgress | undefined = initialSideRunProgress();
    const event = (kind: string, data: unknown) => progress = reduceSideRunProgress(progress, { kind, data }, 456);
    expect(event("retry", { attempt: 2, max: 3, message: "retry 2/3" })).toEqual({ phase: "retrying", lastEventAt: 456, detail: "retry 2/3" });
    expect(event("warn", "upstream busy")?.detail).toBe("upstream busy");
    expect(event("warn", { message: "unknown shape" })?.detail).toBe("upstream busy");
    expect(event("retry", { attempt: 0 })?.phase).toBe("waiting");
    expect(event("compaction", { active: true })?.phase).toBe("compacting");
    expect(event("compaction", { active: false })?.phase).toBe("waiting");
    expect(event("activity", { state: "waiting" })?.phase).toBe("waiting_task");
    expect(event("activity", { state: "requires_action" })?.phase).toBe("waiting_user");
    expect(event("activity", { state: "running" })?.phase).toBe("waiting");
    const before = progress;
    for (const [kind, data] of [["retry", {}], ["compaction", {}], ["activity", "running"], ["tasks", {}], ["mystery", {}]] as const) {
      expect(event(kind, data)).toBe(before);
    }
  });

  it("recognizes explicit user waits without treating tasks or denied permission as completion", () => {
    const question = { requestId: "q", input: { questions: [{ question: "Choose" }] } };
    let progress = reduceSideRunProgress(undefined, { kind: "question", data: question }, 1);
    expect(progress?.phase).toBe("waiting_user");
    progress = reduceSideRunProgress(progress, { kind: "tasks", data: { tasks: [] } }, 2);
    expect(progress).toEqual({ phase: "waiting_user", lastEventAt: 2 });
    progress = reduceSideRunProgress(progress, { kind: "permission_denied", data: { message: "Denied" } }, 3);
    expect(progress).toEqual({ phase: "waiting_user", lastEventAt: 3, detail: "Denied" });
    progress = reduceSideRunProgress(progress, { kind: "question_settled", data: { requestId: "q" } }, 4);
    expect(progress).toEqual({ phase: "waiting", lastEventAt: 4 });
    progress = reduceSideRunProgress(progress, { kind: "plan_review", data: { planId: "p", revision: 1, status: "awaiting_review" } }, 5);
    expect(progress?.phase).toBe("waiting_user");
    progress = reduceSideRunProgress(progress, { kind: "plan_review_settled", data: { planId: "p", revision: 1, status: "approved" } }, 6);
    expect(progress?.phase).toBe("waiting");
    expect(reduceSideRunProgress(progress, { kind: "question", data: {} }, 7)).toBe(progress);
  });
});
