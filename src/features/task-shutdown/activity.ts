import { useChatStore } from "@/features/chat/store";
import type { SessionState } from "@/features/chat/store/stream";
import { isCrossSessionActiveStatus, useCrossSessionActivityStore } from "@/features/chat/cross-session";
import { useMissionStore } from "@/features/mission/store";
import { runStatus } from "@/features/mission/types";
import { getRuntimeActivityReadiness, isRuntimeSubmissionPaused } from "@/lib/runtime-checkpoint";

/** Native process lifetime is checked independently. These are the gaps where
 * accepted UI work exists before/between processes, including parked queues. */
export function hasPendingSessionWork(session: SessionState): boolean {
  return Boolean(
    session.streaming || session.draftLaunching || session.loading || session.retry || session.compaction
    || session.handoff || session.queue.length || session.interruptRequestedAt != null || session.followUpAt != null
    || session.nativeTasks?.some(task => !task.ambient && !["completed", "failed", "stopped"].includes(task.status))
    || session.messages.some(message => message.question?.status === "pending"
      || message.question?.submitting || message.grant?.status === "pending"
      || ["awaiting_review", "submitting"].includes(message.planReview?.status ?? "")),
  );
}

/** Sample once per heartbeat, not on every streamed token. No history parsing,
 * model inference or component subscription is used to decide that work ended. */
export function readTaskShutdownBusy(): boolean {
  const chat = useChatStore.getState();
  if (!chat.initialized || isRuntimeSubmissionPaused()
    || Object.keys(chat.streamingByKey).length || Object.keys(chat.retryingByKey).length
    || Object.values(chat.bySession).some(hasPendingSessionWork)) return true;
  if (useCrossSessionActivityStore.getState().records.some(record =>
    isCrossSessionActiveStatus(record.status))) return true;
  if (Object.values(useMissionStore.getState().runs).some(run =>
    !["done", "cancelled"].includes(runStatus(run)))) return true;
  // Use the final submission hold's activity predicate. Idle UI and historical
  // receipts are not work; native runs and delivery queues remain native-owned.
  return getRuntimeActivityReadiness().length > 0;
}
