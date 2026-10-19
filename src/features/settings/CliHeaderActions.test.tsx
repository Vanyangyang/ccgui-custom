import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cliVersionStatus: vi.fn(),
  cliUpdate: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));

import "@/lib/i18n";
import type { CliVersionStatus } from "@/lib/ipc";
import { CliHeaderActions } from "./CliHeaderActions";
import type { EngineId } from "./providers";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function versionStatus(engine: EngineId, over: Partial<CliVersionStatus> = {}): CliVersionStatus {
  return {
    engine,
    installed: true,
    localVersion: "2.1.228 (Claude Code)",
    latestVersion: "2.1.267",
    updateAvailable: true,
    updateKind: "native",
    ...over,
  };
}

// The version store is module-level session state keyed by engine: each
// test uses its own engine so it starts cold without resetting the module.
describe("CliHeaderActions", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    mocks.cliVersionStatus.mockReset();
    mocks.cliUpdate.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
    }
    container.remove();
  });

  async function render(engine: EngineId) {
    const nextRoot = createRoot(container);
    root = nextRoot;
    await act(async () => {
      nextRoot.render(<CliHeaderActions engine={engine} />);
    });
  }

  it("update available: version and CTA ride in one segmented pill", async () => {
    mocks.cliVersionStatus.mockResolvedValue(versionStatus("claude"));
    await render("claude");
    const text = container.textContent ?? "";
    expect(text).toContain("v2.1.228 (Claude Code)");
    expect(text).toContain("更新至 2.1.267");
    // The old "→ version" warning badge is gone — the CTA carries the target.
    expect(text).not.toContain("→ 2.1.267");
    expect(container.querySelector('[aria-label="已是最新"]')).toBeNull();
    // Docs and refresh are icon-only ghost buttons, no visible labels.
    expect(container.querySelector('[aria-label="官方文档"]')).not.toBeNull();
    expect(text).not.toContain("官方文档");
    // Version status and the update CTA are segments of a single pill.
    const cta = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("更新至"),
    );
    expect(cta?.parentElement?.textContent).toContain("v2.1.228 (Claude Code)");
  });

  it("up to date: the check rides inside the pill's status segment, no CTA segment", async () => {
    mocks.cliVersionStatus.mockResolvedValue(
      versionStatus("codex", { updateAvailable: false }),
    );
    await render("codex");
    const text = container.textContent ?? "";
    expect(text).toContain("v2.1.228 (Claude Code)");
    expect(text).not.toContain("已是最新");
    expect(container.querySelector('[aria-label="已是最新"]')).not.toBeNull();
    expect(text).not.toContain("更新至");
  });

  it("not installed: badge plus install CTA", async () => {
    mocks.cliVersionStatus.mockResolvedValue(
      versionStatus("pi", {
        installed: false,
        localVersion: null,
        latestVersion: null,
        updateAvailable: false,
      }),
    );
    await render("pi");
    const text = container.textContent ?? "";
    expect(text).toContain("未安装");
    expect(text).toContain("安装");
  });

  it("refresh button spins while a probe is in flight", async () => {
    let resolveProbe: (s: CliVersionStatus) => void = () => {};
    mocks.cliVersionStatus.mockImplementation(
      () => new Promise<CliVersionStatus>((resolve) => { resolveProbe = resolve; }),
    );
    await render("omp");
    const refreshBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="刷新版本信息"]',
    );
    expect(refreshBtn).not.toBeNull();
    expect(refreshBtn!.disabled).toBe(true);
    // Same spin feedback as the 变更 panel's refresh while the probe runs.
    expect(refreshBtn!.querySelector(".animate-refresh-spin")).not.toBeNull();
    await act(async () => {
      resolveProbe(versionStatus("omp"));
    });
  });
});
