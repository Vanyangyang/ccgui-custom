import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { collectWindowInputs, DetachedRecoveryPanel } from "./RecoveryPanel";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/base/buttons/button", () => ({ Button: ({ children, size: _size, variant: _variant, ...props }: any) => <button {...props}>{children}</button> }));
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.container.remove(); } vi.restoreAllMocks(); });

function content() {
  const element = document.createElement("div");
  element.innerHTML = '<label>消息<textarea></textarea></label><input type="password" value="never-copy"><input type="hidden" value="never-copy"><input type="file">';
  element.querySelector("textarea")!.value = "  中文草稿👩🏽‍💻\n保留原文与空格  ";
  element.inert = true;
  return element;
}

it("copies exact control values even from an inert view, excluding secrets and file inputs", () => {
  const text = collectWindowInputs(content());
  expect(text).toBe("消息\n  中文草稿👩🏽‍💻\n保留原文与空格  ");
  expect(text).not.toContain("never-copy");
});

it("failed clipboard access preserves selectable input text; recovery and main-window focus never dispatch an action", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const client = { reconcile: vi.fn().mockResolvedValue(false), focusOwner: vi.fn().mockResolvedValue(undefined) };
  const source = content(), container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  await act(async () => root.render(<DetachedRecoveryPanel client={client} status={{ phase: "recovering" }} getContent={() => source} />));
  const click = async (key: string) => { const button = [...container.querySelectorAll("button")].find(b => b.textContent?.includes(key))!;
    await act(async () => { button.click(); await Promise.resolve(); }); };
  await click("copyInputs");
  expect(writeText).toHaveBeenCalledWith(collectWindowInputs(source));
  expect(container.querySelector("textarea")?.value).toBe(collectWindowInputs(source));
  expect(container.querySelector("textarea")?.readOnly).toBe(true);
  expect(container.textContent).toContain("copyManually");
  await click("reconcile"); expect(client.reconcile).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("stillUnconfirmed");
  await click("viewMain"); expect(client.focusOwner).toHaveBeenCalledOnce();
  expect(source.querySelector("textarea")!.value).toBe("  中文草稿👩🏽‍💻\n保留原文与空格  ");
});

it("explains a connection error and exit path without claiming an action is being checked", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  const client = { reconcile: vi.fn(), focusOwner: vi.fn() };
  await act(async () => root.render(<DetachedRecoveryPanel client={client} status={{ phase: "error" }} getContent={() => null} />));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("plugins.detached.connectionError");
  expect(container.textContent).toContain("plugins.detached.recoveryExit");
  expect(container.textContent).not.toContain("plugins.detached.recovering");
});

it("offers input copy and explicit discard actions when return is blocked by unconfirmed edits", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const client = {
    reconcile: vi.fn(),
    focusOwner: vi.fn().mockResolvedValue(undefined),
    discardAndReturn: vi.fn().mockResolvedValue(undefined),
  };
  const source = content(), container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  await act(async () => root.render(
    <DetachedRecoveryPanel client={client} status={{ phase: "detached", returnBlocked: true, blockedReason: "closed" }} getContent={() => source} />,
  ));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("plugins.detached.returnBlocked");
  expect(container.textContent).not.toContain("plugins.detached.reconcile");
  const click = async (key: string) => {
    const button = [...container.querySelectorAll("button")].find(b => b.textContent?.includes(key))!;
    await act(async () => { button.click(); await Promise.resolve(); });
  };
  await click("copyInputs");
  expect(writeText).toHaveBeenCalledWith(collectWindowInputs(source));
  await click("discardAndClose");
  expect(client.discardAndReturn).toHaveBeenCalledWith("closed");
  await click("discardAndReturn");
  expect(client.discardAndReturn).toHaveBeenCalledWith("return");
});
