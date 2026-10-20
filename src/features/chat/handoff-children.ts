import i18n from "@/lib/i18n";
import { leaderGroupBranches, type LeaderBranch, type LeaderIdentity, type LeaderSnapshot } from "@/features/leader/types";

export interface HandoffChildrenDigest {
  heading: string;
  block: string;
  context: string;
  total: number;
  included: number;
  omitted: number;
  attention: number;
  omittedAttention: number;
}

const length = (text: string) => Array.from(text).length;
const quote = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");
const needsAttention = (branch: LeaderBranch) => branch.expired || branch.state !== "completed";
const omittedText = () => i18n.t("chat.handoffChildrenExcerptOmitted");
const truncatedText = () => i18n.t("chat.handoffChildrenTruncated");
// Preserve unusual identifiers losslessly without letting their newlines create
// Markdown structures inside the quoted digest.
const identifier = (value: string) => /[\r\n]/u.test(value) ? JSON.stringify(value) : value;

// Keep grapheme clusters (including joined emoji) intact, while accounting in
// Unicode code points rather than UTF-16 units.
function clip(text: string, budget: number): string {
  let result = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (length(result) + length(segment) > budget) break;
    result += segment;
  }
  return result;
}

function inline(text: string, budget: number): string {
  const flat = text.replace(/\s+/gu, " ").replace(/[`~]/gu, "ˋ").trim();
  return length(flat) <= budget ? flat : `${clip(flat, budget)}…`;
}

function fenceLine(line: string) {
  const prefix = line.match(/^(?: {0,3}>[ \t]?)+/u)?.[0] ?? "";
  return { text: line.slice(prefix.length), depth: (prefix.match(/>/gu) ?? []).length };
}

/** Fenced blocks are atomic: retain a complete block or replace it as a unit.
 * An unfinished streaming fence is also omitted, never emitted unclosed. */
function excerpt(text: string, budget: number): { text: string; truncated: boolean } {
  const lines = text.replace(/\r\n?/gu, "\n").trim().split("\n");
  const units: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const first = fenceLine(lines[index]);
    const opening = first.text.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (!opening) {
      units.push(lines[index]);
      continue;
    }
    const fence = opening[1];
    const start = index;
    let closed = false;
    while (++index < lines.length) {
      const last = fenceLine(lines[index]);
      const closing = last.text.match(/^ {0,3}(`{3,}|~{3,})\s*$/u)?.[1];
      if (last.depth === first.depth && closing && closing[0] === fence[0] && closing.length >= fence.length) {
        closed = true;
        break;
      }
    }
    units.push(closed ? lines.slice(start, index + 1).join("\n") : omittedText());
  }
  let result = "";
  let truncated = units.join("\n") !== lines.join("\n");
  for (const unit of units) {
    const separator = result ? "\n" : "";
    if (length(quote(result + separator + unit)) <= budget) {
      result += separator + unit;
      continue;
    }
    truncated = true;
    const remaining = budget - length(quote(result + separator));
    const next = /^ {0,3}(`{3,}|~{3,})/u.test(fenceLine(unit.split("\n")[0]).text)
      ? (length(omittedText()) <= remaining ? omittedText() : "")
      : clip(unit, remaining);
    result += separator + next;
    break;
  }
  return { text: result.trim() || omittedText(), truncated };
}

function metadata(branch: LeaderBranch): string {
  const state = branch.state === "completed"
    ? i18n.t("chat.handoffChildrenCompleted")
    : branch.state === "waiting"
      ? i18n.t("chat.handoffChildrenWaiting")
      : i18n.t(`leader.state.${branch.state}`);
  const parts = [inline(branch.title || branch.task || branch.id, 60), state];
  if (branch.expired) parts.push(i18n.t("chat.handoffChildrenExpired"));
  if (branch.state === "running" || branch.state === "starting") parts.push(i18n.t("chat.handoffChildrenPartial"));
  if (branch.error) {
    parts.push(i18n.t("chat.handoffChildrenError", { error: inline(branch.error, 100) }));
    if (length(branch.error) > 100) parts.push(truncatedText());
  }
  // Identifiers are never truncated: a reference too large for the budget
  // causes this whole task to be omitted during selection.
  parts.push(branch.sessionId
    ? `${identifier(branch.engine)}/${identifier(branch.sessionId)}`
    : i18n.t("chat.handoffChildrenBranch", { id: identifier(branch.id) }));
  return parts.join(" | ");
}

function minimum(branch: LeaderBranch): string {
  const flags = branch.resultTruncated || branch.result.trim() ? ` | ${truncatedText()}` : "";
  return `${metadata(branch)}${flags}\n${branch.result.trim() ? omittedText() : i18n.t("chat.handoffChildrenNoResult")}`;
}

export function buildHandoffChildren(snapshot: LeaderSnapshot, source: LeaderIdentity, observedAt: number): HandoffChildrenDigest {
  const heading = i18n.t("chat.handoffChildrenHeading");
  const branches = leaderGroupBranches(snapshot, source).sort((a, b) =>
    Number(needsAttention(b)) - Number(needsAttention(a))
    || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const total = branches.length;
  const attention = branches.filter(needsAttention).length;
  const empty = { heading, block: "", context: "", total, included: 0, omitted: 0, attention, omittedAttention: 0 };
  if (!total) return empty;
  const asOf = i18n.t("chat.handoffChildrenAsOf", { time: new Date(observedAt).toISOString() });
  const control = i18n.t("chat.handoffChildrenControl");
  const omission = (count: number, pending: number) =>
    i18n.t("chat.handoffChildrenOmitted", { count, attention: pending });
  // Reserve the largest possible count footer before selecting the shared set.
  const overhead = length(`${heading}\n\n${quote(asOf)}\n${quote(control)}\n${quote(omission(total, attention))}`);
  const selected: LeaderBranch[] = [];
  let occupied = overhead;
  for (const branch of branches) {
    const cost = length(quote(minimum(branch))) + 1;
    if (selected.length < 12 && occupied + cost <= 2400) {
      selected.push(branch);
      occupied += cost;
    }
  }
  const omitted = total - selected.length;
  const omittedAttention = attention - selected.filter(needsAttention).length;
  function render(budget: number, perResult: number): string {
    let remaining = budget - occupied;
    const items = selected.map((branch, index) => {
      const min = minimum(branch);
      if (!branch.result.trim()) return min;
      const allowance = Math.min(perResult, Math.floor(remaining / (selected.length - index)) + length(quote(omittedText())));
      const result = excerpt(branch.result, allowance);
      const flags = branch.resultTruncated || result.truncated ? ` | ${truncatedText()}` : "";
      const item = `${metadata(branch)}${flags}\n${result.text}`;
      remaining -= length(quote(item)) - length(quote(min));
      return item;
    });
    const body = [asOf, ...items, ...(omitted ? [omission(omitted, omittedAttention)] : []), control];
    return `${heading}\n\n${body.map(quote).join("\n")}`;
  }
  return { heading, block: render(2400, 300), context: render(6000, 800), total, included: selected.length, omitted, attention, omittedAttention };
}
