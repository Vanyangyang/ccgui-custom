import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { SidebarPrimaryNav } from "./sidebar-chrome";

/**
 * M0 入口验收：侧栏「自动化」占位项被原生「任务工作台」取代，
 * 点击打开工作台中心页签。
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SidebarPrimaryNav", () => {
  it("replaces the automation placeholder with the native mission workbench entry", () => {
    const onOpenMission = vi.fn();
    act(() => {
      root.render(
        <SidebarPrimaryNav
          onNewSession={() => {}}
          onNewBrowser={() => {}}
          onOpenMission={onOpenMission}
        />,
      );
    });

    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toContain("新建会话");
    expect(labels).toContain("新建浏览器");
    expect(labels).toContain("任务工作台");
    expect(container.textContent).not.toContain("自动化");
    expect(container.textContent).not.toContain("即将开放");

    const entry = container.querySelector<HTMLButtonElement>('button[aria-label="任务工作台"]')!;
    act(() => {
      entry.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenMission).toHaveBeenCalledTimes(1);
  });

  it("puts the 插件 hub entry directly under 新建会话", () => {
    const onOpenPlugins = vi.fn();
    act(() => {
      root.render(
        <SidebarPrimaryNav
          onNewSession={() => {}}
          onOpenPlugins={onOpenPlugins}
        />,
      );
    });

    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels[0]).toBe("新建会话");
    expect(labels[1]).toBe("插件");

    const entry = container.querySelector<HTMLButtonElement>('button[aria-label="插件"]')!;
    act(() => {
      entry.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenPlugins).toHaveBeenCalledTimes(1);
  });
});
