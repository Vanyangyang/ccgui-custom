import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { GrantCard } from "./components/GrantCard";
import { useChatStore } from "./store";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION } from "./store/stream";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    grantScope: vi.fn(async () => "/data"),
    grantRoot: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));
// Web/remote branch: jsdom has no __TAURI_INTERNALS__ (isWeb true by default),
// pinned explicitly so the intent survives future setup changes.
vi.mock("@/lib/transport", () => ({ isWeb: true }));

const KEY = sessionKey("claude", "s-1", "/tmp/ws");

const PENDING = {
  seq: 9,
  role: "grant" as const,
  text: "Claude requested permissions to read from /data/x.",
  path: "/data/x",
  ts: null,
  grant: { status: "pending" as const, dir: "/data" },
};

describe("GrantCard on the web bridge", () => {
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      active: { engine: "claude", sessionId: "s-1", workspacePath: "/tmp/ws" },
      bySession: {
        [KEY]: { ...EMPTY_SESSION, messages: [PENDING] },
      },
      streamingByKey: {},
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    void i18n.changeLanguage("zh");
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("previews the host directory and offers both permission actions", () => {
    act(() => root.render(<GrantCard message={PENDING} />));
    expect(container.textContent).toContain("/data/x");
    expect(container.textContent).toContain(i18n.t("chat.grantDecline"));
    expect(container.textContent).toContain(i18n.t("chat.grantAllow"));
    expect(container.textContent).toContain(
      i18n.t("chat.grantScopeNote", { dir: "/data" }),
    );
  });

  it("requests the host preview for a remote denial event", async () => {
    useChatStore.setState({ bySession: { [KEY]: { ...EMPTY_SESSION } } });
    const deps: EngineEventDeps = { set: useChatStore.setState, get: useChatStore.getState, drainQueue: () => {}, markUnseenIfBackground: () => {}, upsertSessionMeta: () => {} };
    handleEngineEvents([{ engine: "claude", sessionId: "s-1", runId: "remote-grant", seq: 1, kind: "permission_denied", data: { tool: "Read", path: "/data/x", message: "permission required" } }], deps);
    await vi.waitFor(() => expect(useChatStore.getState().bySession[KEY].messages[0].grant?.dir).toBe("/data"));
    expect(ipc.grantScope).toHaveBeenCalledWith("/data/x");
  });

  it("accepts through the backend only after clicking allow", async () => {
    act(() => root.render(<GrantCard message={PENDING} />));
    expect(ipc.grantRoot).not.toHaveBeenCalled();
    const allow = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(i18n.t("chat.grantAllow")))!;
    await act(async () => allow.click());
    expect(ipc.grantRoot).toHaveBeenCalledExactlyOnceWith("/data/x");
    expect(useChatStore.getState().bySession[KEY].messages[0].grant?.status).toBe("granted");
  });

  it("keeps the request pending and exposes host authorization failures", async () => {
    vi.mocked(ipc.grantRoot).mockRejectedValueOnce(new Error("web access was revoked"));
    act(() => root.render(<GrantCard message={PENDING} />));
    const allow = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(i18n.t("chat.grantAllow")))!;
    await act(async () => allow.click());
    expect(useChatStore.getState().bySession[KEY].messages[0].grant?.status).toBe("pending");
    expect(useChatStore.getState().bySession[KEY].error).toContain("web access was revoked");
  });

  it("declining settles the card without touching the backend", async () => {
    act(() => root.render(<GrantCard message={PENDING} />));
    const decline = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes(i18n.t("chat.grantDecline")),
    );
    expect(decline).toBeDefined();
    await act(async () => decline!.click());
    expect(vi.mocked(ipc.grantRoot)).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const row = useChatStore
        .getState()
        .bySession[KEY]?.messages.find((m) => m.seq === 9);
      expect(row?.grant?.status).toBe("declined");
    });
  });
});
