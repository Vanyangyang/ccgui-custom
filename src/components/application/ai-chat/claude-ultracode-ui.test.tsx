import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { CliMenu } from "./cli-menu";
import { EngineModelPanel } from "./engine-model-panel";
import type { EffortLevel } from "./effort-levels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const onEffortChange = vi.fn();
const onUltracodeChange = vi.fn();
const shared = {
  models: [], selectedModelId: "", query: "", onQueryChange: () => {}, onPickModel: () => {},
  ompServiceTier: null, onOmpServiceTierChange: async () => {},
  codexServiceTier: null, onCodexServiceTierChange: async () => {},
};

function PanelHarness({ engine = "claude", initialEffort = "medium" }: { engine?: string; initialEffort?: EffortLevel }) {
  const [effort, setEffort] = useState(initialEffort);
  const [ultracode, setUltracode] = useState(false);
  return <EngineModelPanel {...shared} option={{ id: engine, label: engine }} effort={effort}
    onEffortChange={(id, level) => { onEffortChange(id, level); setEffort(level); }}
    claudeUltracode={ultracode}
    onClaudeUltracodeChange={(enabled) => { onUltracodeChange(enabled); setUltracode(enabled); }} />;
}

function MenuHarness({ initialUltracode = false, initialEffort = "medium" }: { initialUltracode?: boolean; initialEffort?: EffortLevel }) {
  const [effort, setEffort] = useState(initialEffort);
  const [ultracode, setUltracode] = useState(initialUltracode);
  return <CliMenu options={[{ id: "claude", label: "Claude Code" }]} value="claude" onChange={() => {}}
    modelsByEngine={{ claude: [{ id: "default", label: "Default" }] }} models={{ claude: "default" }}
    onModelChange={() => {}} efforts={{ claude: effort }}
    onEffortChange={(id, level) => { onEffortChange(id, level); setEffort(level); }}
    claudeUltracode={ultracode}
    onClaudeUltracodeChange={(enabled) => { onUltracodeChange(enabled); setUltracode(enabled); }}
    ompServiceTier={null} onOmpServiceTierChange={async () => {}}
    codexServiceTier={null} onCodexServiceTierChange={async () => {}} />;
}

describe("Claude effort and independent Ultracode UI", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mobile: boolean;

  beforeEach(() => {
    mobile = false;
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: mobile && query === "(max-width: 767px)", media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
  const toggle = () => document.querySelector<HTMLInputElement>(`input[role="switch"][aria-label="${i18n.t("chat.ultracode")}"]`)!;
  const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"][data-effort]')];
  const selected = () => radios().find((button) => button.getAttribute("aria-checked") === "true")!;
  const key = async (value: string) => {
    await act(async () => {
      selected().focus();
      selected().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
      selected().dispatchEvent(new KeyboardEvent("keyup", { key: value, bubbles: true }));
    });
  };
  const click = async (element: HTMLElement) => { await act(async () => element.click()); };

  it("renders five labeled Claude choices with legacy ultra displayed as max", async () => {
    await render(<PanelHarness initialEffort="ultra" />);
    expect(radios().map((button) => button.dataset.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(selected().dataset.effort).toBe("max");
    expect(container.textContent).toContain(i18n.t("chat.effortMax"));
    expect([...container.querySelectorAll("span")].some((span) => span.textContent === i18n.t("chat.effortUltra"))).toBe(false);
    expect(radios().map((button) => button.textContent)).toEqual(["chat.effortLow", "chat.effortMedium", "chat.effortHigh", "chat.effortXhigh", "chat.effortMax"].map((key) => i18n.t(key)));
    expect(onEffortChange).not.toHaveBeenCalled();
    await key("Home");
    await key("End");
    expect(onEffortChange).toHaveBeenLastCalledWith("claude", "max");
  });

  it.each(["codex", "omp", "kimi"])("keeps all six labeled %s choices and selects ultra with End", async (engine) => {
    await render(<PanelHarness engine={engine} initialEffort="max" />);
    expect(radios().map((button) => button.dataset.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(selected().dataset.effort).toBe("max");

    expect(toggle()).toBeNull();
    await key("End");
    expect(onEffortChange).toHaveBeenLastCalledWith(engine, "ultra");
    expect(selected().dataset.effort).toBe("ultra");
  });

  it("keeps effort and Ultracode independent in both directions", async () => {
    await render(<PanelHarness />);
    expect(toggle().checked).toBe(false);
    const description = document.getElementById(toggle().getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(i18n.t("chat.ultracodeDescription"));
    await click(toggle());
    expect(onUltracodeChange).toHaveBeenLastCalledWith(true);
    expect(toggle().checked).toBe(true);
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(selected().dataset.effort).toBe("medium");
    await key("End");
    expect(onEffortChange).toHaveBeenLastCalledWith("claude", "max");
    expect(toggle().checked).toBe(true);
    expect(onUltracodeChange).toHaveBeenCalledTimes(1);
    await click(toggle());
    expect(onUltracodeChange).toHaveBeenLastCalledWith(false);
    expect(selected().dataset.effort).toBe("max");
    expect(onEffortChange).toHaveBeenCalledTimes(1);
    await key("Home");
    expect(toggle().checked).toBe(false);
    expect(onUltracodeChange).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("passes the independent setting through CliMenu on mobile=%s", async (isMobile) => {
    mobile = isMobile;
    await render(<MenuHarness initialUltracode initialEffort="ultra" />);
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.getAttribute("aria-label")).toContain(i18n.t("chat.effortMax"));
    expect(trigger.getAttribute("aria-label")).toContain(i18n.t("chat.ultracode"));
    await click(trigger);
    if (isMobile) {
      expect(document.querySelector("[data-engine-flyout]")).toBeNull();
      const row = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent?.trim() === "Claude Code")!;
      await click(row);
    } else {
      expect(document.querySelector("[data-engine-flyout]")).toBeTruthy();
    }
    expect(toggle().checked).toBe(true);
    expect(radios().map((button) => button.dataset.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    await click(toggle());
    expect(toggle().checked).toBe(false);
    expect(onUltracodeChange).toHaveBeenLastCalledWith(false);
    expect(onEffortChange).not.toHaveBeenCalled();
    await key("Home");
    expect(onEffortChange).toHaveBeenLastCalledWith("claude", "low");
    expect(toggle().checked).toBe(false);
    expect(onUltracodeChange).toHaveBeenCalledTimes(1);
  });
});
