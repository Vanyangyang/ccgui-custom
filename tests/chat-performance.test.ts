import assert from "node:assert/strict";
import test from "node:test";
import { createAnchorRowsBuilder } from "../src/features/chat/components/timeline-anchors.ts";
import type { TimelineRow } from "../src/features/chat/components/timeline-rows.ts";

function row(seq: number, text: string, role = "user"): TimelineRow {
  return { kind: "msg", message: { seq, text, role }, turnFinal: false };
}

// Original uncached preview algorithm: protect copy and target parity.
function reference(rows: TimelineRow[]) {
  return rows.flatMap((row, rowIndex) => {
    if (row.kind !== "msg" || row.message.role !== "user") return [];
    const lines = row.message.text.split("\n").map(line => line.trim().replace(/\s+/g, " ")).filter(Boolean);
    const first = lines[0] ?? "";
    const description = lines.length > 1 ? lines.slice(1).join(" ") : first.slice(60).trim();
    return [{ id: `u-${row.message.seq}`, rowIndex,
      title: first.length > 60 ? `${first.slice(0, 60)}…` : first,
      ...(description ? { description: description.length > 160 ? `${description.slice(0, 160)}…` : description } : {}),
    }];
  });
}

test("anchor copies match original for long, Unicode, blank and multiline prompts", () => {
  const build = createAnchorRowsBuilder();
  const texts = ["", " \n\t", "short", "中文🙂".repeat(90), "a".repeat(221), " a  b \n \t c  d\n".repeat(80)];
  const rows = texts.map((text, i) => row(i, text));
  assert.deepEqual(build(rows), reference(rows));
});

test("assistant growth reuses anchors; history prepend, edits and row shifts invalidate targets", () => {
  const build = createAnchorRowsBuilder();
  const user = row(1, "question");
  const original = build([user, row(2, "a", "assistant")]);
  assert.strictEqual(build([user, row(2, "answer", "assistant")]), original);
  const scenarios = [
    [row(0, "older"), user, row(2, "answer", "assistant")],
    [row(0, "process", "assistant"), user],
    [row(1, "edited")], [], [user],
  ];
  for (const rows of scenarios) assert.deepEqual(build(rows), reference(rows));
  assert.deepEqual(original, reference([user]));
});

test("anchor builder keeps independent session caches", () => {
  const a = createAnchorRowsBuilder(), b = createAnchorRowsBuilder();
  const rows = [row(1, "first")];
  const cached = a(rows);
  b([row(1, "other session")]);
  assert.strictEqual(a(rows), cached);
  assert.deepEqual(b(rows), cached);
});

