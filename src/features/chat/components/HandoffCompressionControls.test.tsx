import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { CLI_CONFIG_CHANGED_EVENT, PSEUDO_LOCAL } from "@/features/settings/providers";
import { publishedCursorCatalog, publishCursorCatalog } from "@/components/application/ai-chat/cursor-models";
import { HandoffCompressionControls } from "./HandoffCompressionControls";

const mocks = vi.hoisted(() => ({ listEngines: vi.fn(), getCliConfig: vi.fn(), getAppSettings: vi.fn(),
  listEngineModels: vi.fn(), cursorModelCatalog: vi.fn(), setCompressionMode: vi.fn(), setCompressionSelection: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("../session-cleanup", () => ({ useHandoffStore: (select: (state: typeof mocks) => unknown) => select(mocks) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const engines = ["claude", "codex", "pi", "cursor", "omp"].map(id => ({ id, enabled: true, available: true }));
function deferredEngines() {
  let resolve!: (value: typeof engines) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<typeof engines>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const catalogs: Record<string, { id: string; name?: string; provider?: string }[]> = {
  claude: [{ id: "claude-default", name: "Claude default" }],
  codex: [{ id: "gpt-6-astra", name: "GPT 6 Astra" }],
  pi: [{ id: "openai/gpt-6-astra", name: "Pi Astra", provider: "openai" }, { id: "anthropic/claude-opus-5.5", name: "Pi Opus", provider: "anthropic" }],
  cursor: [{ id: "saved-model", name: "Saved model" }, { id: "opus-high", name: "Opus High" }],
};

describe("handoff compression unified picker", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalLanguage = i18n.language;
  const defaults = { workspacePath: "/workspace", mode: "local" as const, compressionModel: "saved-model", sending: false };
  async function render(props: Partial<Parameters<typeof HandoffCompressionControls>[0]> = {}) {
    await act(async () => root.render(<HandoffCompressionControls {...defaults} {...props} />));
  }
  async function press(element: Element) {
    expect(element).toBeTruthy();
    await act(async () => (element as HTMLElement).click());
  }
  async function expectFailedRefresh(button: HTMLButtonElement) {
    // Observe the post-spin state: checking immediately would also pass while running.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
    expect(button.disabled).toBe(false);
    expect(button.querySelector(".lucide-check")?.classList.contains("opacity-0")).toBe(true);
    expect(button.querySelector(".animate-refresh-spin")).toBeNull();
  }
  const toggle = () => container.querySelector<HTMLInputElement>('input[role="switch"]')!;
  const picker = () => container.querySelector<HTMLButtonElement>('[role="group"] button')!;
  const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent?.trim() === label)!;
  const model = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(button => button.textContent?.trim() === label)!;
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }));
    mocks.listEngines.mockResolvedValue(engines);
    mocks.getCliConfig.mockResolvedValue({ claude: { current: PSEUDO_LOCAL, providers: {
      "custom/relay": { name: "Claude custom relay", model: "vendor/opus:5.5+custom" },
      backup: { name: "Backup relay", model: "backup/sonnet" },
    } } });
    mocks.getAppSettings.mockResolvedValue({ customModels: {}, customModelLabels: {} });
    mocks.listEngineModels.mockImplementation(async (engine: string) => ({ authoritative: true, models: catalogs[engine] ?? [] }));
    mocks.cursorModelCatalog.mockResolvedValue([]);
    await i18n.changeLanguage("en");
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
    await i18n.changeLanguage(originalLanguage);
  });

  it("loads supported engines without committing and selects raw provider/model IDs before enabling", async () => {
    await render();
    expect(toggle().checked).toBe(false);
    expect(mocks.listEngineModels.mock.calls.map(call => call[0]).sort()).toEqual(["claude", "codex", "cursor", "pi"]);
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
    await press(picker());
    await press(row("PI CLI"));
    await press(model("Pi Opus"));
    expect(mocks.setCompressionSelection).toHaveBeenCalledWith("/workspace", {
      engine: "pi", model: "anthropic/claude-opus-5.5", providerId: PSEUDO_LOCAL, effort: "medium",
    });
    expect(mocks.setCompressionMode).not.toHaveBeenCalled();
  });

  it("selects Claude custom channels and preserves their full model and provider IDs", async () => {
    await render();
    await press(picker());
    await press(row("Claude Code"));
    await press(document.querySelector('[data-engine-flyout] button[aria-expanded]')!);
    await press(model("Claude custom relay"));
    expect(mocks.setCompressionSelection).toHaveBeenLastCalledWith("/workspace", {
      engine: "claude", model: "vendor/opus:5.5+custom", providerId: "custom/relay", effort: "medium",
    });
    expect(document.body.textContent).not.toContain(i18n.t("chat.ultracodeDescription"));
    expect(document.body.textContent).not.toContain("Fast");
    await press([...document.querySelectorAll<HTMLButtonElement>('[data-engine-flyout] button')].find(button => button.textContent === i18n.t("chat.effortHigh"))!);
    expect(mocks.setCompressionSelection).toHaveBeenLastCalledWith("/workspace", {
      engine: "claude", model: "vendor/opus:5.5+custom", providerId: "custom/relay", effort: "high",
    });
  });

  it("switches on/off and preserves the detailed digest choice while off", async () => {
    await render({ mode: "detailed" });
    expect(container.querySelector('[data-testid="handoff-mode-detailed"]')?.getAttribute("aria-pressed")).toBe("true");
    await press(toggle());
    expect(mocks.setCompressionMode).toHaveBeenLastCalledWith("/workspace", "grok");
    await render({ mode: "grok" });
    await press(toggle());
    expect(mocks.setCompressionMode).toHaveBeenLastCalledWith("/workspace", "local");
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
  });

  it.each([
    { engine: "cursor" as const, model: "missing-model", providerId: PSEUDO_LOCAL },
    { engine: "claude" as const, model: "claude-default", providerId: "missing/relay", effort: "high" },
  ])("retains unavailable selection $model / $providerId and permits disabling compression", async (compressionSelection) => {
    await render({ compressionSelection });
    expect(container.textContent).toContain(i18n.t("chat.handoffModelUnavailable"));
    expect(toggle().disabled).toBe(true);
    if (compressionSelection.providerId !== PSEUDO_LOCAL) expect(container.textContent).toContain(compressionSelection.providerId);
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
    await render({ compressionSelection, mode: "grok" });
    expect(toggle().disabled).toBe(false);
    await press(toggle());
    expect(mocks.setCompressionMode).toHaveBeenCalledWith("/workspace", "local");
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
  });

  it.each(["catalog", "engines"])("reports %s failure without changing the selection", async (failure) => {
    if (failure === "catalog") mocks.listEngineModels.mockRejectedValue(new Error("offline"));
    else mocks.listEngines.mockRejectedValue(new Error("offline"));
    await render();
    expect(container.textContent).toContain("saved-model");
    expect(container.textContent).toContain(i18n.t("chat.handoffModelsFailed"));
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
    expect(mocks.setCompressionMode).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("ignores an older initial discovery %s after a configuration reload succeeds", async outcome => {
    const older = deferredEngines();
    mocks.listEngines.mockReturnValueOnce(older.promise);
    await render();
    await act(async () => window.dispatchEvent(new Event(CLI_CONFIG_CHANGED_EVENT)));
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => {
      if (outcome === "success") older.resolve([]);
      else older.reject(new Error("outdated failure"));
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(toggle().disabled).toBe(false);
    await press(picker());
    expect(model("Saved model")).toBeTruthy();
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
    expect(mocks.setCompressionMode).not.toHaveBeenCalled();
  });

  it("keeps the newer discovery failure when an older manual refresh succeeds", async () => {
    await render();
    await press(picker());
    const older = deferredEngines();
    mocks.listEngines.mockReturnValueOnce(older.promise).mockRejectedValueOnce(new Error("newest failure"));
    const refresh = document.querySelector<HTMLButtonElement>(`[data-engine-flyout] button[aria-label="${i18n.t("common.refresh")}"]`)!;
    await press(refresh);
    await act(async () => window.dispatchEvent(new Event(CLI_CONFIG_CHANGED_EVENT)));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(i18n.t("chat.handoffModelsFailed"));
    const configReads = mocks.getCliConfig.mock.calls.length;
    await act(async () => older.resolve([]));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(i18n.t("chat.handoffModelsFailed"));
    expect(model("Saved model")).toBeTruthy();
    expect(mocks.getCliConfig).toHaveBeenCalledTimes(configReads);
  });

  it("does not continue a pending manual refresh or listen for configuration changes after unmount", async () => {
    await render();
    await press(picker());
    const pending = deferredEngines();
    mocks.listEngines.mockReturnValueOnce(pending.promise);
    await press(document.querySelector<HTMLButtonElement>(`[data-engine-flyout] button[aria-label="${i18n.t("common.refresh")}"]`)!);
    await act(async () => root.render(null));
    const configReads = mocks.getCliConfig.mock.calls.length;
    const engineReads = mocks.listEngines.mock.calls.length;
    await act(async () => {
      pending.resolve(engines);
      window.dispatchEvent(new Event(CLI_CONFIG_CHANGED_EVENT));
    });
    expect(mocks.getCliConfig).toHaveBeenCalledTimes(configReads);
    expect(mocks.listEngines).toHaveBeenCalledTimes(engineReads);
  });

  it("recovers initial engine discovery failure from the adjacent refresh without committing", async () => {
    mocks.listEngines.mockRejectedValueOnce(new Error("offline"));
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(i18n.t("chat.handoffModelsFailed"));
    const retry = container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("common.refresh")}"]`)!;
    expect(retry).toBeTruthy();
    await press(retry);
    expect(mocks.listEngines).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await press(picker());
    expect(model("Saved model")).toBeTruthy();
    expect(model("Opus High")).toBeTruthy();
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
    expect(mocks.setCompressionMode).not.toHaveBeenCalled();
  });

  it("keeps the retry action and saved selection when engine discovery retry also fails", async () => {
    mocks.listEngines.mockRejectedValue(new Error("still offline"));
    await render();
    const retry = container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("common.refresh")}"]`)!;
    await press(retry);
    await expectFailedRefresh(retry);
    expect(mocks.listEngines).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(i18n.t("chat.handoffModelsFailed"));
    expect(container.textContent).toContain("saved-model");
    expect(container.querySelector(`button[aria-label="${i18n.t("common.refresh")}"]`)).toBeTruthy();
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
    expect(mocks.setCompressionMode).not.toHaveBeenCalled();
  });

  it("retains loaded models and the selection when refresh fails, without writing Cursor preferences", async () => {
    const previousParams = localStorage.getItem("ccgui.cursor.model-parameters");
    const previousCatalog = publishedCursorCatalog();
    const params = JSON.stringify({ opus: { effort: "low" } });
    const globalCatalog = [{ id: "chat-preserved", name: "Chat preserved", parameters: [] }];
    try {
      localStorage.setItem("ccgui.cursor.model-parameters", params);
      publishCursorCatalog(globalCatalog);
      await render();
      await press(picker());
      mocks.listEngineModels.mockRejectedValue(new Error("refresh offline"));
      const refresh = document.querySelector<HTMLButtonElement>(`[data-engine-flyout] button[aria-label="${i18n.t("common.refresh")}"]`)!;
      await press(refresh);
      await expectFailedRefresh(refresh);
      expect(container.querySelector('[role="status"]')?.textContent).toBe(i18n.t("chat.handoffModelsFailed"));
      expect(model("Saved model").getAttribute("aria-checked")).toBe("true");
      expect(model("Opus High")).toBeTruthy();
      expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
      expect(mocks.setCompressionMode).not.toHaveBeenCalled();
      expect(localStorage.getItem("ccgui.cursor.model-parameters")).toBe(params);
      expect(publishedCursorCatalog()).toEqual(globalCatalog);
      expect(mocks.cursorModelCatalog).not.toHaveBeenCalled();
    } finally {
      if (previousParams === null) localStorage.removeItem("ccgui.cursor.model-parameters"); else localStorage.setItem("ccgui.cursor.model-parameters", previousParams);
      publishCursorCatalog(previousCatalog);
    }
  });

  it("keeps saved IDs from partial catalogs and renders unnamed models using their raw IDs", async () => {
    mocks.listEngineModels.mockResolvedValue({ authoritative: false, models: [{ id: "unlabelled-model" }] });
    await render();
    expect(container.textContent).toContain("saved-model");
    expect(container.textContent).not.toContain(i18n.t("chat.handoffModelUnavailable"));
    expect(toggle().disabled).toBe(false);
    await press(picker());
    await press(model("unlabelled-model"));
    expect(mocks.setCompressionSelection).toHaveBeenCalledWith("/workspace", {
      engine: "cursor", model: "unlabelled-model", providerId: PSEUDO_LOCAL,
    });
  });

  it("locks all controls while sending and dismisses an already open model picker", async () => {
    await render();
    await press(picker());
    const oldModel = model("Opus High");
    expect(oldModel).toBeTruthy();
    await render({ mode: "grok", sending: true });
    expect(toggle().disabled).toBe(true);
    expect(picker().disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await press(oldModel);
    await press(picker());
    await press(toggle());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
    expect(mocks.setCompressionMode).not.toHaveBeenCalled();
  });

  it("prevents opening while engine discovery is pending and rejects unsupported engines", async () => {
    const discovery = Promise.withResolvers<typeof engines>();
    mocks.listEngines.mockReturnValue(discovery.promise);
    await render();
    expect(picker().disabled).toBe(true);
    await press(picker());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => discovery.resolve(engines));
    await press(picker());
    const unsupported = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button[aria-disabled="true"]')];
    expect(unsupported).toHaveLength(1);
    await press(unsupported[0]);
    expect(model("Saved model")).toBeTruthy();
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
  });

  it("shows pending catalog state without implicitly enabling compression or committing", async () => {
    mocks.listEngineModels.mockReturnValue(new Promise(() => {}));
    await render({ sending: true });
    expect(container.textContent).toContain(i18n.t("chat.handoffModelsLoading"));
    expect(toggle().disabled).toBe(true);
    expect([...container.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
    expect(mocks.setCompressionSelection).not.toHaveBeenCalled();
  });

  it("never changes global Cursor parameters, pins, or published catalog when selecting or refreshing", async () => {
    const previousParams = localStorage.getItem("ccgui.cursor.model-parameters");
    const previousPins = localStorage.getItem("ccgui.cursor.visible-models");
    const previousCatalog = publishedCursorCatalog();
    const params = JSON.stringify({ opus: { effort: "low", speed: "fast" } });
    const pins = JSON.stringify(["opus"]);
    const globalCatalog = [{ id: "chat-only", name: "Chat only", parameters: [] }];
    try {
      localStorage.setItem("ccgui.cursor.model-parameters", params);
      localStorage.setItem("ccgui.cursor.visible-models", pins);
      publishCursorCatalog(globalCatalog);
      await render({ compressionModel: "opus-high" });
      await press(picker());
      await press(model("Opus High"));
      await press(document.querySelector(`[data-engine-flyout] button[aria-label="${i18n.t("common.refresh")}"]`)!);
      expect(mocks.setCompressionSelection).toHaveBeenCalledWith("/workspace", { engine: "cursor", model: "opus-high", providerId: PSEUDO_LOCAL });
      expect(localStorage.getItem("ccgui.cursor.model-parameters")).toBe(params);
      expect(localStorage.getItem("ccgui.cursor.visible-models")).toBe(pins);
      expect(publishedCursorCatalog()).toEqual(globalCatalog);
      expect(mocks.cursorModelCatalog).not.toHaveBeenCalled();
    } finally {
      if (previousParams === null) localStorage.removeItem("ccgui.cursor.model-parameters"); else localStorage.setItem("ccgui.cursor.model-parameters", previousParams);
      if (previousPins === null) localStorage.removeItem("ccgui.cursor.visible-models"); else localStorage.setItem("ccgui.cursor.visible-models", previousPins);
      publishCursorCatalog(previousCatalog);
    }
  });
});
