import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc, type AgyQuotaSnapshot } from "@/lib/ipc";
import { listenAgyQuotaChanged, listenAgyVertexCreditsChanged } from "@/lib/events";
import { applyCreditsSnapshot, DEFAULT_CREDITS_SNAPSHOT } from "@/features/settings/agy-vertex-guardrail";
import { AgyQuotaControl } from "./AgyQuotaStatus";

vi.mock("@/lib/ipc", () => ({ ipc: { agyQuotaRead: vi.fn(), agyVertexCreditsRead: vi.fn() } }));
vi.mock("@/lib/events", () => ({ listenAgyQuotaChanged: vi.fn(), listenAgyVertexCreditsChanged: vi.fn() }));
vi.mock("@/lib/platform", () => ({ openExternal: vi.fn() }));
vi.mock("@/features/settings/providers", () => ({ CLI_CONFIG_CHANGED_EVENT: "ccgui:cli-config-changed" }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sample = (): AgyQuotaSnapshot => ({ status: "ready", collectedAt: Date.now() / 1000, groups: [
  { id: "gemini_argon", windows: { fiveHour: { usedPercentage: 20 }, sevenDay: { usedPercentage: 35 } } },
] });

describe("AGY quota control channel routing", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    applyCreditsSnapshot(DEFAULT_CREDITS_SNAPSHOT);
    vi.mocked(listenAgyQuotaChanged).mockResolvedValue(vi.fn());
    vi.mocked(listenAgyVertexCreditsChanged).mockResolvedValue(vi.fn());
    vi.mocked(ipc.agyQuotaRead).mockResolvedValue(sample());
    vi.mocked(ipc.agyVertexCreditsRead).mockResolvedValue(DEFAULT_CREDITS_SNAPSHOT);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render(engine = "agy", providerId?: string, workspacePath = "C:/project") {
    await act(async () => root.render(<AgyQuotaControl engine={engine} providerId={providerId} workspacePath={workspacePath} model="gemini-4-argon-high" />));
  }
  async function open() {
    await act(async () => container.querySelector("button")!.click());
    return document.querySelector('[role="dialog"]')!;
  }

  it.each(["agy-vertex-byok", "other-custom-channel"])("keeps the entry and explicit Vertex sync for %s without reading native quota", async provider => {
    await render("agy", provider);
    expect(container.textContent).toBe(i18n.t("chat.agyQuotaAndCredits"));
    expect(ipc.agyQuotaRead).not.toHaveBeenCalled();
    expect(ipc.agyVertexCreditsRead).toHaveBeenCalledWith({ force: false });
    expect(ipc.agyVertexCreditsRead).not.toHaveBeenCalledWith({ force: true });
    const dialog = await open();
    expect(dialog.textContent).toContain(i18n.t("chat.agyQuotaNativeChannelOnly"));
    expect(dialog.textContent).not.toContain(i18n.t("chat.agyQuotaSource"));
    const vertex = dialog.querySelector(`section[aria-label="${i18n.t("chat.agyVertexCredits")}"]`)!;
    expect(vertex).not.toBeNull();
    expect(dialog.querySelectorAll("button").length).toBe(2);
    expect(ipc.agyVertexCreditsRead).not.toHaveBeenCalledWith({ force: true });
    await act(async () => vertex.querySelector("button")!.click());
    expect(ipc.agyVertexCreditsRead).toHaveBeenCalledWith({ force: true });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(ipc.agyQuotaRead).not.toHaveBeenCalled();
  });

  it("keeps native bootstrap API reads and model percentages", async () => {
    vi.mocked(ipc.agyQuotaRead).mockResolvedValueOnce({ status: "unavailable", groups: [], errorCode: "not_loaded" });
    await render();
    expect(vi.mocked(ipc.agyQuotaRead).mock.calls.map(([options]) => options)).toEqual([
      { cacheOnly: true, force: false, providerId: undefined, workspacePath: "C:/project" },
      { cacheOnly: false, force: false, providerId: undefined, workspacePath: "C:/project" },
    ]);
    expect(container.textContent).toContain("80%");
    expect(container.textContent).toContain("65%");
    const dialog = await open();
    expect(dialog.textContent).toContain(i18n.t("chat.agyQuotaSource"));
    expect(dialog.querySelectorAll("button").length).toBe(3);
    expect(ipc.agyVertexCreditsRead).not.toHaveBeenCalledWith({ force: true });
  });

  it("removes native values and query access when switching to BYOK", async () => {
    await render();
    expect(container.textContent).toContain("80%");
    vi.mocked(ipc.agyQuotaRead).mockClear();
    await render("agy", "agy-vertex-byok");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).toBe(i18n.t("chat.agyQuotaAndCredits"));
    expect(ipc.agyQuotaRead).not.toHaveBeenCalled();
  });

  it("does not render or query quotas for another engine", async () => {
    await render("claude");
    expect(container.querySelector("button")).toBeNull();
    expect(ipc.agyQuotaRead).not.toHaveBeenCalled();
    expect(ipc.agyVertexCreditsRead).not.toHaveBeenCalled();
  });
  it("keeps the entry for remote AGY without relaxing native query routing", async () => {
    await render("agy", undefined, "ssh://host/project");
    expect(container.textContent).toBe(i18n.t("chat.agyQuotaAndCredits"));
    const dialog = await open();
    expect(dialog.textContent).toContain(i18n.t("chat.agyVertexCredits"));
    expect(ipc.agyQuotaRead).not.toHaveBeenCalled();
    expect(ipc.agyVertexCreditsRead).toHaveBeenCalledWith({ force: false });
    expect(ipc.agyVertexCreditsRead).not.toHaveBeenCalledWith({ force: true });
  });
});
