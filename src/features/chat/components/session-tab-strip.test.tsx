import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionTabStrip, type SessionTabItem } from "./SessionTabStrip";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  // 部分 mock：页签条的新菜单会（经分屏 store）间接引入 lib/i18n，
  // 它需要真实的 initReactI18next 才能初始化。
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});
// jsdom gaps exercised by use-tab-strip-chrome's scroll-into-view effect.
globalThis.CSS ??= {} as typeof CSS;
CSS.escape ??= (value: string) => value;
Element.prototype.scrollIntoView ??= () => {};

const TABS: SessionTabItem[] = [
  { key: "a", label: "Alpha", streaming: false },
  { key: "b", label: "Beta", streaming: false },
];

let node: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

function menuItems(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
    (el) => el.textContent ?? "",
  );
}

async function render(extra: Partial<Parameters<typeof SessionTabStrip>[0]> = {}) {
  await act(async () => {
    root.render(
      <SessionTabStrip
        tabs={TABS}
        activeKey="a"
        onSelect={() => {}}
        onClose={() => {}}
        closeLabel="close"
        onNew={() => {}}
        onNewBrowser={() => {}}
        {...extra}
      />,
    );
  });
}

/** The scroll container owns the blank area right of the "+" button. */
function scrollContainer(): HTMLElement {
  const el = node.querySelector<HTMLElement>(".overflow-x-auto");
  if (!el) throw new Error("scroll container not found");
  return el;
}

it("opens the 新建会话/新建浏览器 menu on blank-area right-click", async () => {
  await render();

  await act(async () => {
    scrollContainer().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 12 }),
    );
  });

  expect(menuItems()).toEqual(["chat.newSession", "chat.newBrowser"]);
});

it("blank-area menu entries invoke onNew / onNewBrowser", async () => {
  const onNew = vi.fn();
  const onNewBrowser = vi.fn();
  await render({ onNew, onNewBrowser });

  await act(async () => {
    scrollContainer().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 12 }),
    );
  });
  const items = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  await act(async () => items[1].click());

  expect(onNewBrowser).toHaveBeenCalledOnce();
  expect(onNew).not.toHaveBeenCalled();
  expect(menuItems()).toEqual([]);
});

it("keeps tab right-click on the tab menu, not the new-tab menu", async () => {
  await render({ onCloseAll: () => {} });
  const tab = node.querySelector<HTMLElement>('[data-tab-key="b"]');
  if (!tab) throw new Error("tab not found");

  await act(async () => {
    tab.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 12 }),
    );
  });

  expect(menuItems()).not.toContain("chat.newSession");
  expect(menuItems()).not.toContain("chat.newBrowser");
});

it("offers no menu when onNewBrowser is omitted", async () => {
  await render({ onNewBrowser: undefined });

  await act(async () => {
    scrollContainer().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 12 }),
    );
  });

  expect(menuItems()).toEqual([]);
});

it("marks a tab with a pending notice as unread, with its own accessible name", async () => {
  await render({
    tabs: [
      ...TABS,
      { key: "notes", label: "Release Notes", streaming: false, unread: "新版本" },
    ],
  });

  // 未读提醒不借用会话活动的绿点（语义与颜色都是另一套）。
  expect(node.querySelector('[data-tab-key="b"] [role="status"]')).toBeNull();
  const dot = node.querySelector('[data-tab-key="notes"] [role="status"]');
  expect(dot?.getAttribute("aria-label")).toBe("新版本");
  expect(dot?.getAttribute("title")).toBe("新版本");
  expect(dot?.className).toContain("bg-accent-500");
});
