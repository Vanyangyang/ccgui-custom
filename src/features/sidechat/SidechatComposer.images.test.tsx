import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { SidechatComposer } from "./SidechatComposer";
import { useSidechatStore } from "./store";

const capability = vi.hoisted(() => ({ supported: true }));
vi.mock("@/features/chat/store", () => ({ useChatStore: (selector: (state: unknown) => unknown) => selector({ engines: [{ id: "codex", supportsImages: capability.supported }] }) }));
vi.mock("@/lib/ipc", () => ({ ipc: { savePastedImage: vi.fn(), readFile: vi.fn(async () => ({ kind: "other" })) } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const onSend = vi.fn();
function Harness({ id }: { id: string }) {
  const state = useSidechatStore((s) => s.sidechatBySession[id]);
  return <SidechatComposer key={id} sessionKey={id} state={state} onSend={onSend} />;
}
describe("Sidechat image clipboard ownership", () => {
  let host: HTMLDivElement, root: Root;
  beforeEach(async () => {
    vi.clearAllMocks(); capability.supported = true;
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("FileReader", class {
      result = "data:image/png;base64,aGVsbG8=";
      onload: (() => void) | null = null;
      readAsDataURL() { this.onload?.(); }
    });
    vi.mocked(ipc.savePastedImage).mockResolvedValue("/sandbox/shot.png");
    useSidechatStore.setState({ sidechatBySession: {}, btwBySession: {} });
    for (const id of ["a", "b"]) await useSidechatStore.getState().openSidechat({ sessionKey: id, engine: "codex", workspacePath: "/fixture", parentSessionId: id });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<Harness id="a" />));
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  async function paste() {
    const input = host.querySelector("textarea")!;
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { items: [{ kind: "file", type: "image/png", getAsFile: () => new File(["image"], "shot.png", { type: "image/png" }) }] } });
    await act(async () => { input.focus(); input.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  }
  it("saves an image, permits image-only submit, and removes its preview", async () => {
    await paste();
    expect(ipc.savePastedImage).toHaveBeenCalledWith("aGVsbG8=", "png");
    expect(useSidechatStore.getState().sidechatBySession.a.draftImages).toEqual(["/sandbox/shot.png"]);
    expect(host.textContent).toContain("shot.png");
    await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(onSend).toHaveBeenCalledWith("", ["/sandbox/shot.png"]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label$="shot.png"]')!.click());
    expect(useSidechatStore.getState().sidechatBySession.a.draftImages).toEqual([]);
  });
  it("keeps late saves with the original parent across switch and unmount/reopen", async () => {
    let resolve!: (path: string) => void;
    vi.mocked(ipc.savePastedImage).mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    await paste();
    await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness id="b" />));
    await act(async () => resolve("/sandbox/late.png"));
    expect(useSidechatStore.getState().sidechatBySession.a.draftImages).toEqual(["/sandbox/late.png"]);
    expect(useSidechatStore.getState().sidechatBySession.b.draftImages).toBeUndefined();
    expect(host.textContent).not.toContain("late.png");
    await act(async () => root.render(<Harness id="a" />));
    expect(host.textContent).toContain("late.png");
    await act(async () => root.render(null));
    await act(async () => root.render(<Harness id="a" />));
    expect(host.textContent).toContain("late.png");
  });
  it("reports unsupported engines and save failures without submitting", async () => {
    capability.supported = false;
    await act(async () => root.render(<Harness id="a" />));
    await paste();
    expect(ipc.savePastedImage).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    capability.supported = true;
    await act(async () => root.render(<Harness id="a" />));
    vi.mocked(ipc.savePastedImage).mockRejectedValueOnce(new Error("disk full"));
    await paste();
    expect(host.textContent).toContain("disk full");
    expect(onSend).not.toHaveBeenCalled();
  });
});
