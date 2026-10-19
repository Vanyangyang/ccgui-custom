import { describe, expect, it } from "vitest";
import {
  findBangTrigger,
  findHashTrigger,
} from "@/components/application/ai-chat/agent-prompt-triggers";

/**
 * Trigger contract for the `#` agent and `!` prompt pickers (desktop-cc-gui
 * useTriggerDetection parity): `#` only at line start, `!` at line start or
 * after whitespace, queries never span whitespace and cap at 64 chars.
 */
describe("findHashTrigger", () => {
  it("matches a line-start hash with the query up to the caret", () => {
    expect(findHashTrigger("#rev", 4)).toEqual({ start: 0, query: "rev" });
    expect(findHashTrigger("hello\n#rev", 10)).toEqual({ start: 6, query: "rev" });
  });

  it("matches an empty query right after the hash", () => {
    expect(findHashTrigger("#", 1)).toEqual({ start: 0, query: "" });
  });

  it("rejects mid-line hashes", () => {
    expect(findHashTrigger("a #rev", 6)).toBeNull();
    expect(findHashTrigger("x#rev", 5)).toBeNull();
  });

  it("rejects when the caret is not inside the trigger", () => {
    expect(findHashTrigger("#rev", 0)).toBeNull();
    expect(findHashTrigger("#re v", 5)).toBeNull(); // whitespace ends the query
    expect(findHashTrigger("#rev\nx", 6)).toBeNull();
  });

  it("rejects queries longer than 64 chars", () => {
    expect(findHashTrigger(`#${"a".repeat(64)}`, 65)).toEqual({
      start: 0,
      query: "a".repeat(64),
    });
    expect(findHashTrigger(`#${"a".repeat(65)}`, 66)).toBeNull();
  });
});

describe("findBangTrigger", () => {
  it("matches at line start or after whitespace", () => {
    expect(findBangTrigger("!fix", 4)).toEqual({ start: 0, query: "fix" });
    expect(findBangTrigger("hello\n!fix", 10)).toEqual({ start: 6, query: "fix" });
    expect(findBangTrigger("run !fix", 8)).toEqual({ start: 4, query: "fix" });
  });

  it("rejects a bang right after a word character (Hello!)", () => {
    expect(findBangTrigger("Hello!world", 11)).toBeNull();
    expect(findBangTrigger("Hello!", 6)).toBeNull();
  });

  it("rejects queries with whitespace or over 64 chars", () => {
    expect(findBangTrigger("!fi x", 5)).toBeNull();
    expect(findBangTrigger(`!${"a".repeat(65)}`, 66)).toBeNull();
  });

  it("rejects when the caret is at the text start", () => {
    expect(findBangTrigger("!fix", 0)).toBeNull();
  });
});
