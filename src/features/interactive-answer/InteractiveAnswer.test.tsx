import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import InteractiveAnswer from "./InteractiveAnswer";
import { SessionScope } from "@/features/chat/split/session-scope";

const mock = vi.hoisted(() => {
  const state = {
    active: { engine: "codex", sessionId: "focused", workspacePath: "/work" },
    openTabs: [], drafts: { "codex/origin": "Existing draft", "codex/focused": "Other draft" } as Record<string, string>,
    setDraft: vi.fn(), send: vi.fn(),
  };
  return { state, invoke: vi.fn() };
});
vi.mock("@/lib/transport", () => ({ invoke: mock.invoke }));
vi.mock("@/features/chat/store", () => ({ useChatStore: Object.assign((select: (s: typeof mock.state) => unknown) => select(mock.state), { getState: () => mock.state }) }));
vi.mock("@/features/chat/store/stream", () => ({ resolveLiveSessionKey: (key: string) => key }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { await act(async () => roots.splice(0).forEach(root => root.unmount())); document.body.innerHTML = ""; vi.clearAllMocks(); vi.useRealTimers(); });

describe("answer draft continuation", () => {
  async function render(identity?: string) {
    mock.invoke.mockResolvedValue({ revision: 1, values: { $n: 7 }, sourceHash: "a".repeat(64) });
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container); roots.push(root);
    await act(async () => root.render(<SessionScope session={{ engine: "codex", sessionId: "origin", workspacePath: "/work" }}>
      <InteractiveAnswer source={'root = Stack([NumberInput($n, "N", 0, 100)])\n$n = 1'} complete streaming={false} identity={identity} />
    </SessionScope>));
    return container;
  }
  it("appends hydrated current parameters to originating pane draft without sending or changing active", async () => {
    const identity = JSON.stringify([JSON.stringify(["codex/origin", 2]), 0]);
    const container = await render(identity);
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(input.value).toBe("7");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "9");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("continueParameters"))!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(mock.state.setDraft).toHaveBeenCalledTimes(1);
    const [key, text] = mock.state.setDraft.mock.calls[0];
    expect(key).toBe("codex/origin");
    expect(text).toMatch(/^Existing draft\n\n/);
    expect(text).toContain('"$n":9');
    expect(text).toContain("sourceSha256");
    expect(mock.state.active.sessionId).toBe("focused");
    expect(mock.state.send).not.toHaveBeenCalled();
  });
  it("disables insertion when source identity does not match the pane", async () => {
    const container = await render(JSON.stringify([JSON.stringify(["codex/another", 2]), 0]));
    const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("continueParameters"))!;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("feedbackUnavailable");
  });
  it("reloads conflicting saved values only when the explicit reload action is clicked", async () => {
    vi.useFakeTimers();
    const container = await render(JSON.stringify([JSON.stringify(["codex/origin", 99]), 0]));
    mock.invoke.mockRejectedValue(new Error("interactive_answer_conflict"));
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "9");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(input.value).toBe("9");
    const reload = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("reloadSaved"))!;
    expect(reload).toBeTruthy();
    mock.invoke.mockRejectedValue(new Error("offline"));
    await act(async () => reload.click());
    expect(reload.disabled).toBe(true);
    expect(input.value).toBe("9");
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(reload.querySelector(".text-notification-success-foreground")?.classList.contains("opacity-0")).toBe(true);
    expect(reload.disabled).toBe(false);
    mock.invoke.mockResolvedValue({ revision: 8, values: { $n: 4 }, sourceHash: "a".repeat(64) });
    await act(async () => reload.click());
    expect((container.querySelector('input[type="number"]') as HTMLInputElement).value).toBe("4");
    expect(mock.state.setDraft).not.toHaveBeenCalled(); expect(mock.state.send).not.toHaveBeenCalled();
  });
});
