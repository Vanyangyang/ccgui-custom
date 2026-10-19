import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type CodexContextWindowSettings } from "@/lib/ipc";
import { useCodexContextWindow } from "./use-codex-context-window";

vi.mock("@/lib/ipc", () => ({ ipc: { codexContextWindowRead: vi.fn(), codexContextWindowWrite: vi.fn() } }));
vi.mock("@/lib/events", () => ({ listenSettingsChanged: vi.fn(async () => () => {}) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const settings = (contextWindow = 500_000): CodexContextWindowSettings => ({ contextWindow, autoCompactTokenLimit: null, block: null });
let controls: ReturnType<typeof useCodexContextWindow>;
function Probe({ engine, provider, workspace }: { engine: string; provider?: string; workspace?: string }) {
  controls = useCodexContextWindow(engine, provider, workspace);
  return <span>{controls.settings.contextWindow ?? "default"}</span>;
}
describe("Codex context configuration scope", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.codexContextWindowRead).mockResolvedValue(settings());
    vi.mocked(ipc.codexContextWindowWrite).mockResolvedValue(settings());
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = (engine = "codex", provider = "native", workspace = "C:/fixture") => act(async () => root.render(<Probe engine={engine} provider={provider} workspace={workspace} />));
  it("only reads Codex and refreshes on focus", async () => {
    await render("claude"); expect(ipc.codexContextWindowRead).not.toHaveBeenCalled();
    await render(); expect(container.textContent).toBe("500000");
    vi.mocked(ipc.codexContextWindowRead).mockResolvedValue(settings(600_000));
    await act(async () => window.dispatchEvent(new Event("focus"))); expect(container.textContent).toBe("600000");
  });
  it("discards a late result from the previous provider and workspace", async () => {
    let complete!: (value: CodexContextWindowSettings) => void;
    vi.mocked(ipc.codexContextWindowRead).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await render(); await render("codex", "other", "C:/other");
    await act(async () => complete(settings(900_000))); expect(container.textContent).toBe("500000");
  });
  it("sends only route and numeric values, then rereads saved settings", async () => {
    await render(); vi.mocked(ipc.codexContextWindowRead).mockResolvedValue(settings(700_000));
    await act(async () => controls.save(700_000, null));
    expect(ipc.codexContextWindowWrite).toHaveBeenCalledWith({ providerId: "native", workspacePath: "C:/fixture", contextWindow: 700_000, autoCompactTokenLimit: null });
    expect(container.textContent).toBe("700000");
  });
  it("rejects failed saves without optimistic changes", async () => {
    await render(); vi.mocked(ipc.codexContextWindowWrite).mockRejectedValueOnce(new Error("config_changed"));
    await act(async () => { await expect(controls.save(700_000, null)).rejects.toThrow("config_changed"); });
    expect(container.textContent).toBe("500000");
  });
  it("does not report a late save as success in another route", async () => {
    let complete!: (value: CodexContextWindowSettings) => void;
    vi.mocked(ipc.codexContextWindowWrite).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await render(); const pending = controls.save(700_000, null); const rejected = expect(pending).rejects.toThrow("scope_changed");
    await render("codex", "other"); await act(async () => { complete(settings(700_000)); await rejected; });
    expect(container.textContent).toBe("500000");
  });
});
