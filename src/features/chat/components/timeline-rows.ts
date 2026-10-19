import type { Message } from "@/lib/ipc";

export type ProcessItem = {
  type: "tool" | "thinking";
  text: string;
  live?: boolean;
  /** Target file of the tool call; renders as a file-type chip. */
  path?: string | null;
  /** Tool-call arguments (object / array / string); expandable in the timeline. */
  args?: unknown;
  /** Tool-call execution result/output. */
  result?: unknown;
};

export type TimelineRow =
  | {
      kind: "msg";
      message: Message;
      turnFinal: boolean;
      /** Tool calls in the turn this final reply closes; set on turnFinal rows only. */
      turnTools?: number;
    }
  | { kind: "process"; items: ProcessItem[]; firstSeq: number };

/** Letters, digits, or emoji make a segment real content. Harnesses emit
 * bare placeholder segments ("·", ".") between tool batches; rendered as a
 * bubble they read as an empty box with a lone dot, and each one splits what
 * should be a single folded tool run into alternating chips. */
const CONTENT_RE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

function isPlaceholderMessage(message: Message): boolean {
  return message.role === "assistant" && !CONTENT_RE.test(message.text);
}

/** Row wrapper caches keyed by message reference. The store grows rows
 * immutably (spread-copy on change), so a message whose reference survived a
 * stream flush reuses its wrapper and memoized row views skip it entirely.
 * WeakMaps keep no message alive beyond the session state that holds it. */
type MsgRow = Extract<TimelineRow, { kind: "msg" }>;
const msgRowCache = new WeakMap<Message, { final?: { tools: number; row: MsgRow }; plain?: MsgRow }>();
const processItemCache = new WeakMap<Message, ProcessItem>();
const processRowCache = new WeakMap<
  Message,
  { items: ProcessItem[]; row: Extract<TimelineRow, { kind: "process" }> }
>();

function getMsgRow(message: Message, turnFinal: boolean, turnTools = 0): MsgRow {
  let slots = msgRowCache.get(message);
  if (!slots) {
    slots = {};
    msgRowCache.set(message, slots);
  }
  if (!turnFinal) {
    slots.plain ??= { kind: "msg", message, turnFinal: false };
    return slots.plain;
  }
  if (!slots.final || slots.final.tools !== turnTools) {
    slots.final = {
      tools: turnTools,
      row: { kind: "msg", message, turnFinal: true, ...(turnTools > 0 ? { turnTools } : {}) },
    };
  }
  return slots.final.row;
}

function getProcessItem(message: Message): ProcessItem {
  let item = processItemCache.get(message);
  if (!item) {
    item = {
      type: message.role === "tool" ? "tool" : "thinking",
      text: message.text,
      live: message.live,
      path: message.path,
      args: message.args,
      result: message.result,
    };
    processItemCache.set(message, item);
  }
  return item;
}

function getProcessRow(first: Message, items: ProcessItem[]): TimelineRow {
  const cached = processRowCache.get(first);
  // Items only ever append (or swap identity wholesale on settle), so an
  // element-wise reference check is a cheap, exact staleness test.
  if (
    cached &&
    cached.items.length === items.length &&
    cached.items.every((item, i) => item === items[i])
  ) {
    return cached.row;
  }
  const row: TimelineRow = { kind: "process", items, firstSeq: first.seq };
  processRowCache.set(first, { items, row });
  return row;
}

/** Fold runs of consecutive tool / thinking messages into single process
 * rows, preserving order — between two chat bubbles there is at most one
 * collapsed chip, never an alternating stack. Row objects are cached per
 * message reference, so rows unaffected by a flush keep their identity and
 * React.memo bails out on them. */
export function buildRows(messages: Message[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (isPlaceholderMessage(message)) {
      i++;
      continue;
    }
    if (message.role === "tool" || message.role === "thinking") {
      const first = message;
      const items: ProcessItem[] = [];
      while (i < messages.length) {
        const step = messages[i];
        if (step.role === "tool" || step.role === "thinking") {
          items.push(getProcessItem(step));
        } else if (!isPlaceholderMessage(step)) {
          break;
        }
        i++;
      }
      rows.push(getProcessRow(first, items));
    } else {
      rows.push(getMsgRow(message, false));
      i++;
    }
  }
  // Tool calls per turn, with the same boundaries the footer uses (each user
  // message starts a turn). The final reply of a turn reports its count.
  const toolsPerTurn: number[] = [0];
  const turnOfRow: number[] = [];
  for (const row of rows) {
    if (row.kind === "msg" && row.message.role === "user" && !row.message.steer) toolsPerTurn.push(0);
    const turn = toolsPerTurn.length - 1;
    turnOfRow.push(turn);
    if (row.kind === "process") {
      toolsPerTurn[turn] += row.items.reduce((n, item) => n + (item.type === "tool" ? 1 : 0), 0);
    }
  }
  // Footer (copy + meta) renders only on a reply's final assistant segment:
  // walk backwards, resetting at each user message. turnFinal variants are
  // cached too — a flip swaps in the other cached wrapper, no mutation.
  let seenAssistant = false;
  for (let j = rows.length - 1; j >= 0; j--) {
    const row = rows[j];
    if (row.kind !== "msg") continue;
    if (row.message.role === "user") {
      if (!row.message.steer) seenAssistant = false;
    } else if (row.message.role === "assistant") {
      const turnFinal = !seenAssistant;
      seenAssistant = true;
      if (turnFinal) rows[j] = getMsgRow(row.message, true, toolsPerTurn[turnOfRow[j]]);
    }
  }
  return rows;
}

export function rowKey(row: TimelineRow): string | number {
  return row.kind === "msg" ? row.message.seq : `process-${row.firstSeq}`;
}

export function toolEntranceKey(processId: number, index: number): string {
  return `${processId}:${index}`;
}

export function collectToolKeys(rows: TimelineRow[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    if (row.kind !== "process") continue;
    row.items.forEach((item, index) => {
      if (item.type === "tool") keys.push(toolEntranceKey(row.firstSeq, index));
    });
  }
  return keys;
}

export function markToolKeys(seen: Set<string>, processId: number, items: ProcessItem[]) {
  items.forEach((item, index) => {
    if (item.type === "tool") seen.add(toolEntranceKey(processId, index));
  });
}
