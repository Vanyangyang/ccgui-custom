// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliHooksInventory } from "./types";

const state = vi.hoisted(() => ({ workspace: "/project" as string | null }));
vi.mock("@/features/chat/store", () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ active: { workspacePath: state.workspace, engine: "codex" } }),
}));
vi.mock("@/lib/transport", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
}) }));

import { invoke } from "@/lib/transport";
import { ENGINE_IDS } from "@/features/settings/providers";
import { CliHooksSection } from "./CliHooksSection";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const inventory = (changes: Partial<CliHooksInventory> = {}): CliHooksInventory => ({
  engine: "codex", workspace: "/project", coverage: "partial", warnings: [], entries: [], ...changes,
});

describe("CLI hooks settings", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.resetAllMocks(); state.workspace = "/project";
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it("lists every engine and distinguishes disabled plugin hooks from trust", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(inventory({ entries: [{
      id: "gate", event: "PreToolUse", matcher: "mcp__.*", handlerType: "mcp_tool", label: "gate / pre",
      source: "plugin", sourcePath: "C:/plugin/hooks/hooks.json", pluginId: "codex-reload-gate@personal",
      enabled: false, trust: null, managed: false,
    }, {
      id: "untrusted", event: "Stop", matcher: null, handlerType: "command", label: "node",
      source: "user", sourcePath: "C:/user/hooks.json", pluginId: null, enabled: true, trust: "untrusted", managed: false,
    }] }));
    await act(async () => root.render(<CliHooksSection />));
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(ENGINE_IDS.length);
    expect(invoke).toHaveBeenCalledWith("cli_hooks_inventory", { engine: "codex", workspace: "/project" });
    expect(host.textContent).toContain("codex-reload-gate@personal");
    expect(host.textContent).toContain("cliHooks.disabled");
    expect(host.textContent).toContain("untrusted");
    expect(host.textContent).toContain("mcp__.*");
  });

  it("does not present unsupported discovery as an empty hook list", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(inventory({ coverage: "unknown" }));
    await act(async () => root.render(<CliHooksSection />));
    expect(host.textContent).toContain("cliHooks.unknownCoverage");
    expect(host.textContent).not.toContain("cliHooks.empty");
  });

  it("changes a supported named hook using its scope and version, then reloads", async () => {
    const row = { id:"agy", event:"PreToolUse", matcher:null, handlerType:"command", label:"guard", source:"user", sourcePath:"C:/hooks.json",
      pluginId:null, enabled:true, trust:null, managed:false, toggle:{ scope:"user" as const, name:"guard", version:"a".repeat(64) } };
    vi.mocked(invoke).mockResolvedValueOnce(inventory()).mockResolvedValueOnce(inventory({ engine:"agy", entries:[row] }))
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(inventory({ engine:"agy", entries:[{ ...row, enabled:false }] }));
    await act(async () => root.render(<CliHooksSection />));
    await act(async () => (host.querySelector("#cli-hooks-tab-agy") as HTMLButtonElement).click());
    const button = [...host.querySelectorAll("button")].find(item => item.textContent === "cliHooks.disable");
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    expect(invoke).toHaveBeenCalledWith("cli_hooks_set_enabled", { request: {
      engine:"agy", workspace:"/project", scope:"user", name:"guard", version:"a".repeat(64), enabled:false,
    } });
    expect(host.textContent).toContain("cliHooks.disabled");
  });

  it("toggles one Codex hook without granting trust", async () => {
    const row = { id:"hook", event:"Stop", matcher:null, handlerType:"command", label:"node", source:"plugin", sourcePath:null,
      pluginId:"example@market", enabled:false, trust:"untrusted", managed:false,
      toggle:{ scope:"codex" as const, name:"b".repeat(64), version:`sha256:${"a".repeat(64)}` } };
    vi.mocked(invoke).mockResolvedValueOnce(inventory({ entries:[row] })).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(inventory({ entries:[{ ...row, enabled:true }] }));
    await act(async () => root.render(<CliHooksSection />));
    const button = [...host.querySelectorAll("button")].find(item => item.textContent === "cliHooks.enable");
    await act(async () => button!.click());
    expect(invoke).toHaveBeenCalledWith("cli_hooks_set_enabled", { request: {
      engine:"codex", workspace:"/project", scope:"codex", name:"b".repeat(64), version:`sha256:${"a".repeat(64)}`, enabled:true,
    } });
    expect(host.textContent).toContain("untrusted");
    expect(host.textContent).toContain("cliHooks.codexControl");
  });

  it("ignores an old workspace response after switching engine", async () => {
    let resolve!: (value: CliHooksInventory) => void;
    const old = new Promise<CliHooksInventory>(done => { resolve = done; });
    vi.mocked(invoke).mockReturnValueOnce(old).mockResolvedValueOnce(inventory({ engine: "claude", entries: [] }));
    await act(async () => root.render(<CliHooksSection />));
    await act(async () => (host.querySelector("#cli-hooks-tab-claude") as HTMLButtonElement).click());
    await act(async () => resolve(inventory({ entries: [{
      id:"old", event:"OldEvent", matcher:null, handlerType:"command", label:"old", source:"user", sourcePath:null,
      pluginId:null, enabled:true, trust:null, managed:false,
    }] })));
    expect(host.textContent).not.toContain("OldEvent");
    expect(invoke).toHaveBeenLastCalledWith("cli_hooks_inventory", { engine: "claude", workspace: "/project" });
  });
});
