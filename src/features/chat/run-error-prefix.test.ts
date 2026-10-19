import { describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { localizeRunError } from "./run-error";

describe("known run error prefixes", () => {
  it.each([
    ["CLAUDE_HAIKU_ASSIST_UNAVAILABLE", "chat.haikuAssistUnavailable"],
    ["CODEX_APPROVAL_UNSUPPORTED", "chat.codexApproval.unsupported"],
    ["CODEX_AUTO_REVIEW_UNAVAILABLE", "chat.autoReview.unavailable"],
  ])("localizes %s from both native strings and stringified Errors", (code, key) => {
    for (const prefix of ["", "Error: "]) {
      expect(localizeRunError(`${prefix}${code}: missing capability`, i18n.t))
        .toBe(`${i18n.t(key)}\nmissing capability`);
    }
  });

  it.each(["Error: unknown failure", "Error: FUTURE_CODE: details", "ordinary failure", null])(
    "preserves unknown input %s verbatim", (message) => {
      expect(localizeRunError(message, i18n.t)).toBe(message);
    },
  );
});
