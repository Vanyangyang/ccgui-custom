import type { AiChatThread } from "@/components/application/ai-chat/sidebar-types";

/** Threads revealed by the first "还有 N 个对话" click. */
const PAGE_SIZE = 50;

/**
 * Thread pagination for one repo: page 0 caps at `threadLimit`, page 1 adds
 * PAGE_SIZE, page 2 shows all. Collapse/expand resets to page 0 so the
 * folder reopens to a short recent list (Codex / Cursor).
 */
export function paginateThreads(
  threads: AiChatThread[],
  threadLimit: number | undefined,
  page: number,
): { visibleThreads: AiChatThread[]; hiddenCount: number } {
  const limit = threadLimit ?? threads.length;
  const visibleCount = page >= 2 ? threads.length : limit + page * PAGE_SIZE;
  const visibleThreads =
    threads.length <= visibleCount ? threads : threads.slice(0, visibleCount);
  return { visibleThreads, hiddenCount: threads.length - visibleThreads.length };
}
