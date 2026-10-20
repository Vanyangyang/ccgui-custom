import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, EngineCatalog } from "@/lib/ipc";

const { refreshAppSettings, updateAppSettings, listEngineModels } = vi.hoisted(() => ({
  refreshAppSettings: vi.fn(), updateAppSettings: vi.fn(), listEngineModels: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { refreshAppSettings, updateAppSettings, listEngineModels } }));
import i18n from "@/lib/i18n";
import { LeaderSection } from "./LeaderSection";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let unmounted: boolean;
let stored: AppSettings;
const makeSettings = (fields: Partial<AppSettings> = {}) => ({
  theme: "light", defaultModels: { claude: "default-claude" }, customModels: { claude: ["custom-claude"] }, ...fields,
}) as AppSettings;
const catalog = (ids: string[]): EngineCatalog => ({ authoritative: true, models: ids.map((id) => ({ id, provider: "test" })) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function render() { await act(async () => { root.render(<LeaderSection />); }); }
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
type PolicyMode = "unrestricted" | "restricted" | "disabled";
const MODE_KEYS = {
  unrestricted: "settings.leaderModeUnrestricted",
  restricted: "settings.leaderModeRestricted",
  disabled: "settings.leaderModeDisabled",
} as const;
function mode(engine: string, value: PolicyMode) {
  const group = [...container.querySelectorAll<HTMLElement>('[role="group"]')].find((element) =>
    element.getAttribute("aria-label") === i18n.t("settings.leaderPolicyForEngine", { engine: CLI_DISPLAY_NAMES[engine] }));
  const element = [...(group?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((item) => item.textContent === i18n.t(MODE_KEYS[value]));
  if (!element) throw new Error(`missing ${engine} ${value} policy button`);
  return element;
}
function expectMode(engine: string, selected: PolicyMode | "unconfigured") {
  for (const value of Object.keys(MODE_KEYS) as PolicyMode[]) {
    expect(mode(engine, value).getAttribute("aria-pressed")).toBe(String(value === selected));
  }
}
function expectModesDisabled(engine: string, disabled: boolean) {
  for (const value of Object.keys(MODE_KEYS) as PolicyMode[]) expect(mode(engine, value).disabled).toBe(disabled);
}
function choice(id: string) {
  const element = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.getAttribute("aria-label")?.endsWith(`: ${id}`));
  if (!element) throw new Error(`missing choice ${id}`);
  return element;
}
function button(label: string) {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  if (!element) throw new Error(`missing button ${label}`);
  return element;
}
const save = () => click(button(i18n.t("common.save")));
function unmount() { act(() => root.unmount()); unmounted = true; }

beforeEach(() => {
  stored = makeSettings();
  refreshAppSettings.mockReset().mockImplementation(async () => stored);
  updateAppSettings.mockReset().mockImplementation(async (settings: AppSettings) => { stored = settings; });
  listEngineModels.mockReset().mockImplementation(async (engine: string) => catalog(engine === "claude" ? ["catalog-first", "default-claude"] : engine === "agy" ? ["gemini-3.8-flash-high", "claude-opus-4-6"] : ["codex-first", "codex-second"]));
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container); unmounted = false;
});
afterEach(() => { if (!unmounted) unmount(); container.remove(); vi.useRealTimers(); });

describe("LeaderSection", () => {
  it("treats null as unrestricted without changing another engine's disabled policy", async () => {
    stored = makeSettings({ leaderAllowedModels: { claude: null, agy: [] } });
    await render();
    expectMode("claude", "unrestricted");
    expectMode("agy", "disabled");
    expect(updateAppSettings).not.toHaveBeenCalled();
    await click(mode("codex", "disabled")); await save();
    expect(stored.leaderAllowedModels).toEqual({ claude: null, agy: [], codex: [] });
  });
  it("saves and restores Cursor checkboxes without implicitly selecting defaults or catalog models", async () => {
    stored = makeSettings({ defaultModels: { cursor: "gemini-3.8-flash" } });
    listEngineModels.mockImplementation(async (engine: string) => catalog(engine === "cursor" ? ["gemini-3.8-flash", "claude-opus-5-5"] : ["other-model"]));
    await render();
    expect(listEngineModels).toHaveBeenCalledWith("cursor");
    expect(() => mode("cursor", "unrestricted")).toThrow("missing cursor");
    expect(choice("gemini-3.8-flash").checked).toBe(false);
    expect(choice("claude-opus-5-5").checked).toBe(false);
    expect(button(i18n.t("common.save")).disabled).toBe(true);
    await click(choice("claude-opus-5-5")); await save();
    expect(stored.leaderAllowedModels?.cursor).toEqual(["claude-opus-5-5"]);
    unmount(); root = createRoot(container); unmounted = false;
    await render();
    expect(choice("claude-opus-5-5").checked).toBe(true);
    expect(choice("gemini-3.8-flash").checked).toBe(false);
    await click(choice("claude-opus-5-5"));
    expect(button(i18n.t("common.save")).disabled).toBe(false);
    await save();
    expect(stored.leaderAllowedModels?.cursor).toEqual([]);
    expect(choice("claude-opus-5-5").checked).toBe(false);
  });
  it.each([undefined, null, []])("shows Cursor %j policy as empty without changing it on another engine save", async (cursor) => {
    stored = makeSettings({ leaderAllowedModels: cursor === undefined ? {} : { cursor } });
    listEngineModels.mockImplementation(async (engine: string) => catalog(engine === "cursor" ? ["cursor-model"] : []));
    await render();
    expect(choice("cursor-model").checked).toBe(false);
    expect(choice("cursor-model").disabled).toBe(false);
    expect(container.textContent).toContain(i18n.t("settings.leaderCursorModelsNote"));
    await click(mode("codex", "disabled")); await save();
    expect(stored.leaderAllowedModels?.cursor).toEqual(cursor);
  });
  it("preserves Cursor draft on save failure and merges only its changed list", async () => {
    stored = makeSettings({ leaderAllowedModels: { cursor: ["saved-cursor"], claude: ["old"] } });
    await render();
    await click(choice("saved-cursor"));
    updateAppSettings.mockRejectedValueOnce(new Error("write failed"));
    await save();
    expect(choice("saved-cursor").checked).toBe(false);
    expect(container.textContent).toContain("write failed");
    expect(container.textContent).not.toContain(i18n.t("settings.leaderSaved"));
    stored = { ...stored, theme: "dark", leaderAllowedModels: { ...stored.leaderAllowedModels, claude: ["concurrent"] } };
    await save();
    expect(stored.theme).toBe("dark");
    expect(stored.leaderAllowedModels).toEqual({ cursor: [], claude: ["concurrent"] });
  });
  it("excludes Cursor auto/default aliases from saved selections and catalog choices", async () => {
    stored = makeSettings({
      defaultModels: { cursor: "Auto" },
      leaderAllowedModels: { cursor: ["AUTO", " default ", "cursor-model"], claude: ["auto"] },
    });
    listEngineModels.mockImplementation(async (engine: string) => catalog(engine === "cursor"
      ? ["auto", "DEFAULT", "cursor-model", "cursor-new"] : []));
    await render();
    const cursorChoices = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .filter((input) => input.getAttribute("aria-label")?.startsWith(`${CLI_DISPLAY_NAMES.cursor}: `));
    expect(cursorChoices.map((input) => input.getAttribute("aria-label"))).toEqual([
      `${CLI_DISPLAY_NAMES.cursor}: cursor-model`, `${CLI_DISPLAY_NAMES.cursor}: cursor-new`,
    ]);
    expect(choice("cursor-model").checked).toBe(true);
    expect(choice("auto").checked).toBe(true); // Other engines keep their existing semantics.
    await click(choice("cursor-new")); await save();
    expect(stored.leaderAllowedModels).toEqual({ cursor: ["cursor-model", "cursor-new"], claude: ["auto"] });
  });
  it("does not select Cursor models when the catalog arrives after editing", async () => {
    stored = makeSettings({ defaultModels: { cursor: "cursor-default" } });
    const models = deferred<EngineCatalog>();
    listEngineModels.mockImplementation(async (engine: string) => engine === "cursor" ? models.promise : catalog([]));
    await render();
    expect(choice("cursor-default").checked).toBe(false);
    await click(choice("cursor-default"));
    await act(async () => models.resolve(catalog(["cursor-new"])));
    expect(choice("cursor-new").checked).toBe(false);
    expect(choice("cursor-default").checked).toBe(true);
    await save();
    expect(stored.leaderAllowedModels?.cursor).toEqual(["cursor-default"]);
  });
  it("loads and saves AGY model restrictions independently, including exact effort variants", async () => {
    await render();
    expect(listEngineModels).toHaveBeenCalledWith("agy");
    expectMode("agy", "unconfigured");
    await click(mode("agy", "restricted"));
    expect(choice("gemini-3.8-flash-high").checked).toBe(true);
    await click(choice("claude-opus-4-6"));
    await save();
    expect(stored.leaderAllowedModels).toEqual({ agy: ["gemini-3.8-flash-high", "claude-opus-4-6"] });
    expectMode("claude", "unconfigured");
    expectMode("codex", "unconfigured");
    await click(mode("agy", "disabled")); await save();
    expect(stored.leaderAllowedModels?.agy).toEqual([]);
    await click(mode("agy", "unrestricted")); await save();
    expect(stored.leaderAllowedModels).toEqual({ agy: null });
  });
  it("defaults to unconfigured without writing and selects each engine mode independently", async () => {
    await render();
    expectMode("claude", "unconfigured");
    expectMode("codex", "unconfigured");
    expect(container.textContent).toContain(i18n.t("settings.leaderModeUnconfiguredNote"));
    expect(button(i18n.t("common.save")).disabled).toBe(true);
    await save();
    expect(updateAppSettings).not.toHaveBeenCalled();
    await click(mode("claude", "restricted"));
    expectMode("claude", "restricted");
    expect(choice("default-claude").checked).toBe(true);
    expectMode("codex", "unconfigured");
    await click(mode("codex", "restricted"));
    expect(choice("codex-first").checked).toBe(true);
    await click(mode("codex", "disabled"));
    expectMode("codex", "disabled");
    expectMode("claude", "restricted");
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("retains custom, default and stale saved IDs even for an authoritative catalog", async () => {
    stored = makeSettings({ leaderAllowedModels: { claude: ["stale-selected"] } });
    await render();
    expect(choice("custom-claude").checked).toBe(false);
    expect(choice("default-claude").checked).toBe(false);
    expect(choice("stale-selected").checked).toBe(true);
    expect(container.textContent).toContain(i18n.t("settings.leaderModelFallback", { model: "stale-selected" }));
  });

  it("normalizes saved and catalog IDs before comparison while preserving invalid entries", async () => {
    stored = makeSettings({ defaultModels: { claude: " default-claude\n" }, customModels: { claude: [" custom-claude "] }, leaderAllowedModels: { claude: [" default-claude\n", "default-claude", " ", "bad\u0001id"] } });
    await render();
    expect(choice("default-claude").checked).toBe(true);
    expect(choice(" ").checked).toBe(true);
    expect(choice("bad\u0001id").checked).toBe(true);
    expect(container.textContent).toContain('" "');
    await click(choice(" ")); await click(choice("bad\u0001id")); await click(choice("custom-claude"));
    await save();
    expect(stored.leaderAllowedModels?.claude).toEqual(["default-claude", "custom-claude"]);
    expect(container.textContent).toContain(i18n.t("settings.leaderSaved"));
  });

  it("reads an empty policy as disabled and persists explicit disabled modes", async () => {
    stored = makeSettings({ leaderAllowedModels: { claude: [] } });
    await render();
    expectMode("claude", "disabled");
    expectMode("codex", "unconfigured");
    await click(mode("codex", "disabled")); await save();
    expect(stored.leaderAllowedModels).toEqual({ claude: [], codex: [] });
    expectMode("claude", "disabled");
    expectMode("codex", "disabled");
    expect(container.textContent).toContain(i18n.t("settings.leaderSaved"));
  });

  it("blocks saving restricted mode with no selected models until explicitly disabled", async () => {
    await render(); await click(mode("claude", "restricted"));
    await click(choice("default-claude"));
    expectMode("claude", "restricted");
    expect(container.textContent).toContain(i18n.t("settings.leaderEmptyPolicy"));
    expect(button(i18n.t("common.save")).disabled).toBe(true);
    await save();
    expect(updateAppSettings).not.toHaveBeenCalled();
    await click(mode("claude", "disabled"));
    expect(button(i18n.t("common.save")).disabled).toBe(false);
    await save();
    expect(stored.leaderAllowedModels).toEqual({ claude: [] });
  });

  it("retains selected model order across unrestricted and disabled draft round trips", async () => {
    stored = makeSettings({ leaderAllowedModels: { claude: ["custom-claude", "catalog-first"] } });
    await render();
    await click(mode("claude", "unrestricted"));
    expectMode("claude", "unrestricted");
    await click(mode("claude", "restricted"));
    expect(choice("custom-claude").checked).toBe(true);
    expect(choice("catalog-first").checked).toBe(true);
    expect(choice("default-claude").checked).toBe(false);
    await click(mode("claude", "disabled"));
    await click(mode("claude", "restricted"));
    expect(choice("custom-claude").checked).toBe(true);
    expect(choice("catalog-first").checked).toBe(true);
    await click(choice("default-claude")); await save();
    expect(stored.leaderAllowedModels?.claude).toEqual(["custom-claude", "catalog-first", "default-claude"]);
  });

  it("allows explicit disabled mode during pending catalog reads and ignores late catalogs for the mode", async () => {
    const models = deferred<EngineCatalog>();
    listEngineModels.mockReturnValue(models.promise);
    await render();
    expectModesDisabled("claude", false);
    expectModesDisabled("codex", false);
    await click(mode("codex", "disabled"));
    expect(button(i18n.t("common.save")).disabled).toBe(false);
    await save();
    expect(stored.leaderAllowedModels).toEqual({ codex: [] });
    await act(async () => models.resolve(catalog(["late-model"])));
    expectMode("codex", "disabled");
    expectMode("claude", "unconfigured");
    expect(button(i18n.t("common.save")).disabled).toBe(true);
  });

  it("keeps an empty restricted draft when the catalog arrives later", async () => {
    stored = makeSettings({ defaultModels: {}, customModels: {} });
    const models = deferred<EngineCatalog>();
    listEngineModels.mockReturnValue(models.promise);
    await render(); await click(mode("codex", "restricted"));
    expectMode("codex", "restricted");
    expect(button(i18n.t("common.save")).disabled).toBe(true);
    await act(async () => models.resolve(catalog(["late-model"])));
    expectMode("codex", "restricted");
    expect(choice("late-model").checked).toBe(false);
    expect(button(i18n.t("common.save")).disabled).toBe(true);
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("can save disabled mode when the catalog fails without pretending the catalog succeeded", async () => {
    listEngineModels.mockRejectedValue(new Error("catalog unavailable"));
    await render(); await click(mode("codex", "disabled")); await save();
    expect(stored.leaderAllowedModels).toEqual({ codex: [] });
    expectMode("codex", "disabled");
    expect(container.textContent).toContain("catalog unavailable");
    expect(container.textContent).toContain(i18n.t("settings.leaderSaved"));
  });

  it("matches native Unicode whitespace without rewriting a valid BOM-prefixed ID", async () => {
    stored = makeSettings({ defaultModels: { claude: "sonnet\u0085" }, leaderAllowedModels: { claude: ["\uFEFFsonnet", "sonnet\u0085"] } });
    await render();
    expect(choice("\uFEFFsonnet").checked).toBe(true);
    expect(choice("sonnet").checked).toBe(true);
    expect(container.textContent).toContain(i18n.t("settings.leaderModelFallback", { model: "sonnet" }));
    await click(choice("custom-claude"));
    await save();
    expect(stored.leaderAllowedModels?.claude).toEqual(["\uFEFFsonnet", "sonnet", "custom-claude"]);
    expect(container.textContent).toContain(i18n.t("settings.leaderSaved"));
  });

  it("uses selected order for fallback and app default takes priority when selected", async () => {
    stored = makeSettings({ leaderAllowedModels: { claude: ["custom-claude", "catalog-first"] } });
    await render();
    expect(container.textContent).toContain(i18n.t("settings.leaderModelFallback", { model: "custom-claude" }));
    await click(choice("default-claude"));
    expect(container.textContent).toContain(i18n.t("settings.leaderModelFallback", { model: "default-claude" }));
    await click(choice("default-claude")); await click(choice("catalog-first")); await click(choice("catalog-first")); await save();
    expect(stored.leaderAllowedModels?.claude).toEqual(["custom-claude", "catalog-first"]);
  });

  it("merges fresh settings and preserves concurrently changed untouched engine policy", async () => {
    await render(); await click(mode("claude", "restricted"));
    stored = makeSettings({ theme: "dark", defaultEfforts: { codex: "high" }, leaderAllowedModels: { codex: ["concurrent"] } });
    await save();
    expect(updateAppSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark", defaultEfforts: { codex: "high" }, leaderAllowedModels: { claude: ["default-claude"], codex: ["concurrent"] } }));
    expect(refreshAppSettings).toHaveBeenCalledTimes(3);
    expect(choice("concurrent").checked).toBe(true);
    expect(container.textContent).toContain(i18n.t("settings.leaderSaved"));
  });

  it("saves explicit null for unrestricted and leaves untouched unconfigured engines absent", async () => {
    stored = makeSettings({ leaderAllowedModels: { claude: ["default-claude"], codex: [] } });
    await render(); await click(mode("claude", "unrestricted")); await save();
    expect(stored.leaderAllowedModels).toEqual({ claude: null, codex: [] });
    expectMode("claude", "unrestricted");
    expectMode("agy", "unconfigured");
    expect(() => mode("cursor", "unrestricted")).toThrow("missing cursor");
  });

  it("keeps configured choices on catalog error and recovers with retry", async () => {
    stored = makeSettings({ leaderAllowedModels: { claude: ["missing-from-cli"] } });
    listEngineModels.mockImplementation(async (engine: string) => { if (engine === "claude") throw new Error("channel offline"); return catalog([]); });
    await render();
    expect(container.textContent).toContain(i18n.t("settings.leaderCatalogError", { error: "channel offline" }));
    expect(choice("missing-from-cli").checked).toBe(true);
    const next = deferred<EngineCatalog>();
    listEngineModels.mockReturnValue(next.promise);
    await click(button(i18n.t("settings.leaderRetry")));
    expectModesDisabled("claude", false);
    await act(async () => next.resolve(catalog(["recovered"])));
    expect(choice("recovered").checked).toBe(false);
    expect(choice("missing-from-cli").checked).toBe(true);
    expect(container.textContent).not.toContain("channel offline");
  });

  it.each(["read", "write", "confirm"])("retains draft and shows no success on %s failure", async (stage) => {
    await render(); await click(mode("claude", "restricted"));
    if (stage === "read") refreshAppSettings.mockRejectedValueOnce(new Error("read failed"));
    if (stage === "write") updateAppSettings.mockRejectedValueOnce(new Error("write failed"));
    if (stage === "confirm") refreshAppSettings.mockResolvedValueOnce(stored).mockRejectedValueOnce(new Error("confirm failed"));
    await save();
    expect(choice("default-claude").checked).toBe(true);
    expect(container.textContent).toContain(`${stage} failed`);
    expect(container.textContent).not.toContain(i18n.t("settings.leaderSaved"));
    expect(button(i18n.t("common.save")).disabled).toBe(false);
    await save();
    expect(container.textContent).toContain(i18n.t("settings.leaderSaved"));
  });

  it("does not claim success when backend readback did not retain the policy", async () => {
    updateAppSettings.mockResolvedValue(undefined);
    await render(); await click(mode("claude", "restricted")); await save();
    expect(container.textContent).toContain(i18n.t("settings.leaderSaveMismatch"));
    expect(choice("default-claude").checked).toBe(true);
    expect(container.textContent).not.toContain(i18n.t("settings.leaderSaved"));
  });

  it("disables edits during save and waits for confirmed values", async () => {
    await render(); await click(mode("claude", "restricted"));
    const write = deferred<void>();
    updateAppSettings.mockImplementation((value: AppSettings) => { stored = value; return write.promise; });
    await save();
    expectModesDisabled("claude", true);
    expectModesDisabled("codex", true);
    expect(choice("default-claude").disabled).toBe(true);
    expect(button(i18n.t("settings.leaderSaving")).disabled).toBe(true);
    expect(container.textContent).not.toContain(i18n.t("settings.leaderSaved"));
    await act(async () => write.resolve());
    expect(container.textContent).toContain(i18n.t("settings.leaderSaved"));
  });

  it("recovers failed initial settings read without allowing accidental writes", async () => {
    refreshAppSettings.mockRejectedValueOnce(new Error("settings unavailable"));
    await render();
    expectModesDisabled("claude", true);
    expectModesDisabled("codex", true);
    expect(button(i18n.t("common.save")).disabled).toBe(true);
    await click(button(i18n.t("settings.leaderRetry")));
    expectModesDisabled("claude", false);
    expectModesDisabled("codex", false);
    expect(container.textContent).not.toContain("settings unavailable");
  });

  it("ignores settings and catalog completions after unmount", async () => {
    const read = deferred<AppSettings>(); const models = deferred<EngineCatalog>();
    refreshAppSettings.mockReturnValue(read.promise); listEngineModels.mockReturnValue(models.promise);
    await render(); unmount();
    await act(async () => { read.resolve(stored); models.reject(new Error("late catalog")); });
    expect(updateAppSettings).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("does not accept stale initial reads when StrictMode restarts effects", async () => {
    const oldRead = deferred<AppSettings>(); const oldCatalog = deferred<EngineCatalog>();
    refreshAppSettings.mockReturnValueOnce(oldRead.promise).mockResolvedValue(stored);
    listEngineModels.mockImplementationOnce(() => oldCatalog.promise);
    await act(async () => root.render(<StrictMode><LeaderSection /></StrictMode>));
    await click(mode("claude", "restricted"));
    await act(async () => {
      oldRead.resolve(makeSettings({ leaderAllowedModels: { claude: ["old-policy"] } }));
      oldCatalog.resolve(catalog(["old-catalog"]));
    });
    expect(choice("default-claude").checked).toBe(true);
    expect(container.textContent).not.toContain("old-policy");
    expect(container.textContent).not.toContain("old-catalog");
  });

  it("shows spinning retry feedback and no success check on catalog retry failure", async () => {
    listEngineModels.mockRejectedValue(new Error("offline"));
    await render();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const retryButton = button(i18n.t("settings.leaderRetry"));
    await click(retryButton);
    expect(retryButton.disabled).toBe(true);
    expect(retryButton.querySelector(".animate-refresh-spin")).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(retryButton.disabled).toBe(false);
    expect(retryButton.querySelector(".animate-refresh-spin")).toBeNull();
    expect(retryButton.querySelector(".text-notification-success-foreground")?.classList.contains("opacity-0")).toBe(true);
    expect(container.textContent).toContain("offline");
  });

  it("does not write after leaving the page during the fresh save read", async () => {
    await render(); await click(mode("claude", "restricted"));
    const read = deferred<AppSettings>(); refreshAppSettings.mockReturnValueOnce(read.promise);
    await save(); unmount();
    await act(async () => read.resolve(stored));
    expect(updateAppSettings).not.toHaveBeenCalled();
  });
});
