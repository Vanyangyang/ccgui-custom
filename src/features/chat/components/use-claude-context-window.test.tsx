import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type OfficialConfigFile } from "@/lib/ipc";
import { useClaudeContextWindow } from "./use-claude-context-window";

vi.mock("@/lib/ipc", () => ({ ipc: { officialConfigRead: vi.fn(), officialConfigWrite: vi.fn() } }));
vi.mock("@/lib/events", () => ({ listenSettingsChanged: vi.fn(async () => () => {}) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function files(window: number): OfficialConfigFile[] {
  return [{ path: "/home/test/.claude/settings.json", format: "json", exists: true, content: JSON.stringify({ autoCompactWindow: window }) }];
}

let controls: ReturnType<typeof useClaudeContextWindow>;
function Probe({ engine }: { engine: string }) {
  const result = useClaudeContextWindow(engine);
  controls = result;
  return <span>{result.window ?? "model"}</span>;
}

describe("Claude context setting refresh", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.officialConfigRead).mockResolvedValue(files(750_000));
    vi.mocked(ipc.officialConfigWrite).mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render(engine: string) {
    await act(async () => root.render(<Probe engine={engine} />));
  }

  it("reloads an externally changed setting on focus", async () => {
    await render("claude");
    expect(container.textContent).toBe("750000");
    vi.mocked(ipc.officialConfigRead).mockResolvedValue(files(500_000));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(container.textContent).toBe("500000");
  });

  it("does not read Claude settings for other engines", async () => {
    await render("codex");
    expect(ipc.officialConfigRead).not.toHaveBeenCalled();
    expect(container.textContent).toBe("model");
  });

  it("ignores a late Claude read after switching engines", async () => {
    let complete!: (value: OfficialConfigFile[]) => void;
    vi.mocked(ipc.officialConfigRead).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    await render("claude");
    await render("codex");
    await act(async () => complete(files(750_000)));
    expect(container.textContent).toBe("model");
  });

  it("re-reads before saving, preserves a newer unrelated setting and updates the gauge", async () => {
    let current = files(750_000);
    vi.mocked(ipc.officialConfigRead).mockImplementation(async () => current);
    vi.mocked(ipc.officialConfigWrite).mockImplementation(async (_engine, drafts) => {
      current = [{ ...current[0], content: drafts[0].content }];
    });
    await render("claude");
    current[0].content = JSON.stringify({ autoCompactWindow: 750_000, effortLevel: "xhigh" });
    await act(async () => controls.save(600_000));
    expect(JSON.parse(current[0].content)).toEqual({ autoCompactWindow: 600_000, effortLevel: "xhigh" });
    expect(container.textContent).toBe("600000");
    await act(async () => controls.save(undefined));
    expect(JSON.parse(current[0].content)).toEqual({ effortLevel: "xhigh" });
    expect(container.textContent).toBe("model");
  });
});
