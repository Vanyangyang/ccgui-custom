import { describe, expect, it } from "vitest";
import { mergeExternalSessions } from "./session-utils";
import type { SessionMeta } from "@/lib/ipc";

const meta = (overrides: Partial<SessionMeta>): SessionMeta => ({
  engine: "codex",
  sessionId: "s-1",
  workspacePath: "~/cxn",
  filePath: "/local/s-1.jsonl",
  fileSize: 1,
  fileMtimeMs: 1,
  title: "local",
  preview: "",
  createdAt: null,
  updatedAt: 1,
  messageCount: 1,
  pinned: false,
  customTitle: null,
  ...overrides,
});

describe("mergeExternalSessions", () => {
  it("keeps local rows untouched when there is nothing external", () => {
    const local = [meta({})];
    expect(mergeExternalSessions(local, [], ["~/cxn"])).toBe(local);
  });

  it("appends external rows inside registered workspaces only", () => {
    const external = [
      meta({ sessionId: "r-1", filePath: "", title: "remote" }),
      meta({ sessionId: "r-2", workspacePath: "~/nope" }),
    ];
    const merged = mergeExternalSessions([meta({})], external, ["~/cxn"]);
    expect(merged.map((m) => m.sessionId)).toEqual(["s-1", "r-1"]);
  });

  it("local wins on the same engine/sessionId/workspacePath", () => {
    const external = [meta({ title: "remote-dup", filePath: "" })];
    const merged = mergeExternalSessions([meta({})], external, ["~/cxn"]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe("local");
  });
});
