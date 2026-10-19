import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/ipc";
import { buildRows } from "./timeline-rows";
import { findTimelineMatches, rowSearchText } from "./timeline-search";

const msg = (seq: number, role: string, text: string): Message => ({
  seq,
  role,
  text,
  ts: null,
});

describe("findTimelineMatches", () => {
  it("returns nothing for a blank query", () => {
    const rows = buildRows([msg(1, "user", "hello")]);
    expect(findTimelineMatches(rows, "")).toEqual([]);
    expect(findTimelineMatches(rows, "   ")).toEqual([]);
  });

  it("matches message text case-insensitively, one entry per occurrence", () => {
    const rows = buildRows([
      msg(1, "user", "Fix the BUG"),
      msg(2, "assistant", "bug one, Bug two"),
    ]);
    expect(findTimelineMatches(rows, "bug")).toEqual([
      { rowIndex: 0 },
      { rowIndex: 1 },
      { rowIndex: 1 },
    ]);
  });

  it("searches folded process rows (thinking + tool steps)", () => {
    const rows = buildRows([
      msg(1, "user", "refactor the store"),
      msg(2, "thinking", "planning the refactor"),
      msg(3, "tool", "read_file"),
      msg(4, "assistant", "done"),
    ]);
    // One process row folds the thinking + tool steps (row index 1).
    expect(rows.map((row) => row.kind)).toEqual(["msg", "process", "msg"]);
    expect(findTimelineMatches(rows, "refactor")).toEqual([
      { rowIndex: 0 },
      { rowIndex: 1 },
    ]);
    expect(findTimelineMatches(rows, "read_file")).toEqual([{ rowIndex: 1 }]);
  });

  it("does not overlap occurrences", () => {
    const rows = buildRows([msg(1, "user", "aaaa")]);
    expect(findTimelineMatches(rows, "aa")).toEqual([
      { rowIndex: 0 },
      { rowIndex: 0 },
    ]);
  });
});

describe("rowSearchText", () => {
  it("joins process items into one searchable blob", () => {
    const rows = buildRows([
      msg(1, "thinking", "think"),
      msg(2, "tool", "bash"),
    ]);
    expect(rowSearchText(rows[0])).toBe("think\nbash");
  });
});
