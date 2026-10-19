import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ipc, type ThroughputStatsSnapshot } from "@/lib/ipc";
import { listenThroughputChanged, listenTransportConnected } from "@/lib/events";
import { useThroughputStats } from "./use-throughput-stats";
vi.mock("@/lib/ipc", () => ({ipc:{throughputStatsRead:vi.fn()}}));
vi.mock("@/lib/events", () => ({listenThroughputChanged:vi.fn(),listenTransportConnected:vi.fn()}));
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT:true});
const totals = (tokens=100) => ({outputTokens:tokens,elapsedMs:10000,completedTurns:1,excludedTurns:0});
const snapshot = (tokens=100): ThroughputStatsSnapshot => ({global:totals(900),session:totals(tokens),byEngine:{codex:totals(900)},startedAt:1900000000000});
function deferred<T>() { let resolve!: (value:T)=>void; const promise = new Promise<T>(done => {resolve=done;}); return {promise,resolve}; }
let controls: ReturnType<typeof useThroughputStats>;
function Probe({id="a",enabled=true}: {id?:string;enabled?:boolean}) {
  controls = useThroughputStats(enabled ? {engine:"codex",sessionId:id,workspacePath:"C:/fixture"}:undefined);
  return <span>{controls.snapshot?.session.outputTokens ?? "missing"}</span>;
}
describe("throughput statistics scope and notifications", () => {
  let root: Root; let container: HTMLDivElement; let changed: ()=>void; let connected: ()=>void; let stop: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks(); stop=vi.fn();
    vi.mocked(listenThroughputChanged).mockImplementation(async callback => {changed=callback;return stop;});
    vi.mocked(listenTransportConnected).mockImplementation(async callback => {connected=callback;return vi.fn();});
    vi.mocked(ipc.throughputStatsRead).mockResolvedValue(snapshot());
    container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);
  });
  afterEach(async () => {await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();});
  const render = async (id="a",enabled=true) => {await act(async()=>root.render(<Probe id={id} enabled={enabled}/>));};
  it("subscribes before reading and never records or polls from the UI", async () => {
    const ready=deferred<()=>void>();vi.mocked(listenThroughputChanged).mockImplementationOnce(callback => {changed=callback;return ready.promise;});
    const polling=vi.spyOn(window,"setInterval");
    await render();expect(ipc.throughputStatsRead).not.toHaveBeenCalled();
    await act(async()=>ready.resolve(stop));
    expect(ipc.throughputStatsRead).toHaveBeenCalledWith({engine:"codex",sessionId:"a",workspacePath:"C:/fixture"});
    await act(async()=>changed());
    await act(async()=>window.dispatchEvent(new Event("focus")));
    expect(ipc.throughputStatsRead).toHaveBeenCalledTimes(3);
    expect(polling).not.toHaveBeenCalled();
  });
  it("discards an old session response after switching conversations", async () => {
    const old=deferred<ThroughputStatsSnapshot>();
    vi.mocked(ipc.throughputStatsRead).mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot(800));
    await render("a");await render("b");
    expect(container.textContent).toBe("800");
    await act(async()=>old.resolve(snapshot(100)));
    expect(container.textContent).toBe("800");
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("coalesces terminal invalidations during an in-flight read", async () => {
    const pending=deferred<ThroughputStatsSnapshot>();
    vi.mocked(ipc.throughputStatsRead).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(snapshot(300));
    await render();await act(async()=>{changed();changed();changed();});
    expect(ipc.throughputStatsRead).toHaveBeenCalledTimes(1);
    await act(async()=>pending.resolve(snapshot(100)));
    expect(ipc.throughputStatsRead).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("300");
  });
  it("distinguishes a failed read from an empty history and recovers on notification", async () => {
    await render();
    vi.mocked(ipc.throughputStatsRead).mockRejectedValueOnce(new Error("offline"));
    await act(async()=>changed());
    expect(controls.error).toBe(true);expect(controls.snapshot?.session.outputTokens).toBe(100);
    await act(async()=>changed());expect(controls.error).toBe(false);expect(container.textContent).toBe("100");
  });
  it("reconciles after reconnect without polling or erasing a successful same-session snapshot", async () => {
    await render();
    vi.mocked(ipc.throughputStatsRead).mockRejectedValueOnce(new Error("disconnected"));
    await act(async()=>changed());
    expect(container.textContent).toBe("100");expect(controls.error).toBe(true);
    vi.mocked(ipc.throughputStatsRead).mockResolvedValueOnce(snapshot(500));
    await act(async()=>connected());
    expect(container.textContent).toBe("500");expect(controls.error).toBe(false);
  });
  it("never retains another conversation's successful statistics after a failed new scope read", async () => {
    await render("a");
    vi.mocked(ipc.throughputStatsRead).mockRejectedValueOnce(new Error("unavailable"));
    await render("b");
    expect(controls.error).toBe(true);expect(controls.snapshot).toBeUndefined();expect(container.textContent).toBe("missing");
  });
  it("does not read when disabled and disposes a subscription that resolves late", async () => {
    await render("a",false);expect(ipc.throughputStatsRead).not.toHaveBeenCalled();
    const ready=deferred<()=>void>();vi.mocked(listenThroughputChanged).mockReturnValueOnce(ready.promise);
    await render();await render("a",false);
    await act(async()=>ready.resolve(stop));
    expect(stop).toHaveBeenCalledOnce();expect(ipc.throughputStatsRead).not.toHaveBeenCalled();
  });
});
