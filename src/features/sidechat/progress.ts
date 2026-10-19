export interface SideRunProgress {
  phase: "starting" | "waiting" | "thinking" | "responding" | "tool" | "retrying" | "compacting" | "waiting_task" | "waiting_user";
  /** Local receipt time of the last accepted engine event, never a heartbeat. */
  lastEventAt: number | null;
  toolName?: string;
  detail?: string;
}

export function initialSideRunProgress(): SideRunProgress {
  return { phase: "starting", lastEventAt: null };
}

/** Routing, sequence and terminal guards belong to the caller. */
export function reduceSideRunProgress(
  previous: SideRunProgress | undefined,
  event: { kind: string; data: unknown },
  receivedAt: number,
): SideRunProgress | undefined {
  const current = previous ?? initialSideRunProgress();
  const data = event.data;
  const raw = data && typeof data === "object" ? data as Record<string, unknown> : null;
  const touch = () => ({ ...current, lastEventAt: receivedAt });
  const phase = (value: SideRunProgress["phase"], extra: Partial<SideRunProgress> = {}): SideRunProgress =>
    ({ phase: value, lastEventAt: receivedAt, ...extra });
  switch (event.kind) {
    case "session":
      if (typeof data !== "string" || !data.trim()) return previous;
      return current.phase === "starting" ? phase("waiting") : touch();
    case "delta":
    case "thinking":
      if (typeof data !== "string" || !data) return previous;
      return phase(event.kind === "delta" ? "responding" : "thinking");
    case "message":
      if (!raw) return previous;
      if (raw.role === "tool_result" || (raw.role === "tool" && raw.patch === true)) return phase("waiting");
      if (raw.role === "tool") return phase("tool", typeof raw.text === "string" && raw.text.trim() ? { toolName: raw.text.trim() } : {});
      if ((raw.role === "assistant" || raw.role === "thinking") && typeof raw.text === "string" && raw.text.trim()) {
        return phase(raw.role === "assistant" ? "responding" : "thinking");
      }
      return previous;
    case "activity":
      if (raw?.state === "requires_action") return phase("waiting_user");
      if (raw?.state === "waiting") return phase("waiting_task");
      if (raw?.state === "running") {
        return ["thinking", "responding", "tool"].includes(current.phase) ? touch() : phase("waiting");
      }
      return previous;
    case "retry":
      if (typeof raw?.attempt !== "number" || !Number.isFinite(raw.attempt)) return previous;
      if (raw.attempt > 0) return phase("retrying", typeof raw.message === "string" && raw.message.trim() ? { detail: raw.message } : {});
      return current.phase === "retrying" ? phase("waiting") : touch();
    case "compaction":
      if (raw?.active === true) return phase("compacting");
      if (raw?.active === false) return current.phase === "compacting" ? phase("waiting") : touch();
      return previous;
    case "warn":
      return typeof data === "string" && data.trim() ? { ...touch(), detail: data } : previous;
    case "permission_denied":
      return typeof raw?.message === "string" && raw.message.trim() ? { ...touch(), detail: raw.message } : previous;
    case "tasks":
      return Array.isArray(raw?.tasks) ? touch() : previous;
    case "question": {
      const input = raw?.input as { questions?: unknown; codexApproval?: unknown } | undefined;
      const approval = input?.codexApproval as Record<string, unknown> | undefined;
      // ApprovalQuestion carries a display-only card; it need not include the
      // ordinary question list used by requestUserInput.
      const hasApproval = approval && ["command", "file", "permissions", "mcp"].includes(String(approval.kind))
        && typeof approval.canApprove === "boolean" && ["once", "turn"].includes(String(approval.grantScope));
      const hasQuestions = Array.isArray(input?.questions) && input.questions.length > 0;
      return typeof raw?.requestId === "string" && raw.requestId.trim() && (hasQuestions || hasApproval)
        ? phase("waiting_user") : previous;
    }
    case "question_settled":
      if (typeof raw?.requestId !== "string" || !raw.requestId.trim()) return previous;
      return current.phase === "waiting_user" ? phase("waiting") : touch();
    case "plan_review":
    case "plan_review_settled": {
      if (typeof raw?.planId !== "string" || !raw.planId.trim() || typeof raw.revision !== "number" || !Number.isFinite(raw.revision) || raw.revision < 0) return previous;
      const pending = ["awaiting_review", "submitting"].includes(String(raw.status));
      const settled = ["approved", "changes_requested", "deferred", "cancelled", "expired", "superseded"].includes(String(raw.status));
      if (!pending && !settled && raw.status !== "draft") return previous;
      if (event.kind === "plan_review" && pending) return phase("waiting_user");
      return settled && current.phase === "waiting_user" ? phase("waiting") : touch();
    }
    case "turn_complete":
      return current.phase === "waiting_task" || current.phase === "waiting_user" ? touch() : phase("waiting");
    case "usage":
    case "throughput":
    case "error":
    case "done":
    case "model":
    case "effort":
    case "handoff":
    case "auto_review":
      return touch();
    default:
      return previous;
  }
}
