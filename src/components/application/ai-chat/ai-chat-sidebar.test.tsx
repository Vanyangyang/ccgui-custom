import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionMenuRegistry } from "@ccgui/plugin-sdk";
import { ipc, type AppSettings } from "@/lib/ipc";

import { AiChatSidebar } from "./ai-chat-sidebar";
import type { AiChatRepo } from "./ai-chat-sidebar";
import { useCrossSessionActivityStore } from "@/features/chat/cross-session";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // The palette's content-hit rows format relative time via the real i18n
  // instance (time.ts), which initializes i18next with this plugin.
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const KEY = "ccgui-next.sidebarExpandedWorkspaces:v1";

function repo(id: string, defaultOpen = false): AiChatRepo {
  return { id, label: id, defaultOpen, threads: [] };
}

let node: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  useCrossSessionActivityStore.getState().reset();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

/** The row body is the toggle button carrying aria-expanded + the label. */
function rowFor(label: string): HTMLElement {
  const rows = [...node.querySelectorAll<HTMLElement>("button[aria-expanded]")];
  const match = rows.find((el) => el.textContent?.includes(label));
  if (!match) throw new Error(`no header row for ${label}`);
  return match;
}

async function render(repos: AiChatRepo[]) {
  await act(async () => {
    root.render(<AiChatSidebar repos={repos} />);
  });
}

it("shows AGY reference evidence, opens the gradient-synced cache hover card, and keeps Cursor cache styling disabled", async () => {
  const cache = { startedAt: Date.now() - 120_000, observedAt: Date.now() - 60_000, ttlSeconds: 900,
    source: "agy-vertex-reference" as const, reference: { maxTtlSeconds: 1200, cacheReadTokens: 900, promptTokens: 1000 } };
  const expiringCache = { startedAt: Date.now() - 55 * 60_000, observedAt: Date.now() - 55 * 60_000 + 10_000, ttlSeconds: 3600,
    source: "anthropic-usage" as const };
  await render([{ ...repo("cache", true), threads: [
    { id: "agy/reference", engine: "agy", label: "AGY reference", time: "agy-age", promptCache: cache },
    { id: "claude/expiring", engine: "claude", label: "Claude expiring", time: "expiring-age", promptCache: expiringCache },
    { id: "cursor/disabled", engine: "cursor", label: "Cursor disabled", time: "cursor-age", updatedAt: Date.now(), streaming: true, promptCache: cache },
  ] }]);
  const age = (text: string) => [...node.querySelectorAll<HTMLElement>("[data-cache-heat], span")].find(
    (el) => el.textContent === text && (el.hasAttribute("data-cache-heat") || el.tagName === "SPAN"),
  )!;
  const agyChip = age("agy-age");
  expect(agyChip.getAttribute("data-cache-heat")).toBe("hot");
  expect(agyChip.hasAttribute("data-cache-expiring-soon")).toBe(false);
  expect(agyChip.querySelector('[data-testid="cache-expiring-hourglass"]')).toBeNull();
  expect(agyChip.title).toBe("chat.cacheReferenceExpiry\nchat.cacheReferenceWindow");
  expect(agyChip.classList.contains("group-hover:hidden")).toBe(false);

  await act(async () => {
    agyChip.focus();
  });
  const card = document.body.querySelector<HTMLElement>("[data-testid=\"cache-window-hover-card\"]");
  expect(card).not.toBeNull();
  expect(card!.querySelector('[data-testid="cache-card-expiring-hourglass"]')).toBeNull();
  const bar = card!.querySelector<HTMLElement>("[data-testid=\"cache-window-progress-bar\"]");
  expect(bar).not.toBeNull();
  expect(bar!.style.width).toBe("90%");
  expect(bar!.style.backgroundColor).toContain("color-mix");
  expect(agyChip.hasAttribute("title")).toBe(false);

  const expiringChip = [...node.querySelectorAll<HTMLElement>("[data-cache-heat]")].find(
    (el) => el.textContent === "expiring-age",
  )!;
  expect(expiringChip.getAttribute("data-cache-expiring-soon")).toBe("true");
  expect(expiringChip.querySelector('[data-testid="cache-expiring-hourglass"]')).not.toBeNull();
  await act(async () => {
    expiringChip.focus();
  });
  const expiringCard = document.body.querySelector<HTMLElement>("[data-testid=\"cache-window-hover-card\"]");
  expect(expiringCard?.querySelector('[data-testid="cache-card-expiring-hourglass"]')).not.toBeNull();

  expect(age("cursor-age").hasAttribute("data-cache-heat")).toBe(false);
  expect(age("cursor-age").hasAttribute("data-cache-heat-ratio")).toBe(false);
  expect(age("cursor-age").hasAttribute("title")).toBe(false);
});

it("remembers which workspaces the user expanded", async () => {
  // The bug: expansion lived in component state, so every restart reopened
  // only the first workspace and the user's tree shape was lost.
  await render([repo("a"), repo("b"), repo("c")]);
  expect(rowFor("b").getAttribute("aria-expanded")).toBe("false");

  await act(async () => rowFor("b").click());

  expect(rowFor("b").getAttribute("aria-expanded")).toBe("true");
  expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toContain("b");

  // Remount: the freshly mounted sidebar must restore the same shape.
  await act(async () => root.unmount());
  root = createRoot(node);
  await render([repo("a"), repo("b"), repo("c")]);
  expect(rowFor("b").getAttribute("aria-expanded")).toBe("true");
  // Untouched rows keep the built-in default (only the first opens).
  expect(rowFor("c").getAttribute("aria-expanded")).toBe("false");
});

it("active draft 新对话会展开其所在的折叠工作区", async () => {
  localStorage.setItem(KEY, JSON.stringify([]));
  await act(async () => {
    root.render(
      <AiChatSidebar
        activeThreadId="new:codex:/ws/b"
        repos={[
          repo("a", true),
          {
            id: "b",
            label: "b",
            threads: [
              {
                id: "new:codex:/ws/b",
                label: "新对话",
                time: "",
                isDraft: true,
              },
            ],
          },
        ]}
      />,
    );
  });
  expect(rowFor("b").getAttribute("aria-expanded")).toBe("true");
  expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toContain("b");

  await act(async () => rowFor("b").click());
  expect(rowFor("b").getAttribute("aria-expanded")).toBe("false");
  expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).not.toContain("b");
});

it("remembers collapses too, and the default never overrides a stored set", async () => {
  await render([repo("a", true), repo("b")]);
  expect(rowFor("a").getAttribute("aria-expanded")).toBe("true");

  await act(async () => rowFor("a").click());
  expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).not.toContain("a");

  await act(async () => root.unmount());
  root = createRoot(node);
  // defaultOpen would open "a" again, but the user's choice wins.
  await render([repo("a", true), repo("b")]);
  expect(rowFor("a").getAttribute("aria-expanded")).toBe("false");
});

function namedThreadCount(): number {
  return [...node.querySelectorAll("button")].filter((el) =>
    /^对话\d+$/.test((el.textContent ?? "").replace(/\s+/g, "")),
  ).length;
}

it("展开只显示 threadLimit 条,收起再展开不会保留加载更多", async () => {
  const threads = Array.from({ length: 12 }, (_, index) => ({
    id: `codex/s-${index}`,
    label: `对话${index}`,
    time: "1m",
  }));
  await act(async () => {
    root.render(
      <AiChatSidebar
        activeThreadId="codex/s-10"
        repos={[{ id: "a", label: "a", defaultOpen: true, threadLimit: 5, threads }]}
      />,
    );
  });
  expect(namedThreadCount()).toBe(5);

  const more = [...node.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("chat.showMoreSessions"),
  );
  if (!more) throw new Error("no load-more row");
  await act(async () => more.click());
  expect(namedThreadCount()).toBe(12);

  await act(async () => rowFor("a").click());
  await act(async () => rowFor("a").click());
  expect(namedThreadCount()).toBe(5);
});

it("收起会话列表时裁切高度而不做透明度淡出", async () => {
  const threads = Array.from({ length: 3 }, (_, index) => ({
    id: `codex/s-${index}`,
    label: `对话${index}`,
    time: "1m",
  }));
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[{ id: "a", label: "a", defaultOpen: true, threads }]}
      />,
    );
  });
  expect(namedThreadCount()).toBe(3);

  await act(async () => rowFor("a").click());

  const panel = [...node.querySelectorAll<HTMLElement>("[aria-hidden]")].find((el) =>
    (el.getAttribute("class") ?? "").includes("grid-rows-"),
  );
  if (!panel) throw new Error("no collapse panel");
  expect(panel.className).toContain("grid-rows-[0fr]");
  expect(panel.className).not.toMatch(/opacity-0/);
  expect(panel.querySelector(".min-h-0.overflow-hidden")).toBeTruthy();
  // Still in the DOM so the height can clip shut; the next workspace must
  // not see a faded copy of these rows.
  expect(namedThreadCount()).toBe(3);
});
/** The session row whose label is inside it (the hover-action div wrapping
 *  the row button). */
function threadRow(label: string): HTMLElement {
  const body = [...node.querySelectorAll<HTMLElement>("button")].find((el) =>
    el.textContent?.includes(label),
  );
  const row = body?.closest("div");
  if (!row) throw new Error(`no thread row for ${label}`);
  return row;
}

/** The portaled context menu lives on document.body, outside the render node. */
function openMenu(): HTMLElement {
  const menu = document.body.querySelector<HTMLElement>("[role='menu']");
  if (!menu) throw new Error("no context menu open");
  return menu;
}

function menuItem(menu: HTMLElement, label: string): HTMLElement {
  const item = [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) =>
    el.textContent?.includes(label),
  );
  if (!item) throw new Error(`no menu item ${label}`);
  return item;
}

async function rightClick(row: HTMLElement) {
  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
  });
}

it("renders a retrying streaming thread with a static status dot", async () => {
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[{
          id: "a",
          label: "a",
          defaultOpen: true,
          threads: [{
            id: "omp/retry-1",
            label: "重试会话",
            time: "刚刚",
            streaming: true,
            retrying: true,
          }],
        }]}
      />,
    );
  });

  const dot = threadRow("重试会话").querySelector(".sidebar-thread-status");
  expect(dot?.classList.contains("sidebar-thread-status-retrying")).toBe(true);
});

it("keeps hover actions to pin / rename / delete (archive is context-menu only)", async () => {
  const onThreadAction = vi.fn();
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[
          {
            id: "a",
            label: "a",
            defaultOpen: true,
            threads: [{ id: "claude/hover-1", label: "悬浮操作", time: "刚刚" }],
          },
        ]}
        onThreadAction={onThreadAction}
      />,
    );
  });

  const actionLabels = [...threadRow("悬浮操作").querySelectorAll("button[aria-label]")].map(
    (button) => button.getAttribute("aria-label"),
  );
  expect(actionLabels).toEqual(["chat.pin", "chat.renameSession", "chat.deleteSession"]);

  await rightClick(threadRow("悬浮操作"));
  const menu = openMenu();
  await act(async () => menuItem(menu, "chat.archiveSession").click());
  expect(onThreadAction).toHaveBeenCalledWith("claude/hover-1", "archive");
});

it("opens the thread context menu on right-click and dispatches its entries", async () => {
  const onThreadAction = vi.fn();
  const onCopyThreadId = vi.fn();
  const thread = { id: "claude/abc-123", label: "整理发布脚本", time: "1分钟" };
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[{ id: "a", label: "a", defaultOpen: true, threads: [thread] }]}
        onThreadAction={onThreadAction}
        onCopyThreadId={onCopyThreadId}
      />,
    );
  });

  await rightClick(threadRow("整理发布脚本"));
  let menu = openMenu();
  await act(async () => menuItem(menu, "chat.renameSession").click());
  expect(onThreadAction).toHaveBeenCalledWith("claude/abc-123", "rename");
  expect(document.body.querySelector("[role='menu']")).toBeNull();

  await rightClick(threadRow("整理发布脚本"));
  menu = openMenu();
  await act(async () => menuItem(menu, "chat.copySessionId").click());
  expect(onCopyThreadId).toHaveBeenCalledWith("claude/abc-123");

  await rightClick(threadRow("整理发布脚本"));
  menu = openMenu();
  await act(async () => menuItem(menu, "chat.archiveSession").click());
  expect(onThreadAction).toHaveBeenCalledWith("claude/abc-123", "archive");

  await rightClick(threadRow("整理发布脚本"));
  menu = openMenu();
  await act(async () => menuItem(menu, "chat.deleteSession").click());
  expect(onThreadAction).toHaveBeenCalledWith("claude/abc-123", "delete");
});

it("renders plugin session-menu items and dispatches the parsed target", async () => {
  const run = vi.fn();
  const dispose = sessionMenuRegistry.register({
    id: "plugin:auto-title:rename",
    label: () => "AI Rename",
    run,
  });
  try {
    const thread = { id: "omp/sid-42", label: "拖入分组", time: "1分钟" };
    await act(async () => {
      root.render(
        <AiChatSidebar
          repos={[{ id: "a", label: "a", defaultOpen: true, threads: [thread] }]}
          onThreadAction={vi.fn()}
        />,
      );
    });

    await rightClick(threadRow("拖入分组"));
    const menu = openMenu();
    await act(async () => menuItem(menu, "AI Rename").click());
    expect(run).toHaveBeenCalledWith({ engine: "omp", sessionId: "sid-42" });
    expect(document.body.querySelector("[role='menu']")).toBeNull();
  } finally {
    dispose();
  }
});

it("draft 新对话右键只提供删除,不暴露重命名/复制 ID/插件项", async () => {
  const onThreadAction = vi.fn();
  const onCopyThreadId = vi.fn();
  const dispose = sessionMenuRegistry.register({
    id: "plugin:auto-title:rename",
    label: () => "AI Rename",
    run: vi.fn(),
  });
  try {
    await act(async () => {
      root.render(
        <AiChatSidebar
          repos={[
            {
              id: "a",
              label: "a",
              defaultOpen: true,
              threads: [
                {
                  id: "new:codex:/ws/a",
                  label: "新对话",
                  time: "",
                  isDraft: true,
                },
              ],
            },
          ]}
          onThreadAction={onThreadAction}
          onCopyThreadId={onCopyThreadId}
        />,
      );
    });

    await rightClick(threadRow("新对话"));
    const menu = openMenu();
    // 草稿只能删除与分屏打开：重命名/复制 ID/插件项都不适用。
    expect([...menu.querySelectorAll("[role='menuitem']")].map((el) => el.textContent)).toEqual([
      "chat.splitRight",
      "chat.splitDown",
      "chat.deleteSession",
    ]);
    await act(async () => menuItem(menu, "chat.deleteSession").click());
    expect(onThreadAction).toHaveBeenCalledWith("new:codex:/ws/a", "delete");
    expect(onCopyThreadId).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

it("keeps right-click inert when no thread handler is wired", async () => {
  await render([
    { id: "a", label: "a", defaultOpen: true, threads: [{ id: "t1", label: "孤独会话", time: "1分钟" }] },
  ]);
  await rightClick(threadRow("孤独会话"));
  expect(document.body.querySelector("[role='menu']")).toBeNull();
});

it("renders empty groups instead of hiding them", async () => {
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[]}
        sections={[{ id: "g1", name: "开源项目", repos: [] }]}
      />,
    );
  });
  // A group with no members still renders its collapsible header — the
  // sidebar is where groups are created, so a fresh group must be visible.
  expect(rowFor("开源项目").getAttribute("aria-expanded")).toBe("true");
});

/** The scroll container carries the blank-area context-menu handler. */
function workspaceScrollArea(): HTMLElement {
  const el = node.querySelector<HTMLElement>(".overflow-y-auto");
  if (!el) throw new Error("no scroll container");
  return el;
}

function composerInput(): HTMLInputElement {
  const input = node.querySelector<HTMLInputElement>(
    "input[placeholder='settings.newGroupPlaceholder']",
  );
  if (!input) throw new Error("no group composer open");
  return input;
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("creates a group from the blank-area right-click menu", async () => {
  const onCreateGroup = vi.fn((name: string) =>
    name.trim() ? null : "settings.groupNameRequired",
  );
  await act(async () => {
    root.render(<AiChatSidebar repos={[repo("a")]} onCreateGroup={onCreateGroup} />);
  });

  await rightClick(workspaceScrollArea());
  await act(async () => menuItem(openMenu(), "chat.newGroup").click());

  // A validation error keeps the composer open with the hint inline.
  await act(async () => {
    composerInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onCreateGroup).toHaveBeenCalledWith("");
  expect(composerInput()).toBeTruthy();

  await typeInto(composerInput(), "中转站项目");
  await act(async () => {
    composerInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onCreateGroup).toHaveBeenLastCalledWith("中转站项目");
  // Accepted (null) → the composer closes.
  expect(node.querySelector("input[placeholder='settings.newGroupPlaceholder']")).toBeNull();
});

it("keeps the blank-area menu off rows that own a context menu", async () => {
  const onWorkspaceAlias = vi.fn();
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[repo("a")]}
        onWorkspaceAlias={onWorkspaceAlias}
        onCreateGroup={() => null}
      />,
    );
  });

  // The workspace row's menu preventDefaults the event, so the container's
  // blank-area handler must stay out of it.
  await rightClick(rowFor("a"));
  const menu = openMenu();
  expect(menuItem(menu, "chat.setWorkspaceAlias")).toBeTruthy();
  expect(
    [...menu.querySelectorAll("[role='menuitem']")].some((el) =>
      el.textContent?.includes("chat.newGroup"),
    ),
  ).toBe(false);
});

it("worktree 子行 hover ＋ 在该 worktree 下新建会话", async () => {
  const onNewSessionInWorkspace = vi.fn();
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[
          {
            id: "a",
            label: "a",
            defaultOpen: true,
            threads: [],
            worktrees: [
              {
                id: "a::pr-1865",
                label: "pr-1865-fix",
                threads: [],
                worktree: { branch: "pr-1865-fix", prNumber: 1865 },
              },
            ],
          },
        ]}
        onNewSessionInWorkspace={onNewSessionInWorkspace}
      />,
    );
  });

  const childRow = node.querySelector<HTMLElement>('button[aria-label="pr-1865-fix"]');
  if (!childRow) throw new Error("no worktree child row");
  const plus = childRow.parentElement?.querySelector<HTMLElement>(
    'button[aria-label="chat.newSession"]',
  );
  if (!plus) throw new Error("no new-session button on the worktree row");

  await act(async () => plus.click());
  expect(onNewSessionInWorkspace).toHaveBeenCalledWith("a::pr-1865");
});

it("WORKTREES 分组折叠走高度动画：内容随收起动画卸载后才离开 DOM", async () => {
  // The bug: the group unmounted its rows the moment the header was clicked,
  // so the list popped away with no height animation.
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[
          {
            id: "a",
            label: "a",
            defaultOpen: true,
            threads: [],
            worktrees: [
              {
                id: "a::pr-1865",
                label: "pr-1865-fix",
                threads: [{ id: "t-1", label: "线程一", time: "1m" }],
                worktree: { branch: "pr-1865-fix", prNumber: 1865 },
              },
            ],
          },
        ]}
      />,
    );
  });

  const region = worktreeDisclosure();
  expect(region.className).toContain("grid-rows-[1fr]");

  vi.useFakeTimers();
  try {
    await act(async () => rowFor("worktree.groupLabel").click());

    // Collapsed now, but the rows stay mounted so the height can clip shut.
    expect(region.className).toContain("grid-rows-[0fr]");
    expect(region.className).toContain("transition-[grid-template-rows]");
    expect(region.getAttribute("aria-hidden")).toBe("true");
    expect(region.hasAttribute("inert")).toBe(true);
    expect(region.querySelector('button[aria-label="pr-1865-fix"]')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(region.querySelector('button[aria-label="pr-1865-fix"]')).toBeNull();

    await act(async () => rowFor("worktree.groupLabel").click());
    expect(region.className).toContain("grid-rows-[1fr]");
    expect(region.getAttribute("aria-hidden")).toBe("false");
    expect(region.querySelector('button[aria-label="pr-1865-fix"]')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it("收起的 worktree 子行聚合显示运行中状态点，展开后让位给各线程行", async () => {
  // 子行折叠时看不到线程行自己的呼吸点，不知道里面有没有会话在跑——
  // 聚合点把这层信息提到子行上；展开后各线程行已有自己的点，聚合点退出。
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[
          {
            id: "a",
            label: "a",
            defaultOpen: true,
            threads: [],
            worktrees: [
              {
                id: "a::wt-run",
                label: "wt-run",
                threads: [
                  { id: "t-run", label: "运行中会话", time: "", streaming: true },
                  { id: "t-done", label: "已完成会话", time: "" },
                ],
                worktree: { branch: "wt-run" },
              },
              {
                id: "a::wt-retry",
                label: "wt-retry",
                threads: [
                  { id: "t-retry", label: "退避会话", time: "", streaming: true, retrying: true },
                ],
                worktree: { branch: "wt-retry" },
              },
            ],
          },
        ]}
      />,
    );
  });

  const runRow = node.querySelector<HTMLElement>('button[aria-label="wt-run"]');
  const retryRow = node.querySelector<HTMLElement>('button[aria-label="wt-retry"]');
  if (!runRow || !retryRow) throw new Error("no worktree child rows");

  // Collapsed children carry the aggregate dot; all-retrying degrades to the
  // static variant, same as a thread row.
  const runDot = runRow.querySelector(".sidebar-thread-status");
  expect(runDot?.classList.contains("sidebar-thread-status-processing")).toBe(true);
  expect(runDot?.classList.contains("sidebar-thread-status-retrying")).toBe(false);
  const retryDot = retryRow.querySelector(".sidebar-thread-status");
  expect(retryDot?.classList.contains("sidebar-thread-status-retrying")).toBe(true);

  // Expanding hands the indicator back to the thread rows.
  await act(async () => runRow.click());
  expect(runRow.querySelector(".sidebar-thread-status")).toBeNull();
  const threadDot = threadRow("运行中会话").querySelector(".sidebar-thread-status");
  expect(threadDot?.classList.contains("sidebar-thread-status-processing")).toBe(true);
});

/** The innermost disclosure region holding the worktree child rows. */
function worktreeDisclosure(): HTMLElement {
  const regions = [...node.querySelectorAll<HTMLElement>('div[class*="grid-rows-"]')]
    .filter((el) => el.textContent?.includes("pr-1865-fix"));
  const region = regions[regions.length - 1];
  if (!region) throw new Error("no worktree group disclosure");
  return region;
}

it("全部会话按最后对话时间跨工作区排序，并记住这次选择", async () => {
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[
          {
            id: "old",
            label: "旧仓库",
            threads: [{ id: "a", label: "较早", time: "5天", updatedAt: 1, pinned: true }],
          },
          {
            id: "new",
            label: "新仓库",
            threads: [{ id: "b", label: "最新", time: "1天", updatedAt: 100 }],
          },
        ]}
      />,
    );
  });
  expect(node.textContent).toContain("旧仓库");
  const toggle = node.querySelector<HTMLButtonElement>("button[aria-label='chat.sortByRecent']");
  if (!toggle) throw new Error("no recent-sort toggle");
  await act(async () => toggle.click());

  const text = node.textContent ?? "";
  expect(text.indexOf("最新")).toBeLessThan(text.indexOf("较早"));
  expect(text).toContain("新仓库");
  expect(node.querySelector('button[aria-expanded]:not([data-testid="sidebar-cross-session-btn"])')).toBeNull();
  expect(localStorage.getItem("ccgui-next.sidebarChatListMode:v1")).toBe("recent");

  await act(async () => root.unmount());
  root = createRoot(node);
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[
          {
            id: "old",
            label: "旧仓库",
            threads: [{ id: "a", label: "较早", time: "5天", updatedAt: 1, pinned: true }],
          },
          {
            id: "new",
            label: "新仓库",
            threads: [{ id: "b", label: "最新", time: "1天", updatedAt: 100 }],
          },
        ]}
      />,
    );
  });
  expect(node.textContent?.indexOf("最新")).toBeLessThan(node.textContent?.indexOf("较早") ?? -1);
});

it("侧栏分类模式同步写入 settings.json，且在 localStorage 丢失时从后端设置恢复", async () => {
  let persistedSettings = { sidebarThreadLimit: 5 } as AppSettings;
  const getSettingsSpy = vi
    .spyOn(ipc, "getAppSettings")
    .mockImplementation(async () => ({ ...persistedSettings }));
  const updateSettingsSpy = vi
    .spyOn(ipc, "updateAppSettings")
    .mockImplementation(async (next) => {
      persistedSettings = { ...next };
    });

  try {
    const sampleRepos: AiChatRepo[] = [
      {
        id: "old",
        label: "旧仓库",
        threads: [{ id: "a", label: "较早", time: "5天", updatedAt: 1, pinned: true }],
      },
      {
        id: "new",
        label: "新仓库",
        threads: [{ id: "b", label: "最新", time: "1天", updatedAt: 100 }],
      },
    ];

    await act(async () => {
      root.render(<AiChatSidebar repos={sampleRepos} />);
    });
    const toggle = node.querySelector<HTMLButtonElement>("button[aria-label='chat.sortByRecent']");
    if (!toggle) throw new Error("no recent-sort toggle");
    await act(async () => {
      toggle.click();
    });
    expect(persistedSettings.sidebarChatListMode).toBe("recent");
    expect(updateSettingsSpy).toHaveBeenCalled();

    // Simulate WebView2 Local Storage reset or cross-host launch with empty localStorage.
    await act(async () => root.unmount());
    localStorage.clear();
    expect(localStorage.getItem("ccgui-next.sidebarChatListMode:v1")).toBeNull();

    root = createRoot(node);
    await act(async () => {
      root.render(<AiChatSidebar repos={sampleRepos} />);
    });
    expect(getSettingsSpy).toHaveBeenCalled();
    expect(node.querySelector('button[aria-expanded]:not([data-testid="sidebar-cross-session-btn"])')).toBeNull();
    expect(node.textContent?.indexOf("最新")).toBeLessThan(node.textContent?.indexOf("较早") ?? -1);
    expect(localStorage.getItem("ccgui-next.sidebarChatListMode:v1")).toBe("recent");
  } finally {
    getSettingsSpy.mockRestore();
    updateSettingsSpy.mockRestore();
  }
});

it("adds communication indicators to real rows and opens the overview only on request", async () => {
  useCrossSessionActivityStore.getState().reset();
  await render([
    {
      ...repo("ws", true),
      threads: [
        { id: "codex/sender-1", engine: "codex", workspacePath: "/ws", label: "发起会话 A", time: "1m" },
        { id: "claude/target-2", engine: "claude", workspacePath: "/ws", label: "目标会话 B", time: "2m" },
      ],
    },
  ]);

  expect(node.querySelector('[data-testid="thread-cross-session-btn"]')).toBeNull();
  expect(document.querySelector('[data-testid="cross-session-details"]')).toBeNull();

  await act(async () => {
    useCrossSessionActivityStore.getState().upsertRecord({
      scopedId: "msg-live-1",
      requestId: "msg-live-1",
      sender: { engine: "codex", sessionId: "sender-1", workspacePath: "/ws", title: "发起会话 A" },
      target: { engine: "claude", sessionId: "target-2", workspacePath: "/ws", title: "目标会话 B" },
      message: "请核对接口契约",
      status: "executing",
      replyText: "正在检查返回值...",
      acceptedAt: Date.now() - 2000,
      updatedAt: Date.now(),
    });
  });

  expect(node.querySelectorAll('[data-testid="thread-cross-session-btn"]')).toHaveLength(2);
  expect(document.querySelector('[data-testid="cross-session-details"]')).toBeNull();
  const overview = node.querySelector<HTMLButtonElement>('[data-testid="sidebar-cross-session-btn"]')!;
  expect(overview.querySelector('[data-testid="cross-session-count"]')?.textContent).toBe("1");
  await act(async () => overview.click());
  const details = document.querySelector('[data-testid="cross-session-details"]');
  expect(details?.textContent).toContain("发起会话 A");
  expect(details?.textContent).toContain("目标会话 B");
  expect(details?.textContent).toContain("crossSession.status.executing");
  expect(details?.textContent).toContain("正在检查返回值...");
});
