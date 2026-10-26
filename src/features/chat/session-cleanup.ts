import type { CSSProperties } from "react";
import { create } from "zustand";
import i18n from "@/lib/i18n";
import { ipc, type SessionMeta, type HandoffCompressionSelection } from "@/lib/ipc";
import { EMPTY_SESSION, type SessionState } from "./store/stream";
import type { LeaderSnapshot } from "@/features/leader/types";
import { isLeaderGroupMember } from "@/features/leader/types";
import { parseDraftSessionKey, sessionKey } from "./store/persistence";
import { useChatStore } from "./store";
import { buildHandoffChildren, type HandoffChildrenDigest } from "./handoff-children";
import {
  isHandoffCompressionModel,
  isHandoffCompressionSelection,
  legacyHandoffSelection,
  readHandoffCompressionPreferences,
  saveHandoffCompressionPreferences,
} from "./handoff-preferences";
import { getSessionCacheHeat, getPromptCacheHeatRatio, promptCacheForEngine, type CacheHeat } from "./prompt-cache";
export { getSessionCacheHeat, type CacheHeat };

/** Idle threshold (12 hours) for recommending a settled session in batch cleanup. */
export const CLEANUP_IDLE_RECOMMEND_MS = 12 * 60 * 60 * 1000;

/**
 * Inline CSS color-mix styles for a given heat ratio [0, 1] (scarlet red ⇄ cool gray):
 * - Text/foreground blends `--color-text-error-primary` with `--color-text-tertiary`
 * - Chip background blends `--color-background-tertiary-error` with `--color-background-tertiary-default`
 * - Ring stroke blends `--color-text-error-primary` with `--color-foreground-icon-tertiary`
 */
export function cacheHeatTextColor(ratio: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  if (pct <= 0) return "var(--color-text-tertiary)";
  if (pct >= 100) return "var(--color-text-error-primary)";
  return `color-mix(in oklab, var(--color-text-error-primary) ${pct}%, var(--color-text-tertiary))`;
}

export function cacheHeatChipStyle(ratio: number): CSSProperties {
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  if (pct <= 0) {
    return {
      color: "var(--color-text-tertiary)",
      backgroundColor: "var(--color-background-tertiary-default)",
    };
  }
  if (pct >= 100) {
    return {
      color: "var(--color-text-error-primary)",
      backgroundColor: "var(--color-background-tertiary-error)",
    };
  }
  return {
    color: `color-mix(in oklab, var(--color-text-error-primary) ${pct}%, var(--color-text-tertiary))`,
    backgroundColor: `color-mix(in oklab, var(--color-background-tertiary-error) ${pct}%, var(--color-background-tertiary-default))`,
  };
}

export function cacheHeatRingStroke(ratio: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  if (pct <= 0) return "var(--color-foreground-icon-tertiary)";
  if (pct >= 100) return "var(--color-text-error-primary)";
  return `color-mix(in oklab, var(--color-text-error-primary) ${pct}%, var(--color-foreground-icon-tertiary))`;
}

export type SessionCleanupCategory = "recommend" | "attention" | "protected";

export type SessionCleanupReason =
  | "settled_idle"
  | "settled_recent"
  | "running"
  | "awaiting_confirm"
  | "last_error"
  | "unsent_draft"
  | "unseen"
  | "pinned"
  | "leader_group";

export interface SessionCleanupItem {
  key: string;
  session: SessionMeta;
  category: SessionCleanupCategory;
  reason: SessionCleanupReason;
  heat: CacheHeat;
  heatRatio: number;
  idleMs: number;
  /** Whether the row can be toggled in the batch selection. Running/Leader rows are locked. */
  selectable: boolean;
  /** Pre-selected when opening the cleanup dialog. */
  defaultSelected: boolean;
}

export function classifySessionForCleanup({
  session,
  state,
  streaming,
  unseen,
  draftText,
  leaderSnapshot,
  now = Date.now(),
}: {
  session: SessionMeta;
  state?: SessionState;
  streaming?: boolean;
  unseen?: boolean;
  draftText?: string;
  leaderSnapshot?: LeaderSnapshot;
  now?: number;
}): SessionCleanupItem {
  const key = sessionKey(session.engine, session.sessionId, session.workspacePath);
  const isRunning = Boolean(streaming || state?.streaming || state?.loading || state?.queue.length);
  const heat = getSessionCacheHeat(promptCacheForEngine(session.engine, session.promptCache), now);
  const heatRatio = getPromptCacheHeatRatio(promptCacheForEngine(session.engine, session.promptCache), session.updatedAt, isRunning, now, session.engine);
  const idleMs =
    typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt) && session.updatedAt > 0
      ? Math.max(0, now - session.updatedAt)
      : Number.POSITIVE_INFINITY;

  const isLeaderMember = !!leaderSnapshot && isLeaderGroupMember(leaderSnapshot, session);

  if (isLeaderMember) {
    return {
      key,
      session,
      category: "protected",
      reason: "leader_group",
      heat,
      heatRatio,
      idleMs,
      selectable: false,
      defaultSelected: false,
    };
  }

  if (session.pinned) {
    return {
      key,
      session,
      category: "protected",
      reason: "pinned",
      heat,
      heatRatio,
      idleMs,
      selectable: true,
      defaultSelected: false,
    };
  }

  if (isRunning) {
    return {
      key,
      session,
      category: "attention",
      reason: "running",
      heat,
      heatRatio,
      idleMs,
      selectable: false,
      defaultSelected: false,
    };
  }

  const awaitingConfirm = Boolean(
    state?.messages.some(
      (m) =>
        m.question?.status === "pending" ||
        m.grant?.status === "pending" ||
        ["awaiting_review", "deferred", "submitting"].includes(m.planReview?.status ?? ""),
    ),
  );
  if (awaitingConfirm) {
    return {
      key,
      session,
      category: "attention",
      reason: "awaiting_confirm",
      heat,
      heatRatio,
      idleMs,
      selectable: true,
      defaultSelected: false,
    };
  }

  if (state?.error) {
    return {
      key,
      session,
      category: "attention",
      reason: "last_error",
      heat,
      heatRatio,
      idleMs,
      selectable: true,
      defaultSelected: false,
    };
  }

  if (draftText && draftText.trim().length > 0) {
    return {
      key,
      session,
      category: "attention",
      reason: "unsent_draft",
      heat,
      heatRatio,
      idleMs,
      selectable: true,
      defaultSelected: false,
    };
  }

  if (unseen) {
    return {
      key,
      session,
      category: "attention",
      reason: "unseen",
      heat,
      heatRatio,
      idleMs,
      selectable: true,
      defaultSelected: false,
    };
  }

  const isLongIdle = idleMs >= CLEANUP_IDLE_RECOMMEND_MS;
  return {
    key,
    session,
    category: "recommend",
    reason: isLongIdle ? "settled_idle" : "settled_recent",
    heat,
    heatRatio,
    idleMs,
    selectable: true,
    defaultSelected: isLongIdle,
  };
}

const WRITE_TOOL_RE = /^(?:edit|write|multiedit|notebookedit|replace_file_content|multi_replace_file_content|write_to_file|apply_patch|create_file|str_replace_editor)$/i;

/**
 * Extract recently modified (or touched) files from the session's tool trajectory,
 * inspired by Amp /handoff and Aider trajectory folding (zero-token local pass).
 */
function extractTouchedFiles(state?: SessionState, limit = 6): string[] {
  const messages = state?.messages ?? [];
  const written: string[] = [];
  const touched: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;
    const rawPath = typeof msg.path === "string" ? msg.path.trim() : "";
    if (!rawPath) continue;
    const toolName = (msg.text || "").trim();
    if (WRITE_TOOL_RE.test(toolName)) {
      if (!written.includes(rawPath)) written.push(rawPath);
    } else if (!touched.includes(rawPath)) {
      touched.push(rawPath);
    }
    if (written.length >= limit) break;
  }
  const merged = [...written];
  if (merged.length === 0) {
    for (const p of touched) {
      if (merged.length >= Math.min(3, limit)) break;
      merged.push(p);
    }
  }
  return merged.slice(0, limit);
}

/**
 * Markdown-aware conclusion pruning: collapses multi-line fenced code blocks
 * and selects complete trailing blocks/lines up to `maxChars` so code fences
 * and list items are never sliced in half.
 */
function extractMarkdownConclusion(raw: string, maxChars = 600): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;

  // Collapse long fenced code blocks (> 6 lines) into a compact 1-line summary
  const folded = trimmed.replace(/```([^\n]*)\n([\s\S]*?)```/g, (full, lang: string, body: string) => {
    const lines = body.trimEnd().split(/\r?\n/);
    if (lines.length <= 6) return full;
    const tag = lang.trim() || "code";
    return `\`[${tag}: ${lines.length} lines]\``;
  });

  if (folded.length <= maxChars) return folded;

  const paragraphs = folded.split(/\n{2,}/);
  const picked: string[] = [];
  let total = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i].trim();
    if (!p) continue;
    const added = picked.length === 0 ? p.length : p.length + 2;
    if (total + added > maxChars && picked.length > 0) break;
    if (picked.length === 0 && p.length > maxChars) {
      const lines = p.split(/\r?\n/);
      const tailLines: string[] = [];
      let lineLen = 0;
      for (let j = lines.length - 1; j >= 0; j--) {
        const line = lines[j];
        const nextLen = tailLines.length === 0 ? line.length : line.length + 1;
        if (lineLen + nextLen > maxChars && tailLines.length > 0) break;
        tailLines.unshift(line);
        lineLen += nextLen;
      }
      const joined = tailLines.join("\n").trim();
      picked.unshift(joined.length <= maxChars ? joined : joined.slice(-maxChars).trim());
      break;
    }
    picked.unshift(p);
    total += added;
  }
  return picked.join("\n\n").trim();
}

export type HandoffCompressionMode = "grok" | "local" | "detailed";
export type HandoffGrokStatus = "idle" | "running" | "done" | "error" | "stale";

export const HANDOFF_SECTION_HEADINGS: Record<HandoffCompressionMode, string> = {
  grok: "上一会话交接摘要（模型提炼）：",
  local: "上一会话最后结论摘要：",
  detailed: "上一会话多轮对话摘录：",
};

function extractLastAssistantConclusion(state?: SessionState, maxChars = 600): string {
  const lastAssistant = [...(state?.messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant" && m.text.trim().length > 0);
  return lastAssistant ? extractMarkdownConclusion(lastAssistant.text, maxChars) : "";
}

/**
 * Build a multi-turn Markdown Q&A digest for the `detailed` handoff mode.
 */
export function buildDetailedHandoffSummary(state?: SessionState, maxTurns = 6): string {
  const messages = state?.messages ?? [];
  const turns: { role: "user" | "assistant"; text: string }[] = [];

  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = (msg.text || "").trim();
    if (!text) continue;
    const maxLen = msg.role === "user" ? 320 : 520;
    const compact = extractMarkdownConclusion(text, maxLen);
    if (!compact) continue;
    if (turns.length > 0 && turns[turns.length - 1].role === msg.role && msg.role === "assistant") {
      turns[turns.length - 1].text = compact;
    } else {
      turns.push({ role: msg.role, text: compact });
    }
  }

  const recent = turns.slice(-maxTurns);
  if (recent.length === 0) return "";
  return recent
    .map((turn) => {
      const label = turn.role === "user" ? "用户" : "AI";
      return `**[${label}]**：${turn.text}`;
    })
    .join("\n\n")
    .slice(0, 2400);
}

/**
 * Build a handoff draft for starting a fresh conversation in the same workspace.
 * Supports 3 compression modes:
 * - `grok`: Selected-model summary when available, falling back to local conclusion while in flight
 * - `local`: Zero-token touched files + last assistant conclusion
 * - `detailed`: Zero-token touched files + multi-turn Q&A trajectory digest
 */
export function buildSessionHandoffDraft({
  title,
  engine,
  sessionId,
  state,
  nextTask,
  mode = "local",
  grokSummary,
}: {
  title: string;
  engine: string;
  sessionId: string;
  state?: SessionState;
  nextTask?: string;
  mode?: HandoffCompressionMode;
  grokSummary?: string | null;
}): string {
  const localExcerpt = extractLastAssistantConclusion(state, 600);
  const detailedExcerpt = mode === "detailed" ? buildDetailedHandoffSummary(state, 6) : "";
  const touchedFiles = extractTouchedFiles(state);

  const lines = [
    `承接上一会话「${title}」（${engine}/${sessionId.slice(0, 8)}）：`,
  ];
  if (touchedFiles.length > 0) {
    lines.push(`涉及文件：${touchedFiles.map((f) => `\`${f}\``).join("、")}`);
  }

  let heading = HANDOFF_SECTION_HEADINGS.local;
  let body = localExcerpt;
  if (mode === "grok" && grokSummary && grokSummary.trim()) {
    heading = HANDOFF_SECTION_HEADINGS.grok;
    body = grokSummary.trim();
  } else if (mode === "detailed" && (detailedExcerpt || localExcerpt)) {
    heading = HANDOFF_SECTION_HEADINGS.detailed;
    body = detailedExcerpt || localExcerpt;
  }

  if (body) {
    lines.push("", heading, `> ${body.replace(/\r?\n/g, "\n> ")}`);
  }
  const trailing = nextTask?.trim();
  lines.push("", trailing ? `接下来请继续：${trailing}` : "接下来请继续：");
  return lines.join("\n");
}

/**
 * Build a compact multi-turn trajectory excerpt from a session's in-memory messages
 * for background Cursor CLI distillation with the independent compression model.
 */
export function buildSessionHandoffExcerpt(state?: SessionState, maxTurns = 8): string {
  const messages = state?.messages ?? [];
  const touched = extractTouchedFiles(state, 8);
  const turns: { role: "user" | "assistant"; text: string }[] = [];

  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = (msg.text || "").trim();
    if (!text) continue;
    const compact = extractMarkdownConclusion(text, 650);
    if (!compact) continue;
    if (turns.length > 0 && turns[turns.length - 1].role === msg.role && msg.role === "assistant") {
      turns[turns.length - 1].text = compact;
    } else {
      turns.push({ role: msg.role, text: compact });
    }
  }

  const recent = turns.slice(-maxTurns);
  const parts: string[] = [];
  if (touched.length > 0) {
    parts.push(`涉及文件：${touched.join(", ")}`);
  }
  for (const turn of recent) {
    const label = turn.role === "user" ? "用户" : "AI";
    parts.push(`[${label}]: ${turn.text}`);
  }
  return parts.join("\n\n").slice(0, 5500);
}

/**
 * Seamlessly splice a distilled or mode-switched summary into an existing handoff draft
 * while preserving the header, touched files list, and any user-typed text after `接下来请继续：`.
 * Returns `null` if the user already sent or replaced the handoff draft structure.
 */
function findHandoffHeaderIndex(currentDraft: string): number {
  const headerRe = /(?:^|\n)(承接上一会话「[^\r\n]*」（[^/\r\n]+\/[^\r\n）]+）：)(?=\r?\n|$)/g;
  let lastIdx = -1;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(currentDraft)) !== null) {
    lastIdx = match.index + (match[0].startsWith("\n") ? 1 : 0);
  }
  if (lastIdx !== -1) return lastIdx;
  const fallbackRe = /(?:^|\n)承接上一会话「/g;
  while ((match = fallbackRe.exec(currentDraft)) !== null) {
    lastIdx = match.index + (match[0].startsWith("\n") ? 1 : 0);
  }
  return lastIdx;
}

function handoffSummarySection(currentDraft: string) {
  const headerIdx = findHandoffHeaderIndex(currentDraft);
  if (headerIdx === -1) return null;
  const afterHeader = currentDraft.slice(headerIdx);
  const footerMatch = /\r?\n\r?\n接下来请继续(?:[：:]|(?=\r?\n|$))|\r?\n接下来请继续(?:[：:]|(?=\r?\n|$))/.exec(afterHeader);
  if (!footerMatch || footerMatch.index <= 0) return null;
  const footerIdx = headerIdx + footerMatch.index;

  const section = currentDraft.slice(headerIdx, footerIdx);
  const headings = [...Object.values(HANDOFF_SECTION_HEADINGS), "上一会话交接摘要（Grok 4.7 提炼）："];
  const lines = section.split("\n");
  const start = lines.findIndex((line) => headings.includes(line.replace(/\r$/, "")));
  let end = start + 1;
  if (start >= 0) {
    while (end < lines.length && /^>($| )/.test(lines[end].replace(/\r$/, ""))) end++;
  }
  return {
    headerIdx, footerIdx, lines, start, end,
    // Compare semantic quote lines across LF/CRLF and empty quote spelling,
    // without normalizing or replacing text outside the managed summary.
    snapshot: start < 0 ? "" : lines.slice(start, end)
      .map((line) => line.replace(/\r$/, "").replace(/^> $/, ">"))
      .join("\n"),
  };
}

/** Child context is a separate quote block, outside the replaceable main summary. */
function handoffChildrenBlock(currentDraft: string, heading?: string): string {
  if (!heading) return "";
  const section = handoffSummarySection(currentDraft);
  if (!section) return "";
  const lines = section.lines.map((line) => line.replace(/\r$/, ""));
  const start = lines.indexOf(heading);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && lines[end] === "") end++;
  while (end < lines.length && /^>($| )/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n").trim();
}

export function replaceHandoffDraftSummary(
  currentDraft: string,
  distilledSummary: string,
  sectionHeading: string = HANDOFF_SECTION_HEADINGS.grok,
): string | null {
  const section = handoffSummarySection(currentDraft);
  if (!section) return null;
  const { headerIdx, footerIdx, lines, start, end } = section;
  const cleaned = distilledSummary.trim();
  const quoted = cleaned
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  if (start < 0) {
    if (!cleaned) return currentDraft;
    return currentDraft.slice(0, footerIdx) + `\n\n${sectionHeading}\n${quoted}` + currentDraft.slice(footerIdx);
  }
  if (!cleaned && start > 0 && lines[start - 1].replace(/\r$/, "") === "") {
    lines.splice(start - 1, end - start + 1);
  } else {
    lines.splice(start, end - start, ...(cleaned ? [sectionHeading, quoted] : []));
  }
  return currentDraft.slice(0, headerIdx) + lines.join("\n") + currentDraft.slice(footerIdx);
}

/**
 * Fire-and-forget Stage-2 handoff compression using independent provider routing.
 * Keeps the local draft on failure and reports status through the optional callbacks.
 */
export async function upgradeHandoffDraftWithGrok({
  engine,
  sessionId,
  title,
  state,
  compressionModel,
  compressionSelection,
  childContext,
  getCurrentDraft,
  getExpectedSummary,
  applyDraft,
  onSuccess,
  onError,
}: {
  engine: string;
  sessionId: string;
  title: string;
  state?: SessionState;
  compressionModel?: string;
  compressionSelection?: HandoffCompressionSelection;
  childContext?: string;
  getCurrentDraft: () => string;
  getExpectedSummary?: () => string | undefined;
  applyDraft: (nextDraft: string) => void;
  onSuccess?: (distilled: string) => void;
  onError?: (reason: string) => void;
}): Promise<boolean> {
  try {
    const originalSummary = handoffSummarySection(getCurrentDraft())?.snapshot;
    const transcriptExcerpt = buildSessionHandoffExcerpt(state);
    const distilled = await ipc.summarizeSessionHandoff({
      engine,
      sessionId,
      title,
      transcriptExcerpt: transcriptExcerpt || null,
      ...(childContext?.trim() ? { childContext } : {}),
      ...(compressionModel ? { compressionModel } : {}),
      ...(compressionSelection ? { compressionSelection } : {}),
    });
    if (!distilled || !distilled.trim()) {
      onError?.("Empty summary");
      return false;
    }
    const trimmed = distilled.trim();
    onSuccess?.(trimmed);
    const current = getCurrentDraft();
    // A late model result must not replace a summary the user has edited.
    // Text outside the summary may change freely and is preserved by the splice.
    const expectedSummary = getExpectedSummary ? getExpectedSummary() : originalSummary;
    if (expectedSummary === undefined || handoffSummarySection(current)?.snapshot !== expectedSummary) return true;
    const nextDraft = replaceHandoffDraftSummary(current, trimmed, HANDOFF_SECTION_HEADINGS.grok);
    if (!nextDraft || nextDraft === current) return true;
    applyDraft(nextDraft);
    return true;
  } catch (err) {
    // Graceful fallback: keep the zero-token local handoff draft untouched
    const msg = err instanceof Error ? err.message : String(err || "Unavailable");
    onError?.(msg);
    return false;
  }
}

export interface PendingHandoffSession {
  id: string;
  /** Source directory, never changed when the destination draft moves. */
  workspacePath: string;
  sourceEngine: string;
  sourceSessionId: string;
  sourceTitle: string;
  sourceMeta?: SessionMeta;
  sourceState?: SessionState;
  nextTask?: string;
  mode: HandoffCompressionMode;
  compressionModel: string;
  compressionSelection?: HandoffCompressionSelection;
  compressionPreferenceError?: boolean;
  grokStatus: HandoffGrokStatus;
  grokSummary: string | null;
  /** Child block used by the cached summary, to prevent restoring removed content. */
  grokChildrenBlock?: string;
  grokError: string | null;
  grokStartedAt: number | null;
  grokDurationMs: number | null;
  archiveSourceOnSend: boolean;
  sourceArchived: boolean;
  createdAt: number;
  sending?: boolean;
  /** Last program-authored summary block; manual changes leave this unchanged. */
  managedSummary?: string;
  childrenStatus?: "loading" | "ready" | "error";
  children?: HandoffChildrenDigest;
  childrenApplied?: boolean;
  childrenError?: string;
  /** Exact generated prefix; remove only this text, preserving user additions. */
  workspaceNotice?: string;
}

/**
 * Resolve the draft key for the active or pending new-chat tab in `workspacePath`.
 */
export function resolveHandoffTargetDraftKey(
  workspacePath: string,
  fallbackEngine?: string,
): string {
  const s = useChatStore.getState();
  const entry = useHandoffStore.getState().byWorkspace[workspacePath];
  const activeTab = s.active;
  if (activeTab && activeTab.sessionId === null && activeTab.workspacePath === workspacePath) {
    const activeKey = sessionKey(activeTab.engine, null, workspacePath);
    if (!entry || isHandoffDraft(s.drafts[activeKey] ?? "", entry)) {
      return activeKey;
    }
  }
  if (entry) {
    const matchingTab = s.openTabs.find(
      (t) =>
        t.sessionId === null &&
        t.workspacePath === workspacePath &&
        isHandoffDraft(s.drafts[sessionKey(t.engine, null, workspacePath)] ?? "", entry),
    );
    if (matchingTab) {
      return sessionKey(matchingTab.engine, null, workspacePath);
    }
    for (const [k, text] of Object.entries(s.drafts)) {
      if (parseDraftSessionKey(k)?.workspacePath === workspacePath && isHandoffDraft(text ?? "", entry)) {
        return k;
      }
    }
  }
  const eng =
    activeTab && activeTab.sessionId === null && activeTab.workspacePath === workspacePath
      ? activeTab.engine
      : s.openTabs.find((t) => t.sessionId === null && t.workspacePath === workspacePath)?.engine ||
        s.activeEngine ||
        fallbackEngine ||
        "claude";
  return sessionKey(eng, null, workspacePath);
}

export function isHandoffDraft(currentDraft: string, entry: PendingHandoffSession): boolean {
  return currentDraft.includes(`承接上一会话「${entry.sourceTitle}」（${entry.sourceEngine}/${entry.sourceSessionId.slice(0, 8)}）：`)
    && /(?:^|\r?\n)接下来请继续(?:[：:]|(?=\r?\n|$))/.test(currentDraft);
}

function applyHandoffModeDraft(
  currentDraft: string,
  entry: PendingHandoffSession,
  mode: HandoffCompressionMode,
): string {
  if (entry.sending || !isHandoffDraft(currentDraft, entry)) return currentDraft;
  const localBody = extractLastAssistantConclusion(entry.sourceState, 600);
  const detailedBody = buildDetailedHandoffSummary(entry.sourceState, 6);
  const grokBody = (entry.grokChildrenBlock ?? "") === handoffChildrenBlock(currentDraft, entry.children?.heading)
    ? entry.grokSummary?.trim() || "" : "";

  let heading = HANDOFF_SECTION_HEADINGS.local;
  let body = localBody;
  if (mode === "grok") {
    if (grokBody) {
      heading = HANDOFF_SECTION_HEADINGS.grok;
      body = grokBody;
    } else {
      heading = HANDOFF_SECTION_HEADINGS.local;
      body = localBody;
    }
  } else if (mode === "detailed") {
    heading = HANDOFF_SECTION_HEADINGS.detailed;
    body = detailedBody || localBody;
  }

  const spliced = replaceHandoffDraftSummary(currentDraft, body, heading);
  if (spliced) return spliced;

  return currentDraft;
}

export interface HandoffStoreState {
  byWorkspace: Record<string, PendingHandoffSession>;
  moveHandoffToWorkspace: (workspacePath: string, targetWorkspacePath: string) => boolean;
  startHandoff: (args: {
    workspacePath: string;
    sourceEngine: string;
    sourceSessionId: string;
    sourceTitle: string;
    sourceMeta?: SessionMeta;
    sourceState?: SessionState;
    nextTask?: string;
    archiveSourceOnSend?: boolean;
    initialMode?: HandoffCompressionMode;
  }) => void;
  setCompressionMode: (workspacePath: string, mode: HandoffCompressionMode) => void;
  setCompressionModel: (workspacePath: string, model: string) => void;
  setCompressionSelection: (workspacePath: string, selection: HandoffCompressionSelection) => void;
  retryGrok: (workspacePath: string) => void;
  setArchiveSourceOnSend: (workspacePath: string, enabled: boolean) => void;
  archiveSourceNow: (workspacePath: string) => Promise<void>;
  restoreSourceNow: (workspacePath: string) => Promise<void>;
  dismissHandoff: (workspacePath: string) => void;
  setSending: (workspacePath: string, id: string, sending: boolean) => void;
  completeHandoffOnSend: (workspacePath: string, id: string) => void;
}

let handoffSeq = 0;
const movingHandoffs = new Set<string>();

export const useHandoffStore = create<HandoffStoreState>((set, get) => {
  const requests = new Map<string, number>();
  const insertCapturedChildren = (workspacePath: string, handoffId: string) => {
    const entry = get().byWorkspace[workspacePath];
    if (!entry || entry.id !== handoffId || entry.sending || entry.childrenApplied || !entry.children?.block) return;
    const key = resolveHandoffTargetDraftKey(workspacePath, entry.sourceEngine);
    const draft = useChatStore.getState().drafts[key] ?? "";
    const section = handoffSummarySection(draft);
    if (!isHandoffDraft(draft, entry) || !section
      || section.lines.some((line) => line.replace(/\r$/, "") === entry.children?.heading)) return;
    useChatStore.getState().setDraft(key,
      draft.slice(0, section.footerIdx) + `\n\n${entry.children.block}` + draft.slice(section.footerIdx));
    set((s) => {
      const cur = s.byWorkspace[workspacePath];
      return cur?.id === handoffId
        ? { byWorkspace: { ...s.byWorkspace, [workspacePath]: { ...cur, childrenApplied: true } } }
        : s;
    });
  };
  const runGrokDistillation = (workspacePath: string, handoffId: string) => {
    const entry = get().byWorkspace[workspacePath];
    if (!entry || entry.id !== handoffId || entry.mode !== "grok" || entry.sending || entry.childrenStatus === "loading") return;
    const draftKey = resolveHandoffTargetDraftKey(workspacePath, entry.sourceEngine);
    const initialDraft = useChatStore.getState().drafts[draftKey] ?? "";
    if (!isHandoffDraft(initialDraft, entry)) return;
    const expectedChildren = handoffChildrenBlock(initialDraft, entry.children?.heading);
    // Only the untouched generated block can use the longer source excerpt.
    // Explicit re-distillation after an edit uses exactly the visible child text.
    const childContext = expectedChildren && expectedChildren === entry.children?.block.trim()
      ? entry.children.context : expectedChildren;
    const startedAt = Date.now();
    const request = (requests.get(handoffId) ?? 0) + 1;
    requests.set(handoffId, request);
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [workspacePath]: { ...entry, grokStatus: "running", grokStartedAt: startedAt, grokDurationMs: null, grokError: null },
      },
    }));
    const isCurrent = () => {
      const currentPath = Object.keys(get().byWorkspace).find((path) => get().byWorkspace[path]?.id === handoffId);
      if (currentPath === undefined || requests.get(handoffId) !== request) return false;
      workspacePath = currentPath;
      return true;
    };
    const childrenUnchanged = () => {
      const key = resolveHandoffTargetDraftKey(workspacePath, entry.sourceEngine);
      return handoffChildrenBlock(useChatStore.getState().drafts[key] ?? "", entry.children?.heading) === expectedChildren;
    };
    void upgradeHandoffDraftWithGrok({
      engine: entry.sourceEngine,
      sessionId: entry.sourceSessionId,
      title: entry.sourceTitle,
      state: entry.sourceState,
      childContext,
      compressionModel: entry.compressionModel,
      compressionSelection: entry.compressionSelection ?? legacyHandoffSelection(entry.compressionModel),
      getCurrentDraft: () => {
        if (!isCurrent() || get().byWorkspace[workspacePath]?.sending || !childrenUnchanged()) return "";
        const key = resolveHandoffTargetDraftKey(workspacePath, entry.sourceEngine);
        const draft = useChatStore.getState().drafts[key] ?? "";
        return isHandoffDraft(draft, entry) ? draft : "";
      },
      getExpectedSummary: () => isCurrent() ? get().byWorkspace[workspacePath]?.managedSummary : undefined,
      applyDraft: (nextDraft) => {
        if (!isCurrent()) return;
        const latest = get().byWorkspace[workspacePath];
        if (!latest || latest.sending || latest.mode !== "grok") return;
        const key = resolveHandoffTargetDraftKey(workspacePath, entry.sourceEngine);
        useChatStore.getState().setDraft(key, nextDraft);
        set((s) => {
          const cur = s.byWorkspace[workspacePath];
          if (!cur || cur.id !== handoffId) return s;
          return { byWorkspace: { ...s.byWorkspace, [workspacePath]: { ...cur, managedSummary: handoffSummarySection(nextDraft)?.snapshot } } };
        });
      },
      onSuccess: (distilled) => {
        if (!isCurrent()) return;
        const unchanged = childrenUnchanged();
        const durationMs = Math.max(100, Date.now() - startedAt);
        set((s) => {
          const cur = s.byWorkspace[workspacePath];
          if (!cur || cur.id !== handoffId) return s;
          return {
            byWorkspace: {
              ...s.byWorkspace,
              [workspacePath]: {
                ...cur,
                grokStatus: unchanged ? "done" : "stale",
                grokSummary: unchanged ? distilled : null,
                grokChildrenBlock: unchanged ? expectedChildren : undefined,
                grokError: null,
                grokDurationMs: durationMs,
              },
            },
          };
        });
      },
      onError: (reason) => {
        if (!isCurrent()) return;
        set((s) => {
          const cur = s.byWorkspace[workspacePath];
          if (!cur || cur.id !== handoffId) return s;
          return {
            byWorkspace: {
              ...s.byWorkspace,
              [workspacePath]: {
                ...cur,
                grokStatus: "error",
                grokError: reason,
              },
            },
          };
        });
      },
    });
  };

  return {
    byWorkspace: {},

    moveHandoffToWorkspace: (workspacePath, targetWorkspacePath) => {
      const entry = get().byWorkspace[workspacePath];
      const chat = useChatStore.getState();
      if (!entry || entry.sending || (!chat.workspaces.some((w) => w.path === targetWorkspacePath)
        && targetWorkspacePath !== entry.workspacePath)) return false;
      if (workspacePath !== targetWorkspacePath && get().byWorkspace[targetWorkspacePath]) return false;
      if (workspacePath !== targetWorkspacePath && Object.entries(chat.drafts).some(([key, text]) =>
        parseDraftSessionKey(key)?.workspacePath === targetWorkspacePath && text.trim())) return false;
      const key = resolveHandoffTargetDraftKey(workspacePath, entry.sourceEngine);
      const parsed = parseDraftSessionKey(key);
      const draft = chat.drafts[key] ?? "";
      if (!parsed || !isHandoffDraft(draft, entry)) return false;
      let nextDraft = draft;
      if (entry.workspaceNotice && nextDraft.includes(entry.workspaceNotice)) {
        nextDraft = nextDraft.replace(entry.workspaceNotice, "");
      }
      const workspaceNotice = targetWorkspacePath === entry.workspacePath ? undefined
        : `${i18n.t("chat.handoffWorkspaceNotice", { source: entry.workspacePath, target: targetWorkspacePath })}\n\n`;
      if (workspaceNotice) nextDraft = workspaceNotice + nextDraft;
      movingHandoffs.add(entry.id);
      try {
        if (!chat.moveDraftToWorkspace(parsed.engine, workspacePath, targetWorkspacePath, nextDraft)) return false;
        if (workspacePath === targetWorkspacePath) return true;
        set((s) => {
          const byWorkspace = { ...s.byWorkspace };
          delete byWorkspace[workspacePath];
          byWorkspace[targetWorkspacePath] = { ...entry, workspaceNotice };
          return { byWorkspace };
        });
        return true;
      } finally {
        movingHandoffs.delete(entry.id);
      }
    },

    startHandoff: ({
      workspacePath,
      sourceEngine,
      sourceSessionId,
      sourceTitle,
      sourceMeta,
      sourceState,
      nextTask,
      archiveSourceOnSend = false,
      initialMode: requestedMode,
    }) => {
      const preferences = readHandoffCompressionPreferences();
      const previousId = get().byWorkspace[workspacePath]?.id;
      if (previousId) requests.delete(previousId);
      const initialMode = requestedMode ?? (preferences.enabled ? "grok" : "local");
      const id = `handoff-${++handoffSeq}-${Date.now()}`;
      const now = Date.now();
      const handoffText = buildSessionHandoffDraft({
        title: sourceTitle,
        engine: sourceEngine,
        sessionId: sourceSessionId,
        state: sourceState,
        nextTask,
        mode: initialMode,
      });

      const chatState = useChatStore.getState();
      const targetEngine = chatState.activeEngine || sourceEngine;
      const preKey = sessionKey(targetEngine, null, workspacePath);
      const existingDraft = chatState.drafts[preKey]?.trim() ?? "";
      const existingHeaderIdx = findHandoffHeaderIndex(existingDraft);
      const prefixDraft =
        existingHeaderIdx > 0
          ? existingDraft.slice(0, existingHeaderIdx).trim()
          : existingHeaderIdx === -1
            ? existingDraft
            : "";
      const mergedDraft = prefixDraft ? `${prefixDraft}\n\n${handoffText}` : handoffText;

      chatState.startNewChat(workspacePath);
      const activeAfterStart = useChatStore.getState().active;
      const targetDraftKey = sessionKey(
        activeAfterStart && activeAfterStart.sessionId === null && activeAfterStart.workspacePath === workspacePath
          ? activeAfterStart.engine
          : targetEngine,
        null,
        workspacePath,
      );
      useChatStore.getState().setDraft(targetDraftKey, mergedDraft);

      const entry: PendingHandoffSession = {
        id,
        workspacePath,
        sourceEngine,
        sourceSessionId,
        sourceTitle,
        sourceMeta,
        sourceState,
        nextTask,
        mode: initialMode,
        compressionModel: preferences.model,
        compressionSelection: preferences.selection,
        grokStatus: "idle",
        grokSummary: null,
        grokError: null,
        grokStartedAt: null,
        grokDurationMs: null,
        archiveSourceOnSend,
        sourceArchived: false,
        createdAt: now,
        managedSummary: handoffSummarySection(mergedDraft)?.snapshot,
        childrenStatus: "loading",
      };

      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspacePath]: entry,
        },
      }));

      // If in-memory messages were empty, hydrate from SQLite so local/detailed modes also have rich content
      if ((!sourceState || sourceState.messages.length === 0) && typeof ipc.loadSessionPage === "function") {
        void ipc
          .loadSessionPage(sourceEngine, sourceSessionId, 40)
          .then((page) => {
            if (!page?.messages?.length) return;
            const hydratedState: SessionState = {
              ...(sourceState ?? EMPTY_SESSION),
              messages: page.messages,
            };
            set((s) => {
              const workspacePath = Object.keys(s.byWorkspace).find((path) => s.byWorkspace[path]?.id === id);
              if (workspacePath === undefined) return s;
              const cur = s.byWorkspace[workspacePath];
              if (!cur || cur.id !== id) return s;
              const updated: PendingHandoffSession = { ...cur, sourceState: hydratedState };
              const key = resolveHandoffTargetDraftKey(workspacePath, sourceEngine);
              const currentDraft = useChatStore.getState().drafts[key] ?? "";
              if (!cur.sending && (updated.mode !== "grok" || !updated.grokSummary)
                && cur.managedSummary !== undefined
                && handoffSummarySection(currentDraft)?.snapshot === cur.managedSummary) {
                const nextDraft = applyHandoffModeDraft(currentDraft, updated, updated.mode);
                if (nextDraft && nextDraft !== currentDraft) {
                  useChatStore.getState().setDraft(key, nextDraft);
                  updated.managedSummary = handoffSummarySection(nextDraft)?.snapshot;
                }
              }
              return {
                byWorkspace: {
                  ...s.byWorkspace,
                  [workspacePath]: updated,
                },
              };
            });
          })
          .catch(() => {});
      }

      // Read once for both entry points. Compression waits for this read so it
      // sees child results on its first call, including those absent from the parent.
      void (async () => {
        let children: HandoffChildrenDigest | undefined;
        let error: string | undefined;
        try {
          const snapshot = await ipc.taskSnapshot();
          children = buildHandoffChildren(snapshot, {
            engine: sourceEngine, sessionId: sourceSessionId, workspacePath,
          }, Date.now());
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
        }
        const targetPath = Object.keys(get().byWorkspace).find((path) => get().byWorkspace[path]?.id === id);
        if (targetPath === undefined) return;
        set((s) => {
          const latest = s.byWorkspace[targetPath];
          if (latest?.id !== id) return s;
          return { byWorkspace: { ...s.byWorkspace, [targetPath]: {
            ...latest, childrenStatus: children ? "ready" : "error", children, childrenApplied: !children?.total, childrenError: error,
          } } };
        });
        insertCapturedChildren(targetPath, id);
        runGrokDistillation(targetPath, id);
      })();
    },

    setCompressionMode: (workspacePath, mode) => {
      const entry = get().byWorkspace[workspacePath];
      if (!entry || entry.sending) return;
      const updated: PendingHandoffSession = { ...entry, mode };
      updated.compressionPreferenceError = !saveHandoffCompressionPreferences({
        enabled: mode === "grok", model: entry.compressionModel,
        selection: entry.compressionSelection ?? legacyHandoffSelection(entry.compressionModel),
      });
      if (mode !== "grok") {
        requests.set(entry.id, (requests.get(entry.id) ?? 0) + 1);
        updated.grokStatus = "idle";
        updated.grokStartedAt = null;
        updated.grokError = null;
      } else if (entry.grokSummary) {
        updated.grokStatus = "done";
      }
      const key = resolveHandoffTargetDraftKey(workspacePath, entry.sourceEngine);
      const currentDraft = useChatStore.getState().drafts[key] ?? "";
      if (entry.grokSummary && (entry.grokChildrenBlock ?? "") !== handoffChildrenBlock(currentDraft, entry.children?.heading)) {
        updated.grokSummary = null;
        updated.grokStatus = "idle";
      }
      const shouldRun = mode === "grok" && !updated.grokSummary && entry.grokStatus !== "running";
      const canReplaceSummary = entry.managedSummary !== undefined
        && handoffSummarySection(currentDraft)?.snapshot === entry.managedSummary;
      const nextDraft = canReplaceSummary ? applyHandoffModeDraft(currentDraft, updated, mode) : currentDraft;
      if (canReplaceSummary) updated.managedSummary = handoffSummarySection(nextDraft)?.snapshot;
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspacePath]: updated,
        },
      }));

      if (nextDraft && nextDraft !== currentDraft) {
        useChatStore.getState().setDraft(key, nextDraft);
      }

      if (shouldRun) runGrokDistillation(workspacePath, entry.id);
    },

    setCompressionModel: (workspacePath, rawModel) => {
      const entry = get().byWorkspace[workspacePath];
      const model = rawModel.trim();
      if (!entry || entry.sending || !isHandoffCompressionModel(model) || model === entry.compressionModel) return;
      get().setCompressionSelection(workspacePath, { ...(entry.compressionSelection ?? legacyHandoffSelection(model)), model });
    },

    setCompressionSelection: (workspacePath, selection) => {
      const entry = get().byWorkspace[workspacePath];
      if (!entry || entry.sending || !isHandoffCompressionSelection(selection)) return;
      const current = entry.compressionSelection ?? legacyHandoffSelection(entry.compressionModel);
      if (current.engine === selection.engine && current.model === selection.model
        && current.providerId === selection.providerId && current.effort === selection.effort) return;
      const compressionPreferenceError = !saveHandoffCompressionPreferences({ selection, enabled: entry.mode === "grok" });
      requests.set(entry.id, (requests.get(entry.id) ?? 0) + 1);
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspacePath]: {
            ...entry,
            compressionModel: selection.model,
            compressionSelection: { ...selection },
            compressionPreferenceError,
            grokStatus: "idle",
            grokSummary: null,
            grokError: null,
            grokStartedAt: null,
            grokDurationMs: null,
          },
        },
      }));
      // Selecting a model does not authorize overwriting a hand-edited summary.
      // Keep managedSummary, unlike the explicit "refine again" action.
      if (entry.mode === "grok") runGrokDistillation(workspacePath, entry.id);
    },

    retryGrok: (workspacePath) => {
      const entry = get().byWorkspace[workspacePath];
      if (!entry || entry.sending || entry.mode !== "grok") return;
      const key = resolveHandoffTargetDraftKey(workspacePath, entry.sourceEngine);
      const managedSummary = handoffSummarySection(useChatStore.getState().drafts[key] ?? "")?.snapshot;
      set((s) => {
        const cur = s.byWorkspace[workspacePath];
        if (!cur || cur.id !== entry.id) return s;
        return {
          byWorkspace: {
            ...s.byWorkspace,
            [workspacePath]: {
              ...cur,
              mode: "grok",
              grokStatus: "idle",
              grokError: null,
              grokStartedAt: null,
              managedSummary,
            },
          },
        };
      });
      runGrokDistillation(workspacePath, entry.id);
    },

    setArchiveSourceOnSend: (workspacePath, enabled) => {
      set((s) => {
        const cur = s.byWorkspace[workspacePath];
        if (!cur) return s;
        return {
          byWorkspace: {
            ...s.byWorkspace,
            [workspacePath]: {
              ...cur,
              archiveSourceOnSend: enabled,
            },
          },
        };
      });
    },

    archiveSourceNow: async (workspacePath) => {
      const entry = get().byWorkspace[workspacePath];
      if (!entry || entry.sourceArchived) return;
      const chatStore = useChatStore.getState();
      const meta =
        chatStore.sessions.find(
          (item) => item.engine === entry.sourceEngine && item.sessionId === entry.sourceSessionId
            && item.workspacePath === entry.workspacePath,
        ) ?? entry.sourceMeta;
      if (!meta) return;
      await chatStore.archiveSession(meta);
      if (!useChatStore.getState().archivedSessionKeys[sessionKey(meta.engine, meta.sessionId, meta.workspacePath)]) return;
      set((s) => {
        const workspacePath = Object.keys(s.byWorkspace).find((path) => s.byWorkspace[path]?.id === entry.id);
        if (workspacePath === undefined) return s;
        const cur = s.byWorkspace[workspacePath];
        if (!cur || cur.id !== entry.id) return s;
        return {
          byWorkspace: {
            ...s.byWorkspace,
            [workspacePath]: {
              ...cur,
              sourceArchived: true,
              sourceMeta: meta,
            },
          },
        };
      });
    },

    restoreSourceNow: async (workspacePath) => {
      const entry = get().byWorkspace[workspacePath];
      if (!entry || !entry.sourceArchived || !entry.sourceMeta) return;
      await useChatStore.getState().restoreSession(entry.sourceMeta);
      if (useChatStore.getState().archivedSessionKeys[sessionKey(entry.sourceEngine, entry.sourceSessionId, entry.workspacePath)]) return;
      set((s) => {
        const workspacePath = Object.keys(s.byWorkspace).find((path) => s.byWorkspace[path]?.id === entry.id);
        if (workspacePath === undefined) return s;
        const cur = s.byWorkspace[workspacePath];
        if (!cur || cur.id !== entry.id) return s;
        return {
          byWorkspace: {
            ...s.byWorkspace,
            [workspacePath]: {
              ...cur,
              sourceArchived: false,
            },
          },
        };
      });
    },

    dismissHandoff: (workspacePath) => {
      const id = get().byWorkspace[workspacePath]?.id;
      if (id) requests.delete(id);
      set((s) => {
        if (!(workspacePath in s.byWorkspace)) return s;
        const next = { ...s.byWorkspace };
        delete next[workspacePath];
        return { byWorkspace: next };
      });
    },

    setSending: (workspacePath, id, sending) => {
      const entry = get().byWorkspace[workspacePath];
      if (entry?.id !== id) return;
      const updated = { ...entry, sending };
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspacePath]: updated } }));
      if (entry.sending && !sending) {
        // A failed launch releases the draft. Finish the single deferred read /
        // compression attempt instead of leaving it permanently parked by the lock.
        insertCapturedChildren(workspacePath, id);
        const latest = get().byWorkspace[workspacePath];
        if (latest?.id === id && latest.grokStatus === "idle" && !latest.grokSummary) {
          runGrokDistillation(workspacePath, id);
        }
      }
    },

    completeHandoffOnSend: (workspacePath, id) => {
      const entry = get().byWorkspace[workspacePath];
      if (!entry || entry.id !== id) return;
      requests.delete(entry.id);
      set((s) => {
        const next = { ...s.byWorkspace };
        delete next[workspacePath];
        return { byWorkspace: next };
      });
      if (entry.archiveSourceOnSend && !entry.sourceArchived) {
        const chatStore = useChatStore.getState();
        const meta =
          chatStore.sessions.find(
            (item) => item.engine === entry.sourceEngine && item.sessionId === entry.sourceSessionId
              && item.workspacePath === entry.workspacePath,
          ) ?? entry.sourceMeta;
        if (meta) {
          void chatStore.archiveSession(meta);
        }
      }
    },
  };
});

useChatStore.subscribe?.((state, prevState) => {
  if (state.openTabs === prevState.openTabs) return;
  const byWorkspace = useHandoffStore.getState().byWorkspace;
  for (const [workspacePath, entry] of Object.entries(byWorkspace)) {
    if (!entry || entry.sending || movingHandoffs.has(entry.id)) continue;
    const prevPendingTabs = prevState.openTabs.filter(
      (t) => t.sessionId === null && t.workspacePath === workspacePath,
    );
    const nextPendingTabs = state.openTabs.filter(
      (t) => t.sessionId === null && t.workspacePath === workspacePath,
    );
    if (prevPendingTabs.length > 0 && nextPendingTabs.length === 0) {
      useHandoffStore.getState().dismissHandoff(workspacePath);
      const promotedToSession =
        state.openTabs.length === prevState.openTabs.length &&
        state.openTabs.some((t) => t.sessionId !== null && t.workspacePath === workspacePath);
      if (!promotedToSession) {
        for (const closedTab of prevPendingTabs) {
          const closedKey = sessionKey(closedTab.engine, null, workspacePath);
          const closedDraft = useChatStore.getState().drafts[closedKey] ?? "";
          if (isHandoffDraft(closedDraft, entry)) {
            useChatStore.getState().setDraft(closedKey, "");
          }
        }
      }
    } else if (prevPendingTabs.length === 0 && nextPendingTabs.length > 0) {
      useHandoffStore.getState().dismissHandoff(workspacePath);
    }
  }
});
