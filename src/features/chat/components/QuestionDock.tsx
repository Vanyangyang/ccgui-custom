import { useChatStore } from "../store";
import { useScopedSessionKey } from "../split/session-scope";
import { QuestionCard } from "./QuestionCard";
import { CodexApprovalCard } from "./CodexApprovalCard";

/**
 * The active session's pending AskUserQuestion, or null. The dock takes over
 * the composer while a question is pending, so both the footer (to hide the
 * composer) and the dock itself resolve it through this hook.
 */
export function usePendingQuestion() {
  const key = useScopedSessionKey();
  return useChatStore((s) => {
    if (!key) return null;
    const messages = s.bySession[key]?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "question" && m.question?.status === "pending") return m;
    }
    return null;
  });
}

/**
 * Question panel that replaces the composer area while the CLI waits on the
 * control protocol: it covers the input box instead of pushing chat content
 * around, and the only exits are answering, the free-form input, or ignore.
 */
export function QuestionDock() {
  const pending = usePendingQuestion();
  if (!pending) return null;
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="rounded-xl border border-border-secondary bg-background-secondary-default px-3.5 py-3 shadow-lg">
        {pending.question?.codexApproval ? <CodexApprovalCard message={pending} /> : <QuestionCard message={pending} />}
      </div>
    </div>
  );
}
