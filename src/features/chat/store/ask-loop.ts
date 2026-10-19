import type { Message } from "@/lib/ipc";

/**
 * Multi-select rounds of the pi/omp ask tool, as they arrive over the extension
 * UI bridge.
 *
 * The CLI's rpc UI has no checkbox channel (its `select` frame carries a title
 * and option labels, nothing else), so the CLI drives a multi-select question as
 * a *loop*: it re-asks the same question after every answer, prefixing the title
 * with `(N selected) `, until the round ends through `Other (type your own)` —
 * the only row that reaches the CLI's own editor, whose text wins over the
 * toggled set when the tool formats its result.
 *
 * Answering such a frame with a label instead of the terminator toggles the
 * CLI's set and re-asks with a fresh request id, which is why every answer used
 * to stack another card. So the UI takes the round over: the card collects the
 * labels locally and one submit sends the terminator, then answers the editor
 * the CLI opens with the labels joined. Only the runtime rows a round can be
 * resumed from are parsed here; the CLI's set is never tracked — it cannot reach
 * the result anyway.
 */

/** Free-form row the CLI appends to every question (pi's `OTHER_OPTION`, also
 * the app's pi bridge): selecting it hands the answer to the CLI's editor. */
export const ASK_OTHER_OPTION = "Other (type your own)";
/** Suffix of the synthetic done row a single-question multi ask offers once
 * something is picked; the leading glyph is theme-owned, only this is stable. */
const DONE_SUFFIX = " Done selecting";
const SELECTED_PREFIX = /^\((\d+) selected\) /;
const SELECTED_SUFFIX = / \((\d+) selected\)$/;
const PROGRESS_SUFFIX = / \((\d+)\/(\d+)\)$/;

export interface AskOptionLike {
  label: string;
}

export interface AskFrame<T extends AskOptionLike = AskOptionLike> {
  /** The question as the CLI declared it: selected-count marker and progress
   * suffix removed. */
  base: string;
  /** `(index, total)` of a multi-question ask, null for a solo question. */
  progress: [number, number] | null;
  /** The question's own options (preserved whole), runtime rows removed. */
  options: T[];
  /** Count the CLI reported as selected, null while nothing is selected. */
  selectedCount: number | null;
}

/** Split a frame's runtime rows (free-form `Other`, and the done row) from the
 * question's own options. */
function ownOptions<T extends AskOptionLike>(options: readonly T[]): T[] {
  const kept: T[] = [];
  let seenOther = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i]!;
    const label = option.label;
    const last = i === options.length - 1;
    if (!seenOther && (label === ASK_OTHER_OPTION || (last && /^Other\s*\(/i.test(label)))) {
      seenOther = true;
      continue;
    }
    if (label.endsWith(DONE_SUFFIX)) continue;
    kept.push(option);
  }
  return kept;
}

export function parseAskFrame<T extends AskOptionLike>(
  title: string,
  options: readonly T[],
): AskFrame<T> {
  let text = title;
  let selectedCount: number | null = null;
  const prefixed = SELECTED_PREFIX.exec(title);
  if (prefixed) {
    selectedCount = Number(prefixed[1]);
    text = title.slice(prefixed[0].length);
  } else {
    const suffixed = SELECTED_SUFFIX.exec(title);
    if (suffixed) {
      selectedCount = Number(suffixed[1]);
      text = title.slice(0, title.length - suffixed[0].length);
    }
  }
  const at = PROGRESS_SUFFIX.exec(text);
  return {
    base: at ? text.slice(0, text.length - at[0].length) : text,
    progress: at ? [Number(at[1]), Number(at[2])] : null,
    options: ownOptions(options),
    selectedCount,
  };
}

/** Question entries of the ask tool's args (omp's `ask`, the app's pi bridge). */
interface DeclaredQuestion {
  question?: unknown;
  multi?: unknown;
  options?: unknown;
}

/** The declared questions of the most recent tool row that carries any. */
function declaredQuestions(messages: readonly Message[]): DeclaredQuestion[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const questions = (messages[i]?.args as { questions?: unknown } | null | undefined)?.questions;
    if (Array.isArray(questions) && questions.length > 0) {
      return questions as DeclaredQuestion[];
    }
  }
  return null;
}

/**
 * Whether the ask tool declared this frame's question multi-select. The frame is
 * matched to the declared question by progress index, question text and option
 * list, so a row left over from an earlier ask cannot label it.
 */
export function declaredMulti(messages: readonly Message[], frame: AskFrame): boolean {
  const declared = declaredQuestions(messages)?.[(frame.progress?.[0] ?? 1) - 1];
  if (!declared || declared.multi !== true) return false;
  if (String(declared.question ?? "").trim() !== frame.base.trim()) return false;
  const labels = Array.isArray(declared.options)
    ? (declared.options as AskOptionLike[])
        .map((option) => option?.label)
        .filter((label): label is string => typeof label === "string")
    : [];
  const own = frame.options.map((option) => option.label);
  return (
    labels.length > 0 &&
    labels.length === own.length &&
    labels.every((label, index) => label === own[index])
  );
}

/**
 * One multi-select round this session owns: the card row it renders as, the
 * request id currently parked in the CLI, and the text the round ends with.
 */
export interface AskLoop {
  /** Declared question text: the key the CLI's editor answer is delivered as. */
  base: string;
  /** Seq of the card row the round renders in. */
  seq: number;
  /** Request id the CLI is waiting on right now. */
  requestId: string;
  runId: string;
  /** Text handed to the CLI's editor once it opens. */
  text: string;
  /** `open`: collecting picks. `sent`: terminator sent, editor expected. */
  phase: "open" | "sent";
}

/** Live rounds per session key. */
export const askLoops = new Map<string, AskLoop>();

export function openAskLoop(
  key: string,
  loop: { base: string; seq: number; requestId: string; runId: string },
): void {
  askLoops.set(key, { ...loop, text: "", phase: "open" });
}

/** Arm the loop for a submit: the terminator travels instead of the answer. */
export function beginAskSubmit(key: string, runId: string, seq: number, text: string): AskLoop | undefined {
  const loop = askLoops.get(key);
  if (!loop || loop.runId !== runId || loop.seq !== seq) return undefined;
  loop.text = text;
  loop.phase = "sent";
  return loop;
}

/** The terminator write failed: the card stays answerable. */
export function revertAskSubmit(key: string, runId: string, seq: number): void {
  const loop = askLoops.get(key);
  if (loop?.runId === runId && loop.seq === seq) loop.phase = "open";
}

/**
 * Claim the next free-form frame for a submitted round. Only an armed loop
 * takes one, and taking it retires the round: an editor frame that belongs to
 * anything else (another plugin, a later ask) renders as its own card.
 */
export function takeAskEditor(key: string, runId: string): AskLoop | undefined {
  const loop = askLoops.get(key);
  if (!loop || loop.runId !== runId || loop.phase !== "sent") return undefined;
  askLoops.delete(key);
  return loop;
}
