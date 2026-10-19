import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelTabRegistry } from "@ccgui/plugin-sdk";
import { ChatSidePanel } from "./ChatSidePanel";
import type { ActiveSession } from "./store";
// Side-effect import: registers the builtin files/changes tabs (their panel
// components are mocked below so no IPC runs under jsdom).
import "./panel-tabs";

vi.mock("@/features/files/FilesPanel", () => ({
  FilesPanel: () => <div>files-panel-stub</div>,
}));
vi.mock("@/features/git/ChangesPanel", () => ({
  ChangesPanel: ({ visible = true }: { visible?: boolean }) => visible ? <div>changes-panel-stub</div> : null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const active: ActiveSession = {
  engine: "dsh",
  sessionId: null,
  workspacePath: "/tmp/ws",
};

describe("panel tabs registry integration (plan §4.2 #4)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(panelTab: string, panelCollapsed = false) {
    act(() => {
      root.render(
        <ChatSidePanel
          active={active}
          panelRef={{ current: null }}
          panelWidth={300}
          panelCollapsed={panelCollapsed}
          dragging={null}
          panelTab={panelTab}
          onResizeStart={() => {}}
        />,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("mounts Git only while visible and preserves the files panel node", () => {
    render("files");
    const files = Array.from(container.querySelectorAll("div")).find(
      (element) => element.textContent === "files-panel-stub" && element.children.length === 0,
    );
    expect(container.textContent).not.toContain("changes-panel-stub");
    render("changes");
    expect(container.textContent).toContain("changes-panel-stub");
    render("changes", true);
    expect(container.textContent).not.toContain("changes-panel-stub");
    render("changes");
    expect(container.textContent).toContain("changes-panel-stub");
    render("files");
    expect(container.textContent).not.toContain("changes-panel-stub");
    expect(files?.isConnected).toBe(true);
  });

  it("does not mount Git when the sidebar starts collapsed", () => {
    render("changes", true);
    expect(container.textContent).not.toContain("changes-panel-stub");
    expect(container.textContent).toContain("files-panel-stub");
  });

  it("honors a registry override of the changes component without builtin props", () => {
    const builtin = panelTabRegistry.get("changes")!;
    const replacement = vi.fn((_props: { workspacePath: string }) => <div>custom-changes</div>);
    try {
      act(() => { panelTabRegistry.register({ ...builtin, component: replacement }); });
      render("changes");
      expect(container.textContent).toContain("custom-changes");
      expect(replacement.mock.calls[0]?.[0]).toEqual({ workspacePath: active.workspacePath });
    } finally {
      act(() => { panelTabRegistry.register(builtin); });
    }
  });

  it("renders a registered plugin tab's component; disposer removes it", () => {
    const dispose = panelTabRegistry.register({
      id: "plugin:demo:extra",
      label: () => "Extra",
      component: () => <div>plugin-panel-marker</div>,
    });
    render("plugin:demo:extra");
    // The plugin panel renders, and the builtin files panel stays mounted
    // (hidden) so tree state survives tab switches.
    expect(container.textContent).toContain("plugin-panel-marker");
    expect(container.textContent).toContain("files-panel-stub");
    act(() => dispose());
    expect(container.textContent).not.toContain("plugin-panel-marker");
    expect(container.textContent).toContain("files-panel-stub");
  });

  it("a crashing plugin tab is contained by PluginBoundary", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dispose = panelTabRegistry.register({
      id: "plugin:demo:crasher",
      label: () => "Crasher",
      component: () => {
        throw new Error("boom");
      },
    });
    render("plugin:demo:crasher");
    // The boundary swallows the crash; the host's other panels are intact.
    expect(container.textContent).toContain("files-panel-stub");
    act(() => dispose());
    vi.restoreAllMocks();
  });
});
