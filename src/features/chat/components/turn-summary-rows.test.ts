import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/ipc";
import { buildRows } from "./timeline-rows";

const msg = (seq: number, role: Message["role"], extra: Partial<Message> = {}): Message =>
  ({ seq, role, text: `消息 ${seq}`, ts: null, ...extra });

describe("turn summary boundaries", () => {
  it("keeps steering inside a turn and ignores question cards when choosing its final reply", () => {
    const rows = buildRows([
      msg(1, "user"), msg(2, "tool"), msg(3, "assistant"),
      msg(4, "user", { steer: true }), msg(5, "tool"), msg(6, "assistant"), msg(7, "question"),
      msg(8, "user"), msg(9, "assistant"),
    ]);
    const final = rows.filter((row) => row.kind === "msg" && row.turnFinal);
    expect(final.map((row) => row.kind === "msg" && [row.message.seq, row.turnTools ?? 0])).toEqual([[6, 2], [9, 0]]);
  });

  it("keeps settled rows stable when a later turn changes", () => {
    const messages = [msg(1, "user"), msg(2, "tool"), msg(3, "assistant")];
    const first = buildRows(messages);
    const next = buildRows([...messages, msg(4, "user"), msg(5, "tool")]);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
    expect(next[2]).toBe(first[2]);
  });
});
