// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliPluginEntry, CliPluginsInventory } from "./types";
import { en } from "@/i18n/en";
import { zh } from "@/i18n/zh";

const state = vi.hoisted(() => ({ workspace: "/first" as string | null, language: "en" }));
vi.mock("@/features/chat/store", () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ active: { workspacePath: state.workspace } }),
}));
vi.mock("@/lib/transport", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string, params?: Record<string, unknown>) => key === "cliPlugins.message.dynamicMcp"
    ? "Translated dynamic MCP notice" : key === "cliPlugins.agyDisabledByOrg"
      ? (state.language === "zh" ? zh : en).cliPlugins.agyDisabledByOrg
      : typeof params?.defaultValue === "string" ? params.defaultValue : params ? `${key} ${Object.values(params).join(" ")}` : key,
}) }));
vi.mock("@/components/dialogs", () => ({ ConfirmDialog: ({ message, onConfirm, onCancel }: {
  message: string; onConfirm: () => void; onCancel: () => void;
}) => <div role="dialog">{message}<button onClick={onConfirm}>confirm</button><button onClick={onCancel}>cancel</button></div> }));

import { invoke } from "@/lib/transport";
import { ENGINE_IDS } from "@/features/settings/providers";
import { CliPluginsSection } from "./CliPluginsSection";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const plugin = (changes: Partial<CliPluginEntry> = {}): CliPluginEntry => ({
  id: "same-id", name: "Example", version: "1.2.3", scope: "user", enabled: true,
  projectPath: null, mcpServers: ["declared-server"], canToggle: true, canUpdate: false, canUninstall: true,
  ...changes,
});
const inventory = (changes: Partial<CliPluginsInventory> = {}): CliPluginsInventory => ({
  engine: "claude", available: true, support: "managed", message: null, entries: [], installScopes: [], ...changes,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("CLI native plugin settings", () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async () => { await act(async () => root.render(<CliPluginsSection />)); };
  const click = async (label: string, within: ParentNode = host) => {
    const button = [...within.querySelectorAll("button")].find((item) => item.textContent === label);
    expect(button, label).toBeTruthy();
    await act(async () => button!.click());
  };
  const select = async (engine: string) => {
    await act(async () => (host.querySelector(`#cli-plugins-tab-${engine}`) as HTMLButtonElement).click());
  };
  beforeEach(() => {
    vi.resetAllMocks();
    state.workspace = "/first";
    state.language = "en";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it("offers every engine and distinguishes empty, unavailable, unsupported and unknown", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(inventory({ engine: "kimi", available: false, support: "unknown", message: "CLI missing" }))
      .mockResolvedValueOnce(inventory({ engine: "grok", support: "unsupported", message: "No plugin protocol" }))
      .mockResolvedValueOnce(inventory({ engine: "codex", support: "unknown" }));
    await render();
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(ENGINE_IDS.length);
    expect(host.textContent).toContain("cliPlugins.empty");
    await select("kimi");
    expect(host.textContent).toContain("cliPlugins.unavailable");
    expect(host.textContent).toContain("CLI missing");
    expect(host.textContent).not.toContain("cliPlugins.empty");
    await select("grok");
    expect(host.textContent).toContain("No plugin protocol");
    await select("codex");
    expect(host.textContent).toContain("cliPlugins.support.unknown");
    expect(host.textContent).not.toContain("cliPlugins.support.unsupported");
    expect(host.textContent).not.toContain("cliPlugins.empty");
  });

  it("shows MCP names and addresses toggles by scope plus ID, then rereads", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(inventory({ entries: [plugin(), plugin({ scope: "project", enabled: false })] }))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(inventory({ entries: [plugin(), plugin({ scope: "project", enabled: true })] }))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(inventory({ entries: [plugin({ enabled: false })] }));
    await render();
    expect(host.textContent).toContain("declared-server");
    expect(host.textContent).toContain("1.2.3");
    expect(host.textContent).not.toContain("cliPlugins.update");
    await click("cliPlugins.enable", host.querySelectorAll("li")[1]);
    expect(invoke).toHaveBeenNthCalledWith(2, "cli_plugins_action", { request: {
      engine: "claude", workspace: "/first", action: "enable", pluginId: "same-id", scope: "project",
    } });
    expect(invoke).toHaveBeenNthCalledWith(3, "cli_plugins_inventory", { engine: "claude", workspace: "/first" });
    await click("cliPlugins.disable", host.querySelectorAll("li")[0]);
    expect(invoke).toHaveBeenNthCalledWith(4, "cli_plugins_action", { request: {
      engine: "claude", workspace: "/first", action: "disable", pluginId: "same-id", scope: "user",
    } });
  });

  it("offers explicit actions without guessing an unknown plugin state", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(inventory({ entries: [plugin({ enabled: null, mcpServers: [], mcpServersKnown: false })] }))
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(inventory());
    await render();
    expect(host.textContent).toContain("cliPlugins.unknown");
    expect(host.textContent).not.toContain("cliPlugins.noMcpServers");
    await click("cliPlugins.enable");
    expect(invoke).toHaveBeenNthCalledWith(2, "cli_plugins_action", { request: {
      engine: "claude", workspace: "/first", action: "enable", pluginId: "same-id", scope: "user",
    } });
  });

  it("uses an opaque record key for a redacted plugin source", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(inventory({ entries: [plugin({ id: "https://***@example.test/pkg", recordKey: "pi:opaque" })] }))
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(inventory());
    await render();
    await click("cliPlugins.uninstall");
    await click("confirm");
    expect(invoke).toHaveBeenNthCalledWith(2, "cli_plugins_action", { request: {
      engine: "claude", workspace: "/first", action: "uninstall", pluginId: "pi:opaque", scope: "user",
    } });
  });

  it("ignores late inventory after changing engine or workspace", async () => {
    const first = deferred<CliPluginsInventory>();
    const second = deferred<CliPluginsInventory>();
    vi.mocked(invoke).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(inventory({ engine: "codex", message: "current workspace" }));
    await render();
    expect(host.textContent).toContain("cliPlugins.loading");
    await select("codex");
    state.workspace = "/second";
    await render();
    await act(async () => {
      second.resolve(inventory({ message: "stale workspace" }));
      first.resolve(inventory({ message: "stale engine" }));
    });
    expect(host.textContent).toContain("current workspace");
    expect(host.textContent).not.toContain("stale");
  });

  it("does not reread or report success for an old action after navigation", async () => {
    const action = deferred<void>();
    vi.mocked(invoke).mockResolvedValueOnce(inventory({ entries: [plugin()] }))
      .mockReturnValueOnce(action.promise).mockResolvedValueOnce(inventory({ engine: "kimi" }));
    await render();
    await click("cliPlugins.disable");
    expect(host.textContent).toContain("cliPlugins.operating");
    await select("kimi");
    await act(async () => action.resolve());
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(host.textContent).not.toContain("cliPlugins.success");
  });

  it("confirms uninstall and exposes rejection without false success", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(inventory({ entries: [plugin()] })).mockRejectedValueOnce(new Error("permission denied"));
    await render();
    await click("cliPlugins.uninstall");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("same-id user");
    await click("confirm");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("permission denied");
    expect(host.textContent).not.toContain("cliPlugins.success");
    expect(host.querySelectorAll("li")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reports a failed reread instead of claiming a completed refresh", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(inventory({ entries: [plugin()] }))
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("read failed"));
    await render();
    await click("cliPlugins.disable");
    expect(host.textContent).toContain("read failed");
    expect(host.textContent).not.toContain("cliPlugins.success");
    expect(host.querySelectorAll("li")).toHaveLength(1);
    expect([...host.querySelectorAll("button")].find((item) => item.textContent === "cliPlugins.disable")?.disabled).toBe(true);
  });

  it.each([
    ["en", "enable"], ["zh", "enable"], ["en", "install"], ["zh", "install"],
  ])("localizes AGY organization-policy %s %s errors", async (language, action) => {
    state.language = language;
    vi.mocked(invoke).mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(inventory({ engine: "agy", entries: [plugin({ enabled: false })], installScopes: ["user"] }))
      .mockRejectedValueOnce(action === "install" ? new Error("agy_plugins_disabled_by_org") : "agy_plugins_disabled_by_org");
    await render();
    await select("agy");
    if (action === "install") {
      await act(async () => {
        const input = host.querySelector("input")!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "same-id");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await click(`cliPlugins.${action}`);
    expect(invoke).toHaveBeenLastCalledWith("cli_plugins_action", { request: {
      engine: "agy", workspace: "/first", action, pluginId: "same-id", scope: "user",
    } });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(language === "zh"
      ? "组织策略已禁用 Antigravity 插件，安装和启用不可用。请联系管理员。"
      : "Your organization has disabled Antigravity plugins. Installation and enabling are unavailable. Contact your administrator.");
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain("agy_plugins_disabled_by_org");
    expect(host.textContent).not.toContain("cliPlugins.success");
  });

  it("translates backend notices and exposes only backend allowed installation scopes", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(inventory({
      message: "cliPlugins.message.dynamicMcp", installScopes: ["user", "project"],
    })).mockResolvedValueOnce(undefined).mockResolvedValueOnce(inventory());
    await render();
    expect(host.textContent).toContain("Translated dynamic MCP notice");
    expect(host.textContent).toContain("cliPlugins.mcpDeclarationOnly");
    expect([...host.querySelectorAll("option")].map((option) => option.value)).toEqual(["user", "project"]);
    await act(async () => {
      const input = host.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  new-plugin  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const select = host.querySelector("select")!;
      select.value = "project";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("cliPlugins.install");
    expect(invoke).toHaveBeenNthCalledWith(2, "cli_plugins_action", { request: {
      engine: "claude", workspace: "/first", action: "install", pluginId: "new-plugin", scope: "project",
    } });
    expect(host.textContent).toContain("cliPlugins.success");
  });
});
