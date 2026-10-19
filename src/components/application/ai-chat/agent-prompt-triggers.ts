/**
 * Trigger detection for the composer's `#` agent picker and `!` prompt
 * picker, ported from desktop-cc-gui's useTriggerDetection
 * (detectHashTrigger / detectExclamationTrigger) and shaped after
 * findSlashTrigger (slash-commands.ts): a trigger is the trigger char plus
 * a whitespace-free query spanning the caret.
 */

/** An active `#query` / `!query` trigger at the caret: `start` is the
 *  offset of the trigger char itself, `query` is the text typed after it. */
export interface AgentPromptTrigger {
  start: number;
  query: string;
}

/** Longest query a trigger accepts (findSlashTrigger parity). */
const QUERY_MAX = 64;

/**
 * Find the `#` agent trigger spanning the caret, if any. A trigger is a
 * `#` at the start of a line (text start or after a newline — desktop-cc-gui
 * parity: mid-line hashes are headings/tags, not agents) whose query
 * contains no whitespace.
 */
export function findHashTrigger(
  text: string,
  caret: number,
): AgentPromptTrigger | null {
  if (caret <= 0 || caret > text.length) return null;
  let start = caret - 1;
  while (start >= 0) {
    const ch = text[start];
    if (ch === "#" || /\s/.test(ch)) break;
    start--;
  }
  if (start < 0 || text[start] !== "#") return null;
  // Only line-start hashes open the picker (text start or after a newline).
  if (start > 0 && text[start - 1] !== "\n") return null;
  const query = text.slice(start + 1, caret);
  if (query.length > QUERY_MAX) return null;
  return { start, query };
}

/**
 * Find the `!` prompt trigger spanning the caret, if any. A trigger is a
 * `!` at the start of a line or right after whitespace (desktop-cc-gui
 * parity: "Hello!" must not open the picker) whose query contains no
 * whitespace.
 */
export function findBangTrigger(
  text: string,
  caret: number,
): AgentPromptTrigger | null {
  if (caret <= 0 || caret > text.length) return null;
  let start = caret - 1;
  while (start >= 0) {
    const ch = text[start];
    if (ch === "!" || /\s/.test(ch)) break;
    start--;
  }
  if (start < 0 || text[start] !== "!") return null;
  // Only a bang at line start or after whitespace opens the picker.
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  const query = text.slice(start + 1, caret);
  if (query.length > QUERY_MAX) return null;
  return { start, query };
}
