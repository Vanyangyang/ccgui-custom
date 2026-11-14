import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiChatRepo } from "@/components/application/ai-chat/sidebar-types";
import { NewSessionWorkspaceDialog } from "./NewSessionWorkspaceDialog";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/browser/occlusion", () => ({ useBrowserOcclusion: () => {} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
const onSelect = vi.fn();
const onClose = vi.fn();
const repo = (id: string, path: string, extra: Partial<AiChatRepo> = {}): AiChatRepo => ({
  id, path, label: "same-name", threads: [], ...extra,
});
const worktree = repo("worktree-id", "/project/worktree");
const repos = [repo("first-id", "/first/project", { worktrees: [worktree] }), repo("second-id", "/second/project")];
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
const option = (path: string) => buttons().find(button => button.title === path)!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onClose.mockImplementation(() => root.render(null));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(items = repos, workspaceId = "second-id") {
  await act(async () => root.render(<NewSessionWorkspaceDialog repos={items} workspaceId={workspaceId} onSelect={onSelect} onClose={onClose} />));
}

it.each([
  ["/first/project", "first-id"],
  ["/second/project", "second-id"],
  ["/project/worktree", "worktree-id"],
])("同名工作区与 worktree 显示精确路径，选择 %s 仅派发对应 id", async (path, id) => {
  await render();
  expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("chat.newSessionWorkspace");
  for (const entry of [repos[0], worktree, repos[1]]) {
    expect(option(entry.path!).textContent).toContain("same-name");
    expect(option(entry.path!).textContent).toContain(entry.path);
  }
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => option(path).click());
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(id);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it.each(["cancel", "escape"])("打开后通过 %s 关闭不派发会话创建", async action => {
  await render();
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true));
  await act(async () => {
    if (action === "cancel") buttons().find(button => button.textContent === "common.cancel")!.click();
    else document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("不可用工作区不能选择，未登记目录不列入选项", async () => {
  await render([
    repo("missing", "/missing", { unavailable: "missing" }),
    repo("changed", "/changed", { unavailable: "changed" }),
    repo("directory", "/directory", { directoryOnly: true }),
    repos[1],
  ], "missing");
  const unavailable = buttons().filter(button => button.disabled);
  expect(unavailable).toHaveLength(2);
  expect(buttons().some(button => button.textContent?.includes("/directory"))).toBe(false);
  await act(async () => unavailable.forEach(button => button.click()));
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true));
  expect(unavailable).not.toContain(document.activeElement);
});

it("props 删除工作区后移除旧选项且不能派发旧 id", async () => {
  await render();
  const removed = option("/second/project");
  await render([repos[0]]);
  expect(option("/second/project")).toBeUndefined();
  expect(removed.isConnected).toBe(false);
  await act(async () => removed.click());
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => option("/project/worktree").click());
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("worktree-id");
});

it("首选工作区获得初始键盘焦点", async () => {
  await render();
  await vi.waitFor(() => expect(document.activeElement).toBe(option("/second/project")));
  expect(onSelect).not.toHaveBeenCalled();
});
