import type { ActiveSession } from "./store/persistence";

/** Temporarily disabled; retain saved tab choices and wire fields for compatibility. */
export const CLAUDE_HAIKU_ASSIST_ENABLED = false;

export function resolveClaudeHaikuAssist(tab: ActiveSession): boolean {
  return CLAUDE_HAIKU_ASSIST_ENABLED && tab.engine === "claude" && tab.claudeHaikuAssist === true;
}
