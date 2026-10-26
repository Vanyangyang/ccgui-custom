import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FileTreeBody } from "./FileTreeBody";
import type { VisibleNode } from "./FileTreeRow";

const state = vi.hoisted(() => ({
  root: "/good", roots: [{ path: "/gone", status: "missing" }],
  dirErrors: {}, loadingDirs: {}, children: { "/good": [] }, selectedPath: null,
  ensureDir: vi.fn(), toggleDir: vi.fn(), selectPath: vi.fn(), openFile: vi.fn(), reload: vi.fn(),
}));
vi.mock("./store", () => ({ useFilesStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }) }));
vi.mock("@/features/projects/store", () => ({ useProjectsStore: { getState: () => ({ load: state.reload }) } }));
vi.mock("@/features/chat/store", () => ({ useChatStore: { getState: () => ({ requestMention: vi.fn() }) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./FileTreeRow", () => ({ TreeRow: ({ node, onToggleDir }: { node: VisibleNode; onToggleDir(path: string): void }) => <button onClick={() => onToggleDir(node.path)}>{node.name}</button> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows available roots beside unavailable roots and revalidates before retrying access", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const visible: VisibleNode[] = ["/gone", "/good"].map((path) => ({
    path, name: path, isDir: true, size: 0, mtimeMs: 0, depth: 0, expanded: false, loading: false,
    projectRoot: { path, label: path, role: "reference", status: path === "/gone" ? "missing" : "available" },
  }));
  const virtualizer = {
    getTotalSize: () => 100, getVirtualItems: () => visible.map((_, index) => ({ index, start: index * 40 })), measureElement: () => {},
  } as unknown as Parameters<typeof FileTreeBody>[0]["virtualizer"];
  act(() => root.render(<FileTreeBody visible={visible} virtualizer={virtualizer} onContextMenu={vi.fn()} />));
  expect(host.textContent).toContain("/good");
  expect(host.textContent).toContain("projectsFiles.missing");
  act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "/gone")!.click());
  expect(state.toggleDir).not.toHaveBeenCalled();
  act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "common.refresh")!.click());
  expect(state.reload).toHaveBeenCalledOnce();
  expect(state.ensureDir).not.toHaveBeenCalled();
  act(() => root.unmount());
});
