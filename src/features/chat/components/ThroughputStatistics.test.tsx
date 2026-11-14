import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { listenThroughputChanged, listenTransportConnected } from "@/lib/events";
import { ThroughputStatus } from "./ThroughputStatus";

vi.mock("@/lib/ipc", () => ({ ipc: { throughputStatsRead: vi.fn() } }));
vi.mock("@/lib/events", () => ({ listenThroughputChanged: vi.fn(), listenTransportConnected: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const global = {
  outputTokens: 900,
  elapsedMs: 30000,
  completedTurns: 4,
  excludedTurns: 2,
  interruptedTurns: 1,
  missingTurns: 1,
  medianTps: 31,
};
const session = {
  outputTokens: 100,
  elapsedMs: 10000,
  completedTurns: 1,
  excludedTurns: 1,
  interruptedTurns: 0,
  missingTurns: 1,
};

describe("separate turn, session and global TPS", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
    vi.mocked(listenThroughputChanged).mockResolvedValue(() => {});
    vi.mocked(listenTransportConnected).mockResolvedValue(() => {});
    vi.mocked(ipc.throughputStatsRead).mockResolvedValue({
      global,
      session,
      byEngine: { codex: global, cursor: session },
      byModel: { "gpt-5.4": global, "claude-4.6-opus": session },
      startedAt: 1900000000000,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async () => {
    await act(async () =>
      root.render(
        <ThroughputStatus
          scope={{ engine: "codex", sessionId: "a", workspacePath: "C:/fixture" }}
          throughput={{
            runId: "run",
            seq: 1,
            ended: true,
            sample: {
              version: 1,
              source: "codex_app_server",
              status: "complete",
              outputTokens: 100,
              elapsedMs: 1000,
              generation: null,
              generationReason: "tools",
            },
          }}
        />,
      ),
    );
  };

  it("renders steady-state session pill and 3-tier popover with model/engine toggle", async () => {
    await render();
    expect(container.textContent).toBe("⚡ Session 10 tok/s");
    await act(async () => container.querySelector("button")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[aria-label="Current session total"]')?.textContent).toContain("10 tok/s");
    expect(dialog.textContent).toContain("Included 1 · Interrupted/failed 0 · Missing/excluded 1");

    const history = dialog.querySelector("details")!;
    expect(history.open).toBe(false);
    await act(async () => history.querySelector("summary")!.click());
    expect(history.open).toBe(true);
    expect(dialog.querySelector('[aria-label="Global history"]')?.textContent).toContain("30 tok/s");
    expect(dialog.querySelector('[aria-label="Global history"]')?.textContent).toContain("Median 31 tok/s");
    expect(dialog.textContent).toContain("Included 4 · Interrupted/failed 1 · Missing/excluded 1");
    // Grouped by model by default
    expect(dialog.querySelector('[aria-label="gpt-5.4"]')?.textContent).toContain("30 tok/s");
    expect(dialog.querySelector('[aria-label="claude-4.6-opus"]')?.textContent).toContain("10 tok/s");

    // Toggle to By engine
    const byEngineBtn = [...history.querySelectorAll("button")].find((b) => b.textContent === "By engine")!;
    await act(async () => byEngineBtn.click());
    expect(dialog.querySelector('[aria-label="Codex"]')?.textContent).toContain("30 tok/s");
    expect(dialog.querySelector('[aria-label="Cursor"]')?.textContent).toContain("10 tok/s");
    expect(dialog.textContent).toContain("not zero-speed turns");
    expect(dialog.textContent).toContain("Recording enabled:");
    expect(dialog.textContent).toContain("not backfilled");
  });

  it("appends live running estimate while running and settles back to steady session pill", async () => {
    await i18n.changeLanguage("zh");
    await act(async () =>
      root.render(
        <ThroughputStatus
          scope={{ engine: "cursor", sessionId: "a", workspacePath: "C:/fixture" }}
          throughput={{
            runId: "run-live",
            seq: 2,
            ended: false,
            sample: {
              version: 1,
              source: "cursor",
              status: "running",
              outputTokens: null,
              elapsedMs: 2000,
              generation: null,
              generationReason: "unsupported",
              liveEstimate: { outputTokens: 98, elapsedMs: 2000, estimated: true },
            },
          }}
        />,
      ),
    );
    expect(container.textContent).toBe("⚡ 会话 10 tok/s · 预估 ~49 tok/s");
  });

  it("labels AGY statistics independently when no model attribution exists", async () => {
    vi.mocked(ipc.throughputStatsRead).mockResolvedValue({
      global,
      session,
      byEngine: { agy: global },
      startedAt: 1900000000000,
    });
    await render();
    await act(async () => container.querySelector("button")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[aria-label="AGY"]')?.textContent).toContain("30 tok/s");
    expect(dialog.querySelector('[aria-label="Codex"]')).toBeNull();
  });

  it("keeps the current turn visible when historical statistics fail", async () => {
    vi.mocked(ipc.throughputStatsRead).mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(container.textContent).toBe("Turn 100 tok/s");
    await act(async () => container.querySelector("button")!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not update cumulative statistics");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("reconnection");
  });

  it("renders steady-state placeholder ⚡ Session — before the first valid session turn completes", async () => {
    vi.mocked(ipc.throughputStatsRead).mockResolvedValue({
      global,
      session: { outputTokens: 0, elapsedMs: 0, completedTurns: 0, excludedTurns: 0 },
      byEngine: {},
      startedAt: 1900000000000,
    });
    await act(async () => root.render(<ThroughputStatus scope={{ engine: "agy", sessionId: "a" }} throughput={null} />));
    expect(container.textContent).toBe("⚡ Session —");
    expect(container.querySelector("button")).not.toBeNull();
  });
});
