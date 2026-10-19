import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@/lib/transport";
import { useMcpInventory, type McpInventoryStore } from "@/features/mcp/useMcpInventory";
import { useInstalledSkills, type InstalledSkillsStore } from "./useInstalledSkills";
import { useSkillUsage, type SkillUsageStore } from "./useSkillUsage";
import { useSkillDiscovery, type SkillDiscoveryStore } from "./useSkillDiscovery";

const api = vi.hoisted(() => ({ inventory: vi.fn(), installed: vi.fn(), usage: vi.fn(), activity: vi.fn(), repos: vi.fn(), popular: vi.fn() }));
vi.mock("@/lib/transport", () => ({ isWeb: true, listen: vi.fn() }));
vi.mock("@/features/mcp/api", () => ({ mcpApi: api, McpHubError: class extends Error {} }));
vi.mock("./api", () => ({ skillsHubApi: api }));
vi.mock("@/components/application/ai-chat/slash-commands", () => ({ invalidateSlashCommandCatalog: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let node: HTMLDivElement, root: Root;
let mcp: McpInventoryStore, installed: InstalledSkillsStore, usage: SkillUsageStore, repos: SkillDiscoveryStore;
const callbacks = new Map<string, (event: { payload: unknown }) => void>();
let unlisteners: Array<ReturnType<typeof vi.fn>>;
const harnesses = {
  mcp: function Mcp({ active: _active }: { active: boolean }) { mcp = useMcpInventory("/host"); return null; },
  installed: function Installed({ active }: { active: boolean }) { installed = useInstalledSkills(active); return null; },
  usage: function Usage({ active }: { active: boolean }) { usage = useSkillUsage(active); return null; },
  repos: function Repos({ active }: { active: boolean }) { repos = useSkillDiscovery(active); return null; },
};
type Mode = keyof typeof harnesses;
const query = { mcp: api.inventory, installed: api.installed, usage: api.usage, repos: api.repos };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  callbacks.clear(); unlisteners = [];
  vi.mocked(listen).mockReset().mockImplementation(async (event, callback) => {
    callbacks.set(event, callback);
    const off = vi.fn(); unlisteners.push(off); return off;
  });
  api.inventory.mockImplementation(async () => ({ engines: [], collectedAt: api.inventory.mock.calls.length }));
  api.installed.mockImplementation(async () => ({ targets: [{ id: "claude", label: `generation-${api.installed.mock.calls.length}`, path: "/host/skills", readonly: false, available: true }], skills: [] }));
  api.usage.mockImplementation(async () => ({ engine: "claude", scope: "claude_code_transcripts", generatedAt: api.usage.mock.calls.length, scannedFiles: 0, totalInvocations: 0, cached: false, skills: [], unusedInstalled: [] }));
  api.activity.mockResolvedValue({ activity: [] });
  api.repos.mockImplementation(async () => ({ repos: [{ owner: "owner", name: `generation-${api.repos.mock.calls.length}`, branch: "main" }] }));
  api.popular.mockResolvedValue({ skills: [], cached: true, generatedAt: 1 });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

function generation(mode: Mode) {
  if (mode === "mcp") return mcp.inventory?.collectedAt;
  if (mode === "installed") return Number(installed.targets[0]?.label.split("-")[1]);
  if (mode === "usage") return usage.usage?.generatedAt;
  return Number(repos.repos[0]?.name.split("-")[1]);
}

describe.each(["mcp", "installed", "usage", "repos"] as const)("remote %s data synchronization", (mode) => {
  it("reloads changed and reconnected host data and cleans resolved subscriptions", async () => {
    const Harness = harnesses[mode];
    await act(async () => root.render(<Harness active />));
    expect(generation(mode)).toBe(1);
    const event = mode === "mcp" ? "mcp://changed" : "skills://changed";
    expect([...callbacks.keys()]).toEqual([event, "transport://connected"]);
    await act(async () => callbacks.get(event)!({ payload: null }));
    expect(generation(mode)).toBe(2);
    await act(async () => callbacks.get("transport://connected")!({ payload: "1.1.1" }));
    expect(generation(mode)).toBe(3);
    if (mode === "repos") expect(api.popular).toHaveBeenCalledTimes(1);
    if (mode === "usage") expect(api.activity).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
    unlisteners.forEach((off) => expect(off).toHaveBeenCalledOnce());
    callbacks.forEach((callback) => callback({ payload: null }));
    expect(query[mode]).toHaveBeenCalledTimes(3);
  });

  it("removes late subscriptions and ignores callbacks after unmount", async () => {
    const pending: Array<(off: () => void) => void> = [];
    vi.mocked(listen).mockImplementation((event, callback) => {
      callbacks.set(event, callback);
      return new Promise((resolve) => pending.push(resolve));
    });
    const Harness = harnesses[mode];
    await act(async () => root.render(<Harness active />));
    await act(async () => root.unmount());
    const late = pending.map(() => vi.fn());
    await act(async () => pending.forEach((resolve, index) => resolve(late[index])));
    late.forEach((off) => expect(off).toHaveBeenCalledOnce());
    callbacks.forEach((callback) => callback({ payload: null }));
    expect(query[mode]).toHaveBeenCalledTimes(1);
  });

  it("rejects a late initial response after a newer shared change", async () => {
    let resolve!: (payload: unknown) => void;
    query[mode].mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const Harness = harnesses[mode];
    await act(async () => root.render(<Harness active />));
    const event = mode === "mcp" ? "mcp://changed" : "skills://changed";
    await act(async () => callbacks.get(event)!({ payload: null }));
    expect(generation(mode)).toBe(2);
    const stale = { collectedAt: 99, targets: [{ id: "claude", label: "generation-99" }], skills: [], generatedAt: 99, repos: [{ name: "generation-99" }] };
    await act(async () => resolve(stale));
    expect(generation(mode)).toBe(2);
  });

  it("exposes a shared reload failure and recovers on reconnection", async () => {
    const Harness = harnesses[mode];
    await act(async () => root.render(<Harness active />));
    query[mode].mockRejectedValueOnce(new Error("host unavailable"));
    const event = mode === "mcp" ? "mcp://changed" : "skills://changed";
    await act(async () => callbacks.get(event)!({ payload: null }));
    const error = () => mode === "mcp" ? mcp.error : mode === "installed" ? installed.error : mode === "usage" ? usage.usageError : repos.discoverError;
    expect(error()).toContain("host unavailable");
    await act(async () => callbacks.get("transport://connected")!({ payload: null }));
    expect(generation(mode)).toBe(3);
    expect(error()).toBeNull();
  });
});

describe("hidden Skills pane synchronization", () => {
  it.each(["installed", "usage", "repos"] as const)("does not load or subscribe for inactive %s and detaches when hidden", async (mode) => {
    const Harness = harnesses[mode];
    await act(async () => root.render(<Harness active={false} />));
    expect(query[mode]).not.toHaveBeenCalled(); expect(listen).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness active />));
    expect(query[mode]).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Harness active={false} />));
    unlisteners.forEach((off) => expect(off).toHaveBeenCalledOnce());
    callbacks.forEach((callback) => callback({ payload: null }));
    expect(query[mode]).toHaveBeenCalledTimes(1);
  });
});
