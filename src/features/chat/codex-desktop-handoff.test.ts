import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEventPayload } from "@/lib/events";
import { en } from "@/i18n/en";
import { zh } from "@/i18n/zh";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId, sessionId: null })),
    interruptSession: vi.fn(async () => true),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

// Node ships a `localStorage` that stays undefined without --localstorage-file
// and shadows jsdom's; the store reads it at import time.
if (!globalThis.localStorage) {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, String(v)),
      removeItem: (k: string) => void memory.delete(k),
      clear: () => memory.clear(),
    },
  });
}

const { ipc } = await import("@/lib/ipc");
const { useChatStore } = await import("./store");
const { handleEngineEvents, settledRuns } = await import("./store/engine-events");
type EngineEventDeps = import("./store/engine-events").EngineEventDeps;
const { sessionKey } = await import("./store/persistence");
const { runRouting } = await import("./store/stream");
const { localizeRunError } = await import("./run-error");

const WS = "/tmp/ws";
const NATIVE = sessionKey("codex", "tid-1", WS);
let runCounter = 0;
let runId: string;

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

function ev(kind: EngineEventPayload["kind"], seq: number, data: unknown): EngineEventPayload {
  return { runId, sessionId: "tid-1", engine: "codex", seq, kind, data };
}

const handoff = (stage: string) => ({ host: "codex-desktop", stage, model: "gpt-6.1-sol", effort: "high" });

beforeEach(() => {
  runId = `codex-handoff-${++runCounter}`;
  localStorage.clear();
  vi.clearAllMocks();
  runRouting.clear();
  useChatStore.setState({
    openTabs: [],
    active: null,
    activeEngine: "codex",
    // This tab's own pick, which a Desktop-run turn must not claim.
    models: { codex: "gpt-tab-pick" },
    efforts: { codex: "medium" },
    bySession: {},
    streamingByKey: {},
    unseen: {},
    drafts: {},
  });
});

describe("a turn handed to Codex Desktop", () => {
  it.each(["timeout", "stopped", "lost", "unknown", "not_started"])(
    "%s ends following as an error and parks the queue while Desktop's task is unconfirmed",
    async (code) => {
      useChatStore.getState().startNewChat(WS);
      await useChatStore.getState().send("继续", []);
      const drainQueue = vi.fn();
      const handlers = { ...deps(), drainQueue };
      handleEngineEvents([ev("session", 1, "tid-1"), ev("handoff", 2, handoff("running")), ev("delta", 3, "部分回复 🧭")], handlers);
      const banner = `[codex-desktop:${code}] Following stopped; completion is unconfirmed.`;
      handleEngineEvents([ev("error", 4, banner)], handlers);
      const session = useChatStore.getState().bySession[NATIVE]!;
      expect(session.error).toBe(banner);
      expect(session.streaming).toBe(false);
      expect(session.handoff).toBeNull();
      expect(session.queueParked).toBe(true);
      expect(session.messages.at(-1)).toMatchObject({ text: "部分回复 🧭", model: "gpt-6.1-sol" });
      expect(settledRuns.get(runId)).toBe("error");
      expect(drainQueue).not.toHaveBeenCalled();
      // A late local Done cannot erase the warning or claim external success.
      handleEngineEvents([ev("done", 5, { usage: null })], handlers);
      expect(useChatStore.getState().bySession[NATIVE]?.error).toBe(banner);
      expect(settledRuns.get(runId)).toBe("error");
      expect(drainQueue).not.toHaveBeenCalled();
    },
  );

  it("a confirmed Desktop failure retains the ordinary error queue behavior", async () => {
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("继续", []);
    const drainQueue = vi.fn();
    handleEngineEvents([ev("session", 1, "tid-1"), ev("handoff", 2, handoff("running")),
      ev("error", 3, "[codex-desktop:failed] The turn failed in Codex Desktop.")], { ...deps(), drainQueue });
    expect(drainQueue).toHaveBeenCalledWith(NATIVE);
    expect(useChatStore.getState().bySession[NATIVE]?.queueParked).toBe(false);
  });
  it("shows Desktop's stage and labels its rows with Desktop's settings", async () => {
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("好的", []);
    handleEngineEvents([ev("session", 1, "tid-1"), ev("handoff", 2, handoff("delivering"))], deps());
    expect(useChatStore.getState().bySession[NATIVE]?.handoff?.stage).toBe("delivering");
    handleEngineEvents([
      ev("handoff", 3, handoff("approval")),
      ev("message", 4, { role: "assistant", text: "完成 🧭" }),
    ], deps());
    let session = useChatStore.getState().bySession[NATIVE]!;
    expect(session.handoff).toEqual({ stage: "approval", model: "gpt-6.1-sol", effort: "high" });
    expect(session.streaming).toBe(true);
    handleEngineEvents([ev("done", 5, { usage: null })], deps());
    session = useChatStore.getState().bySession[NATIVE]!;
    expect(session.handoff).toBeNull();
    expect(session.streaming).toBe(false);
    const answer = session.messages.at(-1)!;
    expect(answer).toMatchObject({ role: "assistant", text: "完成 🧭", model: "gpt-6.1-sol", effort: "high" });
  });

  it("a stop ends the hand-off at once and still shows why the run ended", async () => {
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("好的", []);
    handleEngineEvents([ev("session", 1, "tid-1"), ev("handoff", 2, handoff("running"))], deps());
    await useChatStore.getState().interrupt();
    expect(useChatStore.getState().bySession[NATIVE]?.handoff).toBeNull();
    // Target the observed run; a session alias may already belong to a newer
    // turn by the time Stop reaches the backend.
    expect(ipc.interruptSession).toHaveBeenCalledExactlyOnceWith(runId);
    const banner = "[codex-desktop:stopped] Stopped following in CC GUI. The turn keeps running in Codex Desktop; stop it there if needed.";
    handleEngineEvents([ev("error", 3, banner)], deps());
    expect(useChatStore.getState().bySession[NATIVE]?.error).toBe(banner);
  });

  it("a hand-off event that lands while Stop is in flight cannot leave the tab busy", async () => {
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("好的", []);
    handleEngineEvents([ev("session", 1, "tid-1"), ev("handoff", 2, handoff("running"))], deps());
    vi.mocked(ipc.interruptSession).mockImplementationOnce(async () => {
      // Read and dispatched just before the backend saw the stop.
      handleEngineEvents([ev("handoff", 3, handoff("running"))], deps());
      return true;
    });
    await useChatStore.getState().interrupt();
    let session = useChatStore.getState().bySession[NATIVE]!;
    expect(session.streaming).toBe(false);
    expect(session.handoff).toBeNull();
    expect(useChatStore.getState().streamingByKey[NATIVE]).toBeFalsy();
    const banner = "[codex-desktop:stopped] Stopped following in CC GUI. The turn keeps running in Codex Desktop; stop it there if needed.";
    handleEngineEvents([ev("error", 4, banner)], deps());
    session = useChatStore.getState().bySession[NATIVE]!;
    expect(session.error).toBe(banner);
    expect(session.streaming).toBe(false);
  });

  it("chunks flushed at the end of a Desktop turn never take this tab's model", async () => {
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("好的", []);
    handleEngineEvents([
      ev("session", 1, "tid-1"),
      ev("handoff", 2, { stage: "running", model: null, effort: null }),
      ev("delta", 3, "partial answer"),
      ev("done", 4, { usage: null }),
    ], deps());
    const answer = useChatStore.getState().bySession[NATIVE]!.messages.at(-1)!;
    expect(answer).toMatchObject({ role: "assistant", text: "partial answer" });
    expect(answer.model).toBeFalsy();
  });

  it("an unknown stage reads as running, and a coded error ends the hand-off", async () => {
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("继续", []);
    handleEngineEvents([ev("session", 1, "tid-1"), ev("handoff", 2, { stage: "newer-stage" })], deps());
    expect(useChatStore.getState().bySession[NATIVE]?.handoff).toEqual({ stage: "running", model: null, effort: null });
    const banner = "[codex-desktop:stopped] Stopped following in CC GUI. The turn keeps running in Codex Desktop; stop it there if needed.";
    handleEngineEvents([ev("error", 3, banner)], deps());
    const session = useChatStore.getState().bySession[NATIVE]!;
    expect(session.handoff).toBeNull();
    expect(session.error).toBe(banner);
  });
});

describe("localizeRunError", () => {
  const t = ((key: string) => {
    const [, , code] = key.split(".");
    return (zh.chat.codexDesktop as Record<string, string>)[code] ?? key;
  }) as unknown as Parameters<typeof localizeRunError>[1];

  it("renders coded hand-off banners in the UI language and keeps Desktop's detail", () => {
    expect(localizeRunError("[codex-desktop:failed] The turn failed in Codex Desktop.\nupstream 502", t))
      .toBe(`${zh.chat.codexDesktop.failed}\nupstream 502`);
    expect(localizeRunError("[codex-desktop:unknown] CC GUI can't confirm that Codex Desktop received the message.", t))
      .toBe(zh.chat.codexDesktop.unknown);
  });

  it("leaves other errors and codes this build does not know as written", () => {
    expect(localizeRunError(null, t)).toBeNull();
    expect(localizeRunError("thread x already has an active writer", t)).toBe("thread x already has an active writer");
    expect(localizeRunError("[codex-desktop:brand_new] Something newer.", t)).toBe("[codex-desktop:brand_new] Something newer.");
  });

  it("has a message in both languages for every code the backend sends", () => {
    const codes = ["disabled", "images", "settings", "unavailable", "elsewhere", "workspace", "rejected", "unknown",
      "failed", "interrupted", "stopped", "timeout", "not_started", "lost"];
    for (const messages of [zh, en]) {
      expect(Object.keys(messages.chat.codexDesktop).sort()).toEqual([...codes].sort());
      for (const stage of ["delivering", "waiting", "running", "approval", "input", "attention"]) {
        expect((messages.chat.handoff as Record<string, string>)[stage]).toBeTruthy();
      }
    }
  });
});
