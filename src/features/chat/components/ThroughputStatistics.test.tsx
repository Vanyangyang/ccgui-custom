import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import i18n from "@/lib/i18n";
import {ipc} from "@/lib/ipc";
import {listenThroughputChanged, listenTransportConnected} from "@/lib/events";
import {ThroughputStatus} from "./ThroughputStatus";
vi.mock("@/lib/ipc",()=>({ipc:{throughputStatsRead:vi.fn()}}));
vi.mock("@/lib/events",()=>({listenThroughputChanged:vi.fn(),listenTransportConnected:vi.fn()}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
const global={outputTokens:900,elapsedMs:30000,completedTurns:4,excludedTurns:2};
const session={outputTokens:100,elapsedMs:10000,completedTurns:1,excludedTurns:1};
describe("separate turn, session and global TPS",()=>{
  let root:Root;let container:HTMLDivElement;
  beforeEach(async()=>{
    vi.clearAllMocks();await i18n.changeLanguage("en");
    vi.mocked(listenThroughputChanged).mockResolvedValue(()=>{});
    vi.mocked(listenTransportConnected).mockResolvedValue(()=>{});
    vi.mocked(ipc.throughputStatsRead).mockResolvedValue({global,session,byEngine:{codex:global},startedAt:1900000000000});
    container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);
  });
  afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
  const render=async()=>{await act(async()=>root.render(<ThroughputStatus scope={{engine:"codex",sessionId:"a",workspacePath:"C:/fixture"}}
    throughput={{runId:"run",seq:1,ended:true,sample:{version:1,source:"codex_app_server",status:"complete",outputTokens:100,elapsedMs:1000,generation:null,generationReason:"tools"}}}/>));};
  it("renders distinct rates and persisted coverage details",async()=>{
    await render();expect(container.textContent).toBe("Session 10 tokens/s · Turn 100 tokens/s");
    await act(async()=>container.querySelector("button")!.click());
    const dialog=document.querySelector('[role="dialog"]')!;
    const history = dialog.querySelector("details")!;
    expect(history.open).toBe(false);
    await act(async () => history.querySelector("summary")!.click());
    expect(history.open).toBe(true);
    expect(dialog.querySelector('[aria-label="Current session total"]')?.textContent).toContain("10 tokens/s");
    expect(dialog.querySelector('[aria-label="Global history"]')?.textContent).toContain("30 tokens/s");
    expect(dialog.textContent).toContain("Valid samples: 4 / 6 turns");
    expect(dialog.textContent).toContain("not zero-speed turns");
    expect(dialog.textContent).toContain("Recording enabled:");
    expect(dialog.textContent).toContain("not backfilled");
  });
  it("labels AGY statistics independently from Codex",async()=>{
    vi.mocked(ipc.throughputStatsRead).mockResolvedValue({global,session,byEngine:{agy:global},startedAt:1900000000000});
    await render();
    await act(async()=>container.querySelector("button")!.click());
    const dialog=document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[aria-label="AGY"]')?.textContent).toContain("30 tokens/s");
    expect(dialog.querySelector('[aria-label="Codex"]')).toBeNull();
  });
  it("keeps the current turn visible when historical statistics fail",async()=>{
    vi.mocked(ipc.throughputStatsRead).mockRejectedValueOnce(new Error("offline"));
    await render();expect(container.textContent).toBe("Turn 100 tokens/s");
    await act(async()=>container.querySelector("button")!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not update cumulative statistics");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("reconnection");
  });
  it("shows only the measured session rate when the turn has no measurement", async () => {
    await act(async () => root.render(<ThroughputStatus scope={{engine:"agy",sessionId:"a"}} throughput={null} />));
    expect(container.textContent).toBe("Session 10 tokens/s");
    expect(container.textContent).not.toContain("—");
  });
  it("hides scoped status when neither session nor turn is measurable", async () => {
    vi.mocked(ipc.throughputStatsRead).mockResolvedValue({global,session:{outputTokens:0,elapsedMs:0,completedTurns:0,excludedTurns:0},byEngine:{},startedAt:1900000000000});
    await act(async () => root.render(<ThroughputStatus scope={{engine:"agy",sessionId:"a"}} throughput={null} />));
    expect(container.querySelector("button")).toBeNull();
  });
});
