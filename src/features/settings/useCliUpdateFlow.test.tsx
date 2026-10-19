import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cliVersionStatus: vi.fn(),
  cliUpdatePlan: vi.fn(),
  cliUpdate: vi.fn(),
  listenCliUpdateProgress: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("@/lib/events", () => ({
  listenCliUpdateProgress: mocks.listenCliUpdateProgress,
}));
vi.mock("@/lib/transport", () => ({ invoke: mocks.invoke, listen: mocks.listen }));
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }));

import type { CliUpdatePlan, CliVersionStatus } from "@/lib/ipc";
import type { CliUpdateProgress } from "@/lib/events";
import type { EngineId } from "./providers";
import { useCliUpdateFlow, type CliUpdateFlow } from "./useCliUpdateFlow";
import type { CliUpdateSnapshot } from "./useCliVersionStatus";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function versionStatus(engine: EngineId): CliVersionStatus {
  return {
    engine,
    installed: true,
    localVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateAvailable: true,
    updateKind: "npm",
  };
}

function plan(engine: EngineId): CliUpdatePlan {
  return {
    engine,
    action: "update",
    kind: "npm",
    command: ["npm", "install", "-g", "pkg@latest"],
    manualCommand: "npm install -g pkg@latest",
    canRun: true,
    blockers: [],
    platform: "macos",
  };
}

/** Renders the hook and captures its latest value. */
function Probe({ engine, capture }: { engine: EngineId; capture: (v: CliUpdateFlow) => void }) {
  const value = useCliUpdateFlow(engine);
  useEffect(() => {
    capture(value);
  });
  return null;
}

// The version store behind the flow is module-level session state keyed by
// engine: each test uses its own engine so it starts cold.
describe("useCliUpdateFlow", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let latest: CliUpdateFlow;
  const capture = (v: CliUpdateFlow) => {
    latest = v;
  };
  /** The progress listener registered while a run is active. */
  let progressListener: ((events: CliUpdateProgress[]) => void) | null;
  const transportListeners = new Map<string, () => void>();

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.invoke.mockResolvedValue(null);
    transportListeners.clear();
    mocks.listen.mockImplementation((name: string, cb: () => void) => {
      transportListeners.set(name, cb);
      return Promise.resolve(() => transportListeners.delete(name));
    });
    mocks.listenCliUpdateProgress.mockImplementation(
      (cb: (events: CliUpdateProgress[]) => void) => {
        progressListener = cb;
        return Promise.resolve(() => {});
      },
    );
    progressListener = null;
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
    mocks.cliVersionStatus.mockResolvedValue(versionStatus(engine));
    const nextRoot = createRoot(container);
    root = nextRoot;
    await act(async () => {
      nextRoot.render(<Probe engine={engine} capture={capture} />);
    });
  }

  it("begin fetches the execution plan and waits for confirmation", async () => {
    mocks.cliUpdatePlan.mockResolvedValue(plan("kimi"));
    await render("kimi");
    expect(latest.state.status).toBe("idle");

    await act(async () => {
      await latest.begin();
    });
    expect(latest.state.status).toBe("ready");
    expect(latest.state.plan?.command).toEqual(["npm", "install", "-g", "pkg@latest"]);
    // No run yet: no runId, no listener, no invoke.
    expect(mocks.cliUpdate).not.toHaveBeenCalled();
    expect(mocks.listenCliUpdateProgress).toHaveBeenCalledTimes(1);
  });

  it("confirm streams only the current run's lines, then finishes done", async () => {
    mocks.cliUpdatePlan.mockResolvedValue(plan("pi"));
    const run = Promise.withResolvers<{ ok: boolean; version: string | null }>();
    mocks.cliUpdate.mockReturnValue(run.promise);
    await render("pi");
    await act(async () => {
      await latest.begin();
    });

    await act(async () => {
      void latest.confirm();
    });
    expect(latest.state.status).toBe("running");
    expect(mocks.cliUpdate).toHaveBeenCalledTimes(1);
    const runId = mocks.cliUpdate.mock.calls[0][1] as string;
    expect(progressListener).not.toBeNull();

    await act(async () => {
      progressListener?.([
        { runId: "someone-else", engine: "pi", phase: "stdout", line: "foreign", exitOk: null },
        { runId, engine: "pi", phase: "stdout", line: "downloading", exitOk: null },
        { runId, engine: "pi", phase: "stderr", line: "warn: deprecated", exitOk: null },
        { runId, engine: "pi", phase: "finished", line: null, exitOk: true },
      ]);
    });
    expect(latest.state.logs).toEqual([
      { stream: "stdout", text: "downloading" },
      { stream: "stderr", text: "warn: deprecated" },
    ]);
    // The finished event alone doesn't close the run — the invoke result does.
    expect(latest.state.status).toBe("running");

    await act(async () => {
      run.resolve({ ok: true, version: "1.1.0" });
      await run.promise;
    });
    expect(latest.state.status).toBe("done");
    // Success re-probes the version through the shared store.
    expect(mocks.cliVersionStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not report success when installer exits cleanly but effective version verification fails", async () => {
    mocks.cliUpdatePlan.mockResolvedValue(plan("codex"));
    const run = Promise.withResolvers<{ ok: boolean; version: string | null }>();
    mocks.cliUpdate.mockReturnValue(run.promise);
    await render("codex");
    await act(async () => { await latest.begin(); });
    let confirmation: Promise<void>;
    await act(async () => { confirmation = latest.confirm(); });
    const runId = mocks.cliUpdate.mock.calls[0][1] as string;
    await act(async () => {
      progressListener?.([
        { runId, engine: "codex", phase: "finished", line: null, exitOk: true },
      ]);
    });
    expect(latest.state.status).toBe("running");
    const error = "Effective Codex version is still 0.159.2; expected 0.163.0";
    await act(async () => {
      run.reject(new Error(error));
      await confirmation;
    });
    expect(latest.state.status).toBe("error");
    expect(latest.state.error).toBe(error);
    expect(latest.state.plan).not.toBeNull();
  });

  it("a failed run surfaces the error and offers retry", async () => {
    mocks.cliUpdatePlan.mockResolvedValue(plan("omp"));
    mocks.cliUpdate.mockRejectedValue(new Error("npm boom"));
    await render("omp");
    await act(async () => {
      await latest.begin();
    });

    await act(async () => {
      await latest.confirm();
    });
    expect(latest.state.status).toBe("error");
    expect(latest.state.error).toBe("npm boom");
    // The plan stays so retry can re-run without re-planning.
    expect(latest.state.plan).not.toBeNull();
  });

  it("close is a no-op while a run is active", async () => {
    mocks.cliUpdatePlan.mockResolvedValue(plan("claude"));
    const run = Promise.withResolvers<{ ok: boolean; version: string | null }>();
    mocks.cliUpdate.mockReturnValue(run.promise);
    await render("claude");
    await act(async () => {
      await latest.begin();
    });
    await act(async () => {
      void latest.confirm();
    });

    await act(async () => {
      latest.close();
    });
    expect(latest.state.status).toBe("running");

    await act(async () => {
      run.resolve({ ok: true, version: "1.1.0" });
      await run.promise;
    });
    await act(async () => {
      latest.close();
    });
    expect(latest.state.status).toBe("idle");
  });

  it("begin adopts another client's running installer without planning or starting a second one", async () => {
    mocks.invoke.mockResolvedValue({ engine: "dsh", runId: "host-run", status: "running", sequence: 4,
      logs: [{ stream: "stdout", text: "host output", sequence: 3 }], error: null, version: null });
    await render("dsh");
    await act(async () => { await latest.begin(); });
    expect(latest.state.status).toBe("running");
    expect(latest.state.runId).toBe("host-run");
    expect(latest.state.logs).toEqual([{ stream: "stdout", text: "host output" }]);
    await act(async () => { await latest.confirm(); });
    expect(mocks.cliUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.cliUpdate).not.toHaveBeenCalled();
  });

  it("recovers the same completed attempt after transport loss without issuing another install", async () => {
    let snapshot: CliUpdateSnapshot | null = null;
    mocks.invoke.mockImplementation(async () => snapshot);
    mocks.cliUpdatePlan.mockResolvedValue(plan("opencode"));
    mocks.cliUpdate.mockImplementation((_engine: string, runId: string) => {
      snapshot = { engine: "opencode", runId, status: "running", sequence: 1, logs: [], error: null, version: null };
      return Promise.reject(new Error("web bridge disconnected"));
    });
    await render("opencode");
    await act(async () => { await latest.begin(); });
    await act(async () => { await latest.confirm(); });
    expect(latest.state.status).toBe("running");
    const runId = latest.state.runId!;
    snapshot = { engine: "opencode", runId, status: "done", sequence: 3,
      logs: [{ stream: "stdout", text: "finished offline", sequence: 2 }], error: null, version: "2.0" };
    await act(async () => { transportListeners.get("transport://connected")?.(); });
    expect(latest.state.status).toBe("done");
    expect(latest.state.runId).toBe(runId);
    expect(latest.state.logs).toEqual([{ stream: "stdout", text: "finished offline" }]);
    expect(mocks.cliUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps sequenced logs bounded and ignores replayed lines", async () => {
    mocks.invoke.mockResolvedValue({ engine: "grok", runId: "run-log", status: "running", sequence: 1, logs: [], error: null, version: null });
    await render("grok");
    await act(async () => { await latest.begin(); });
    await act(async () => {
      progressListener?.(Array.from({ length: 220 }, (_, index) => ({ runId: "run-log", engine: "grok", phase: "stdout" as const, line: `line-${index}`, exitOk: null, sequence: index + 2 })));
    });
    expect(latest.state.logs).toHaveLength(200);
    expect(latest.state.logs[0].text).toBe("line-20");
    await act(async () => { progressListener?.([{ runId: "run-log", engine: "grok", phase: "stdout", line: "duplicate", exitOk: null, sequence: 221 }]); });
    expect(latest.state.logs.at(-1)?.text).toBe("line-219");
  });

  it("does not lose settled while a finished-event snapshot is still in flight", async () => {
    const running: CliUpdateSnapshot = { engine: "agy", runId: "shared-run", status: "running", sequence: 1, logs: [], error: null, version: null };
    mocks.invoke.mockResolvedValue(running);
    await render("agy");
    await act(async () => { await latest.begin(); });
    const slow = Promise.withResolvers<CliUpdateSnapshot>();
    mocks.invoke.mockReturnValueOnce(slow.promise).mockResolvedValue({ ...running, status: "done", sequence: 3, version: "3.0" });
    await act(async () => {
      progressListener?.([{ engine: "agy", runId: "shared-run", phase: "finished", line: null, exitOk: true, sequence: 2 }]);
      progressListener?.([{ engine: "agy", runId: "shared-run", phase: "settled", line: null, exitOk: true, sequence: 3 }]);
    });
    expect(latest.state.status).toBe("running");
    await act(async () => { slow.resolve({ ...running, sequence: 2 }); });
    expect(latest.state.status).toBe("done");
    expect(mocks.cliUpdate).not.toHaveBeenCalled();
  });

  it("makes a vanished attempt after host restart explicitly unknown and closable", async () => {
    mocks.invoke.mockResolvedValue({ engine: "codex", runId: "lost-run", status: "running", sequence: 10, logs: [], error: null, version: null });
    await render("codex");
    await act(async () => { await latest.begin(); });
    mocks.invoke.mockResolvedValue(null);
    await act(async () => { transportListeners.get("transport://connected")?.(); });
    expect(latest.state.status).toBe("error");
    expect(latest.state.error).toBe("settings.cliUpdateOutcomeUnknown");
    await act(async () => { latest.close(); });
    expect(latest.state.status).toBe("idle");
    expect(mocks.cliUpdate).not.toHaveBeenCalled();
  });
});
