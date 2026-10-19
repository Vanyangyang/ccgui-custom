import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/lib/ipc";

const { listGrantedRoots, addWorkspaceMock, removeWorkspaceMock } = vi.hoisted(() => ({
  listGrantedRoots: vi.fn(async () => []),
  addWorkspaceMock: vi.fn(async (path: string) => ({
    id: "ws-self-dev",
    path,
    name: "ccgui-custom",
    lastOpenedAt: null,
    sortOrder: 0,
    groupId: null,
  })),
  removeWorkspaceMock: vi.fn(async () => undefined),
}));

vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    ipc: new Proxy(
      {
        listGrantedRoots,
        addWorkspace: addWorkspaceMock,
        removeWorkspace: removeWorkspaceMock,
        revealInFileManager: vi.fn(async () => undefined),
      },
      {
        get: (target, prop) =>
          prop in target ? Reflect.get(target, prop) : async () => null,
      },
    ),
  };
});

vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  isWeb: false,
}));

import "@/lib/i18n";
import { useChatStore } from "@/features/chat/store";
import { ChatPageDialogs } from "@/features/chat/ChatPageDialogs";
import { WorkspacesSection } from "@/features/settings/WorkspacesSection";
import { useLiveUpdateStore } from "./live-update";
import {
  readStoredSelfDevWorkspacePath,
  resolveSelfDevWorkspace,
} from "./self-dev-workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SELF_DEV_WS: Workspace = {
  id: "ws-self-dev",
  path: "C:\\Projects\\ccgui-custom",
  name: "ccgui-custom",
  lastOpenedAt: null,
  sortOrder: 0,
  groupId: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  addWorkspaceMock.mockClear();
  removeWorkspaceMock.mockClear();
  useLiveUpdateStore.setState({
    support: "supported",
    channel: {
      version: 1,
      ready: [
        {
          id: "c1",
          changeId: "c1",
          summary: "test",
          sourceRoot: "c:\\projects\\ccgui-custom",
        },
      ],
      working: [],
    },
  });
  useChatStore.setState({
    workspaces: [SELF_DEV_WS],
    workspaceGroups: [],
    workspaceAliases: {},
    archivedWorkspaces: [],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

describe("self-dev workspace identification, removal protection, and settings reopen", () => {
  it("matches channel sourceRoot case-insensitively and preserves display-cased path", () => {
    const resolved = resolveSelfDevWorkspace(
      [SELF_DEV_WS],
      {
        version: 1,
        ready: [
          {
            id: "c1",
            changeId: "c1",
            summary: "test",
            sourceRoot: "c:/projects/ccgui-custom/",
            },
        ],
        working: [],
      },
      null,
    );
    expect(resolved.workspace?.id).toBe("ws-self-dev");
    expect(resolved.path).toBe("C:\\Projects\\ccgui-custom");
    expect(resolved.inWorkspaces).toBe(true);
  });

  it("requires explicit consent checkbox before removing self-dev workspace", async () => {
    const onClose = vi.fn();
    const removeSpy = vi.fn(async () => undefined);
    useChatStore.setState({
      workspaces: [SELF_DEV_WS],
      removeWorkspace: removeSpy,
    });

    await act(async () => {
      root.render(
        <ChatPageDialogs
          dialog={{ kind: "removeWorkspace", workspaceId: "ws-self-dev" }}
          onClose={onClose}
        />,
      );
    });

    const notice = document.body.querySelector(
      '[data-testid="self-dev-remove-notice"]',
    );
    expect(notice?.textContent).toContain("须知");
    expect(notice?.textContent).toContain("设置 → 工作区 → CC GUI 自开发工程目录");

    const checkbox = document.body.querySelector(
      '[data-testid="self-dev-remove-consent-checkbox"]',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);

    const buttons = Array.from(document.body.querySelectorAll("button"));
    const confirmBtn = buttons.find((b) => b.textContent?.includes("确认移除"));
    expect(confirmBtn).toBeDefined();
    expect(confirmBtn?.hasAttribute("disabled")).toBe(true);

    // Tick consent checkbox
    await act(async () => {
      checkbox!.click();
    });
    expect(checkbox?.checked).toBe(true);
    expect(confirmBtn?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      confirmBtn!.click();
    });
    expect(removeSpy).toHaveBeenCalledWith("ws-self-dev");
    expect(readStoredSelfDevWorkspacePath()).toBe("C:\\Projects\\ccgui-custom");
  });

  it("shows removed status in Settings -> Workspaces and reopens on click", async () => {
    const addSpy = vi.fn(async () => undefined);
    const startNewChatSpy = vi.fn();
    useChatStore.setState({
      workspaces: [],
      archivedWorkspaces: [],
      addWorkspace: addSpy,
      startNewChat: startNewChatSpy,
    });

    await act(async () => {
      root.render(<WorkspacesSection />);
    });

    const status = container.querySelector(
      '[data-testid="settings-self-dev-status"]',
    );
    expect(status?.textContent).toBe("已从工作区移除");

    const openBtn = container.querySelector(
      '[data-testid="settings-self-dev-open"]',
    ) as HTMLButtonElement | null;
    expect(openBtn).not.toBeNull();
    expect(openBtn?.textContent).toContain("在工作区中打开");

    await act(async () => {
      openBtn!.click();
    });
    expect(addSpy).toHaveBeenCalledWith("c:\\projects\\ccgui-custom");

    const buildSpy = vi.fn(async () => undefined);
    await act(async () => {
      useLiveUpdateStore.setState({ requestUpdate: buildSpy });
    });

    const buildBtn = container.querySelector(
      '[data-testid="settings-self-dev-build"]',
    ) as HTMLButtonElement | null;
    expect(buildBtn).not.toBeNull();
    expect(buildBtn?.textContent).toContain("构建并热更新");

    await act(async () => {
      buildBtn!.click();
    });
    expect(buildSpy).toHaveBeenCalledWith("c:\\projects\\ccgui-custom");
  });
});
