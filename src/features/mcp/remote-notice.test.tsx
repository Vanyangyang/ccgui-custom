import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ipc.ts subscribes to settings://changed at module scope; the stub keeps
// that subscription inert (the real transport needs Tauri internals).
vi.mock("@/lib/transport", () => ({
  isWeb: true,
  invoke: vi.fn(async (command: string) => {
    if (command === "mcp_inventory") return { engines: [], collectedAt: 1 };
    if (command === "skills_hub_query") return { targets: [], skills: [], updates: {}, activity: [], generatedAt: 1 };
    throw new Error(`Unexpected remote command: ${command}`);
  }),
  listen: async () => () => {},
}));

import "@/lib/i18n";
import { SkillsSection } from "@/features/skills/SkillsSection";
import { McpSection } from "./McpSection";
import { invoke } from "@/lib/transport";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("remote web access", () => {
  it("loads host Skills and MCP management through the browser bridge", async () => {
    await act(async () => {
      root.render(
        <div>
          <SkillsSection />
          <McpSection />
        </div>,
      );
    });
    expect(document.body.textContent).not.toContain("仅桌面端可用");
    expect(document.body.textContent).toContain("导入本地技能");
    expect(invoke).toHaveBeenCalledWith("mcp_inventory", { workspace: null });
    expect(invoke).toHaveBeenCalledWith("skills_hub_query", { mode: "installed", params: {} });
  });
});
