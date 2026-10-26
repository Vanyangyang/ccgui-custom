import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type CursorQuotaSnapshot } from "@/lib/ipc";
import { useCursorQuota } from "./use-cursor-quota";

vi.mock("@/lib/ipc", () => ({ ipc: { cursorQuotaRead: vi.fn() } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const NOW = 1_900_000_000;
const quota: CursorQuotaSnapshot = { status: "ready", collectedAt: NOW, planName: "Pro", autoPercent: 20, apiPercent: 40 };
let controls: ReturnType<typeof useCursorQuota>;
function Probe({ engine }: { engine: string }) {
  controls = useCursorQuota(engine);
  return null;
}

describe("Cursor quota retention", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.mocked(ipc.cursorQuotaRead).mockResolvedValue(quota);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  async function render(engine = "cursor") { await act(async () => root.render(<Probe engine={engine} />)); }

  it("retains the original sample across repeated IPC failures and replaces it on recovery", async () => {
    await render();
    vi.mocked(ipc.cursorQuotaRead).mockRejectedValue(new Error("disconnected"));
    await act(async () => vi.advanceTimersByTimeAsync(3_600_000));
    expect(controls.snapshot).toEqual({ ...quota, status: "stale", errorCode: "read_failed" });
    vi.mocked(ipc.cursorQuotaRead).mockResolvedValue({ ...quota, collectedAt: NOW + 3600, autoPercent: 0 });
    await act(async () => controls.refresh());
    expect(controls.snapshot).toMatchObject({ status: "ready", collectedAt: NOW + 3600, autoPercent: 0 });
  });

  it("honors native logout and cannot resurrect the old account on a later IPC failure", async () => {
    await render();
    vi.mocked(ipc.cursorQuotaRead).mockResolvedValueOnce({ status: "unavailable", errorCode: "not_logged_in" });
    await act(async () => controls.refresh());
    expect(controls.snapshot?.planName).toBeUndefined();
    vi.mocked(ipc.cursorQuotaRead).mockRejectedValueOnce(new Error("disconnected"));
    await act(async () => controls.refresh());
    expect(controls.snapshot).toEqual({ status: "unavailable", errorCode: "read_failed" });
  });

  it("ignores a late response after leaving Cursor and cleans up timers", async () => {
    await render();
    let resolve!: (snapshot: CursorQuotaSnapshot) => void;
    vi.mocked(ipc.cursorQuotaRead).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    let pending!: Promise<void>;
    await act(async () => { pending = controls.refresh(); });
    await render("codex");
    await act(async () => { resolve(quota); await pending; });
    expect(controls.snapshot).toBeUndefined();
    expect(controls.loading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
