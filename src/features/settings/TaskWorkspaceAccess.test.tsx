import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ invoke: vi.fn(), isWeb: false }));
vi.mock("@/lib/transport", () => transport);
import i18n from "@/lib/i18n";
import { TaskWorkspaceAccess } from "./TaskWorkspaceAccess";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let previousLanguage: string;

beforeEach(() => {
  transport.invoke.mockReset();
  previousLanguage = i18n.language;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await i18n.changeLanguage(previousLanguage);
});

describe("TaskWorkspaceAccess", () => {
  it.each([
    { language: "en", title: "Cross-workspace dispatch", description: "Claude, Codex, AGY, and Cursor can dispatch directly to registered, available, unarchived local workspaces without per-pair permission. Parent permissions and cost approvals still apply." },
    { language: "zh", title: "跨工作区派发", description: "Claude、Codex、AGY 和 Cursor 可直接派发到已登记、可用且未归档的本地工作区，无需逐对授权。父会话权限与成本审批仍按原规则执行。" },
  ])("shows the same static $language explanation on desktop and web without permission IPC", async ({ language, title, description }) => {
    await i18n.changeLanguage(language);
    let desktopMarkup = "";
    for (const isWeb of [false, true]) {
      transport.isWeb = isWeb;
      await act(async () => root.render(<StrictMode><TaskWorkspaceAccess key={String(isWeb)} /></StrictMode>));
      expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(title);
      expect(container.textContent?.trim()).toBe(title + description);
      expect(container.querySelector("button, select, input, [role='combobox']")).toBeNull();
      expect(transport.invoke).not.toHaveBeenCalled();
      if (isWeb) expect(container.innerHTML).toBe(desktopMarkup);
      else desktopMarkup = container.innerHTML;
    }
  });
});
