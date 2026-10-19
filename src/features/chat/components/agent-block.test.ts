import { describe, expect, it } from "vitest";
import {
  buildAgentBlock,
  hasAgentBlock,
  stripAgentBlock,
} from "./agent-block";

describe("stripAgentBlock", () => {
  it("leaves text without an agent block untouched", () => {
    const text = "hello world\n\nsecond paragraph";
    expect(stripAgentBlock(text)).toEqual({ text });
    expect(hasAgentBlock(text)).toBe(false);
  });

  it("strips a tail block and parses name and icon", () => {
    const text =
      "fix the bug" +
      buildAgentBlock({ name: "Reviewer", icon: "🧐", prompt: "Be strict." });
    expect(hasAgentBlock(text)).toBe(true);
    expect(stripAgentBlock(text)).toEqual({
      text: "fix the bug",
      agentName: "Reviewer",
      agentIcon: "🧐",
    });
  });

  it("omits icon when the icon line is empty", () => {
    const text =
      "hi" + buildAgentBlock({ name: "Solo", prompt: "Do things." });
    expect(stripAgentBlock(text)).toEqual({
      text: "hi",
      agentName: "Solo",
      agentIcon: undefined,
    });
  });

  it("strips a streaming half-block that has no end yet", () => {
    const text = "draft\n\n## Agent Role and Instructions\n\nAgent Name: Rev";
    const stripped = stripAgentBlock(text);
    expect(stripped.text).toBe("draft");
    expect(stripped.agentName).toBe("Rev");
  });

  it("shows an empty body when the message opens with the block", () => {
    const text = buildAgentBlock({
      name: "Opener",
      icon: "🚀",
      prompt: "Lead.",
    }).trimStart();
    const stripped = stripAgentBlock(text);
    expect(stripped.text).toBe("");
    expect(stripped.agentName).toBe("Opener");
    expect(stripped.agentIcon).toBe("🚀");
  });

  it("tolerates CRLF line endings", () => {
    const text =
      "body\r\n\r\n## Agent Role and Instructions\r\n\r\nAgent Name: Win\r\n\r\nDo.";
    const stripped = stripAgentBlock(text);
    expect(stripped.text).toBe("body");
    expect(stripped.agentName).toBe("Win");
  });
});
