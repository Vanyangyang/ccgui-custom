import { describe, expect, it } from "vitest";
import { decodePersistedTaskClaims } from "./task-claims";

const claim = { pluginId: "disabled-owner", requestId: "request", runId: "native-run", status: "unknown",
  workspacePath: "G:/project", writePaths: ["src"], session: null };

describe("persisted task claims", () => {
  it("keeps an inactive owner's lock and treats missing write declarations conservatively", () => {
    expect(decodePersistedTaskClaims([claim])[0]).toMatchObject({ pluginId: "disabled-owner", writePaths: ["src"], status: "unknown" });
    expect(decodePersistedTaskClaims([{ ...claim, writePaths: null }])[0].writePaths).toBeNull();
    expect(decodePersistedTaskClaims([{ ...claim, writePaths: [] }])[0].writePaths).toEqual([]);
  });
  it("refuses malformed/duplicate scopes and cannot settle a mismatched session", () => {
    expect(() => decodePersistedTaskClaims(null)).toThrow(/restore/);
    expect(() => decodePersistedTaskClaims([claim, claim])).toThrow(/restore/);
    expect(() => decodePersistedTaskClaims([{ ...claim, writePaths: ["../other"] }])).toThrow(/escapes/);
    expect(decodePersistedTaskClaims([{ ...claim, session: { engine: "codex", sessionId: "thread", workspacePath: "G:/other" } }])[0])
      .toMatchObject({ identityMismatch: true, session: null, writePaths: ["src"] });
  });
});
