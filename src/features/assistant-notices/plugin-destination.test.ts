import { describe, expect, it, vi } from "vitest";
import { registerPluginNoticeDestination, resolvePluginNoticeDestination } from "./plugin-destination";

const source = { engine: "codex", sessionId: "session", workspacePath: "G:/game" };
const destination = (requestId: string | null) => ({
  resolve: vi.fn(async () => requestId),
  deliver: vi.fn(async () => true),
  present: vi.fn(async () => ({ windowId: "window" })),
});

describe("plugin notice destinations", () => {
  it("routes only a uniquely claimed source and invalidates a disposed owner", async () => {
    const first = destination("coord"), other = destination(null);
    const offFirst = registerPluginNoticeDestination(first), offOther = registerPluginNoticeDestination(other);
    try {
      const match = await resolvePluginNoticeDestination(source);
      expect(match?.requestId).toBe("coord");
      await expect(match!.deliver({ source, requestId: "coord", noticeId: "n", action: "open", signal: new AbortController().signal })).resolves.toBe(true);
      offFirst();
      await expect(match!.present()).rejects.toThrow(/unavailable/);
      expect(await resolvePluginNoticeDestination(source)).toBeNull();
    } finally { offFirst(); offOther(); }
  });

  it("rejects ambiguous claims instead of selecting another conversation", async () => {
    const offFirst = registerPluginNoticeDestination(destination("one")), offSecond = registerPluginNoticeDestination(destination("two"));
    try { await expect(resolvePluginNoticeDestination(source)).rejects.toThrow(/Ambiguous/); }
    finally { offFirst(); offSecond(); }
  });
});
