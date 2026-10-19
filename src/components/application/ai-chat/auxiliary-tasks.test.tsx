import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiChatSidebar } from "./ai-chat-sidebar";
import { AUXILIARY_TASKS_KEY, partitionAuxiliaryRepos } from "./auxiliary-tasks";
import type { AiChatRepo } from "./sidebar-types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => options?.count === undefined ? key : `${key} (${options.count})` }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

let node: HTMLDivElement;
let root: Root;
const repos: AiChatRepo[] = [{ id: "workspace", label: "Workspace", defaultOpen: true, threadLimit: 1, threads: [
  { id: "cursor/helper", label: "Helper", engine: "cursor", time: "1m", updatedAt: 20, auxiliaryKind: "cursor_cce", streaming: true },
  { id: "cursor/ordinary", label: "Ordinary", engine: "cursor", time: "2m", updatedAt: 10 },
] }];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });
const section = () => node.querySelector<HTMLElement>("[data-auxiliary-tasks]")!;
const header = () => section().querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const button = (text: string, parent: ParentNode = node) => [...parent.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.includes(text))!;
const render = async (activeThreadId?: string) => { await act(async () => root.render(<AiChatSidebar repos={repos} activeThreadId={activeThreadId} />)); };

it.each(["workspace", "recent"])("%s separates auxiliaries before pagination, reuses selectable rows and preserves search", async (mode) => {
  localStorage.setItem("ccgui-next.sidebarChatListMode:v1", mode);
  const select = vi.fn();
  await act(async () => root.render(<AiChatSidebar repos={repos} onThreadSelect={select} />));
  expect(header().getAttribute("aria-expanded")).toBe("false");
  expect(node.textContent).toContain("Ordinary");
  expect(section().textContent).not.toContain("Helper");
  expect([...node.querySelectorAll("button")].filter((el) => !el.closest("dialog") && el.textContent?.includes("Helper"))).toHaveLength(0);
  await act(async () => header().click());
  expect([...node.querySelectorAll("button")].filter((el) => !el.closest("dialog") && el.textContent?.includes("Helper"))).toHaveLength(1);
  expect(section().textContent).toContain("Workspace");
  expect(section().querySelector('[role="status"]')).not.toBeNull();
  await act(async () => button("Helper", section()).click());
  expect(select).toHaveBeenCalledWith("cursor/helper");
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="chat.searchSessions"]')!.click());
  expect(document.body.querySelector("dialog")?.textContent).toContain("Helper");
});

it("manual classification persists across scans and remounts and can move back", async () => {
  await render();
  await act(async () => header().click());
  await act(async () => button("Helper").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  await act(async () => button("chat.moveToOrdinarySessions", document.body).click());
  expect(section()).toBeNull();
  expect(JSON.parse(localStorage.getItem(AUXILIARY_TASKS_KEY)!).overrides["cursor/helper"]).toBe(false);
  await act(async () => root.unmount()); root = createRoot(node);
  await act(async () => root.render(<AiChatSidebar repos={structuredClone(repos)} />));
  expect(section()).toBeNull();
  await act(async () => button("Helper").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  await act(async () => button("chat.moveToAuxiliaryTasks", document.body).click());
  expect(section()).not.toBeNull();
  expect(header().getAttribute("aria-expanded")).toBe("true");
  expect(JSON.parse(localStorage.getItem(AUXILIARY_TASKS_KEY)!).overrides["cursor/helper"]).toBe(true);
});

it("reveals an active auxiliary once without overriding subsequent collapse", async () => {
  await render();
  await render("cursor/helper");
  expect(header().getAttribute("aria-expanded")).toBe("true");
  await act(async () => header().click());
  await render("cursor/helper");
  expect(header().getAttribute("aria-expanded")).toBe("false");
  const disclosure = section().querySelector('div[aria-hidden="true"]')!;
  expect(disclosure.hasAttribute("inert")).toBe(true);
  expect(disclosure.className).toContain("duration-300");
  await render("cursor/ordinary");
  await render("cursor/helper");
  expect(header().getAttribute("aria-expanded")).toBe("true");
});

it("unavailable or malformed storage does not prevent classification and expansion", async () => {
  localStorage.setItem(AUXILIARY_TASKS_KEY, "invalid");
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  await render();
  await act(async () => header().click());
  expect(header().getAttribute("aria-expanded")).toBe("true");
  await act(async () => button("Helper").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  await act(async () => button("chat.moveToOrdinarySessions", document.body).click());
  expect(section()).toBeNull();
  write.mockRestore();
});

it("preserves managed trees, extracts worktrees, and never guesses from titles", () => {
  const helper = repos[0].threads[0];
  const leader = { ...helper, id: "cursor/leader", isLeader: true, children: [{ ...helper, id: "cursor/child" }] };
  const input = [{ ...repos[0], threads: [leader, { ...helper, id: "cursor/normal", auxiliaryKind: null }], worktrees: [{ id: "wt", label: "Worktree", threads: [helper] }] }];
  const result = partitionAuxiliaryRepos(input, {});
  expect(result.mainRepos[0].threads).toEqual(input[0].threads);
  expect(result.mainRepos[0].threads[0]).toBe(leader);
  expect(result.mainRepos[0].worktrees![0].threads).toEqual([]);
  expect(result.auxiliaryThreads).toHaveLength(1);
  expect(result.auxiliaryThreads[0].workspaceLabel).toBe("Worktree");
  expect(input[0].worktrees[0].threads).toHaveLength(1);
});

it("grouped workspaces keep their main rows while worktree auxiliaries appear only in the shared group", async () => {
  const grouped: AiChatRepo = { ...repos[0], worktrees: [{ id: "wt", label: "Worktree", threads: [
    { id: "cursor/worker", label: "Worker", engine: "cursor", time: "", auxiliaryKind: "cursor_do" },
  ] }] };
  await act(async () => root.render(<AiChatSidebar repos={[grouped]} sections={[{ id: "group", name: "Group", repos: [grouped] }]} />));
  expect(header().textContent).toContain("(2)");
  expect(node.textContent).toContain("Group");
  expect(button("Ordinary")).toBeDefined();
  await act(async () => header().click());
  // The limit is shared with the main list; load more exposes the second auxiliary.
  await act(async () => button("chat.showMoreSessions", section()).click());
  expect(button("Worker", section())).toBeDefined();
  expect(section().textContent).toContain("Worktree");
});

it("storage reads may fail while the group remains usable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  await render();
  expect(header().getAttribute("aria-expanded")).toBe("false");
  await act(async () => header().click());
  expect(header().getAttribute("aria-expanded")).toBe("true");
});

it("reveals a restored active tab when its auxiliary metadata arrives later", async () => {
  await act(async () => root.render(<AiChatSidebar repos={[]} activeThreadId="cursor/helper" />));
  await render("cursor/helper");
  expect(header().getAttribute("aria-expanded")).toBe("true");
  await act(async () => header().click());
  await act(async () => root.render(<AiChatSidebar repos={structuredClone(repos)} activeThreadId="cursor/helper" />));
  expect(header().getAttribute("aria-expanded")).toBe("false");
});
