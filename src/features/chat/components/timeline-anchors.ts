import type { Message } from "@/lib/ipc";
import type { MessageAnchor } from "./MessageAnchorRail";
import type { TimelineRow } from "./timeline-rows";

export type AnchorRow = MessageAnchor & { rowIndex: number };
const TITLE_LIMIT = 60;
const DESCRIPTION_LIMIT = 160;

function preview(message: Message): MessageAnchor {
  const lines = message.text.split("\n")
    .map((line) => line.trim().replace(/\s+/g, " ")).filter(Boolean);
  const first = lines[0] ?? "";
  const description = lines.length > 1 ? lines.slice(1).join(" ") : first.slice(TITLE_LIMIT).trim();
  return {
    id: `u-${message.seq}`,
    title: first.length > TITLE_LIMIT ? `${first.slice(0, TITLE_LIMIT)}…` : first,
    ...(description ? {
      description: description.length > DESCRIPTION_LIMIT
        ? `${description.slice(0, DESCRIPTION_LIMIT)}…` : description,
    } : {}),
  };
}

/** Per-timeline cache: immutable user messages survive assistant deltas.
 * Parse each prompt once, but always recompute row positions (loading older
 * history or replacing a placeholder can shift anchor targets).
 * Weak keys do not retain unloaded messages; only the current result survives.
 */
export function createAnchorRowsBuilder() {
  const previews = new WeakMap<Message, MessageAnchor>();
  let previous: AnchorRow[] = [];
  return (rows: TimelineRow[]): AnchorRow[] => {
    const next: AnchorRow[] = [];
    rows.forEach((row, rowIndex) => {
      if (row.kind !== "msg" || row.message.role !== "user") return;
      let copy = previews.get(row.message);
      if (!copy) {
        copy = preview(row.message);
        previews.set(row.message, copy);
      }
      const old = previous[next.length];
      next.push(old && old.rowIndex === rowIndex && old.id === copy.id &&
        old.title === copy.title && old.description === copy.description
        ? old : { ...copy, rowIndex });
    });
    if (next.length === previous.length && next.every((anchor, i) => anchor === previous[i])) {
      return previous;
    }
    previous = next;
    return next;
  };
}
