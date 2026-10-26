import { describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { localizeRunError } from "./run-error";

describe("known run error prefixes", () => {
  it("shows the localized Cursor gate from worker JSON and stringified errors", () => {
    const message = "Cursor model is not selected in saved settings; select it in Settings → Collaboration and save before sending";
    const envelope = JSON.stringify({ code: "engine_error", message, outcomeUnknown: false });
    for (const value of [message, envelope, `Error: ${envelope}`]) {
      expect(localizeRunError(value, i18n.t)).toBe(i18n.t("settings.cursorModelNotSelected"));
    }
  });
  it.each([
    ["CLAUDE_HAIKU_ASSIST_UNAVAILABLE", "chat.haikuAssistUnavailable"],
    ["CODEX_APPROVAL_UNSUPPORTED", "chat.codexApproval.unsupported"],
    ["CODEX_AUTO_REVIEW_UNAVAILABLE", "chat.autoReview.unavailable"],
    ["ENGINE_PROTOCOL_FRAME_TOO_LARGE", "chat.protocolFrameTooLarge"],
  ])("localizes %s from both native strings and stringified Errors", (code, key) => {
    for (const prefix of ["", "Error: "]) {
      expect(localizeRunError(`${prefix}${code}: missing capability`, i18n.t))
        .toBe(`${i18n.t(key)}\nmissing capability`);
    }
  });

  it.each(["zh", "en"])("localizes an oversized protocol response and preserves its RPC details in %s", (language) => {
    const t = i18n.getFixedT(language);
    const detail = "thread/resume: codex protocol line exceeded the 16 MiB limit; run terminated";
    const message = `ENGINE_PROTOCOL_FRAME_TOO_LARGE: ${detail}`;
    const envelope = JSON.stringify({ code: "engine_error", message, outcomeUnknown: false });
    for (const value of [message, `Error: ${message}`, envelope, `Error: ${envelope}`]) {
      expect(localizeRunError(value, t)).toBe(`${t("chat.protocolFrameTooLarge")}\n${detail}`);
    }
    expect(t("chat.protocolFrameTooLarge")).not.toBe("chat.protocolFrameTooLarge");
  });

  it.each(["Error: unknown failure", "Error: FUTURE_CODE: details", "ordinary failure", null])(
    "preserves unknown input %s verbatim", (message) => {
      expect(localizeRunError(message, i18n.t)).toBe(message);
    },
  );
});
