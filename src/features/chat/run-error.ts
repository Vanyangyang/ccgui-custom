import type { TFunction } from "i18next";

/** `[codex-desktop:<code>] <English text>`, then Desktop's own words on the
 *  following lines (the backend's `codex_desktop::banner`). */
const CODEX_DESKTOP = /^\[codex-desktop:([a-z_]+)\] [^\n]*/;

/** These end CC GUI's observation without confirming Desktop's task ended. */
export function desktopTaskMayContinue(message: unknown): boolean {
  if (typeof message !== "string") return false;
  const code = CODEX_DESKTOP.exec(message)?.[1];
  return code === "timeout" || code === "stopped" || code === "lost" ||
    code === "unknown" || code === "not_started";
}

/** A turn handed to Codex Desktop ends with a coded banner: show it in the
 *  UI language and keep Desktop's detail. Any other error, or a code this
 *  build does not know, is shown exactly as the engine wrote it. */
export function localizeRunError(message: string | null, t: TFunction): string | null {
  // Error objects stringified by the send path retain this prefix. Strip it
  // only for recognized banners; ordinary errors keep their original text.
  if (message?.startsWith("Error: ")) {
    const candidate = message.slice("Error: ".length);
    if (/^(CLAUDE_HAIKU_ASSIST_UNAVAILABLE|CODEX_APPROVAL_UNSUPPORTED|CODEX_AUTO_REVIEW_UNAVAILABLE):/.test(candidate)) {
      message = candidate;
    }
  }
  if (message?.startsWith("CLAUDE_HAIKU_ASSIST_UNAVAILABLE:")) {
    const detail = message.slice("CLAUDE_HAIKU_ASSIST_UNAVAILABLE:".length).trim();
    return `${t("chat.haikuAssistUnavailable")}${detail ? `\n${detail}` : ""}`;
  }
  if (message?.startsWith("CODEX_APPROVAL_UNSUPPORTED:")) {
    const detail = message.slice("CODEX_APPROVAL_UNSUPPORTED:".length).trim();
    return `${t("chat.codexApproval.unsupported")}${detail ? `\n${detail}` : ""}`;
  }
  if (message?.startsWith("CODEX_AUTO_REVIEW_UNAVAILABLE:")) {
    const detail = message.slice("CODEX_AUTO_REVIEW_UNAVAILABLE:".length).trim();
    return `${t("chat.autoReview.unavailable")}${detail ? `\n${detail}` : ""}`;
  }
  const match = message ? CODEX_DESKTOP.exec(message) : null;
  if (!message || !match) return message;
  const key = `chat.codexDesktop.${match[1]}`;
  const text = t(key);
  if (!text || text === key) return message;
  const detail = message.slice(match[0].length).trim();
  return detail ? `${text}\n${detail}` : text;
}
