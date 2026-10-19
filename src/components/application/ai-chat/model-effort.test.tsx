import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { EngineModelPanel } from "./engine-model-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const models = [
  { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)", provider: "anthropic" },
  { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)", provider: "anthropic" },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)", provider: "anthropic" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", provider: "openai" },
  { id: "custom-model", label: "Custom model" },
];

describe("model effort selection", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onPickModel = vi.fn();
  const onEffortChange = vi.fn();

  beforeEach(async () => {
    await i18n.changeLanguage("zh");
    onPickModel.mockClear();
    onEffortChange.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(selectedModelId = models[2].id, engine = "agy", query = "") {
    act(() => root.render(<EngineModelPanel
      option={{ id: engine, label: engine }} models={models}
      selectedModelId={selectedModelId} query={query} onQueryChange={() => {}}
      effort="medium" onPickModel={onPickModel} onEffortChange={onEffortChange}
      ompServiceTier={null} onOmpServiceTierChange={async () => {}}
      codexServiceTier={null} onCodexServiceTierChange={async () => {}}
    />));
  }
  const effortGroup = () => container.querySelector(`[role="radiogroup"][aria-label="${i18n.t("chat.effort")}"]`);

  it("groups encoded variants under one model name and selects the exact catalog ID", () => {
    render();
    expect(container.textContent?.match(/Claude Opus 5\.5/g)).toHaveLength(1);
    const high = container.querySelector<HTMLButtonElement>('[aria-label="Claude Opus 5.5 · 高"]');
    expect(high?.getAttribute("aria-checked")).toBe("true");
    const low = container.querySelector<HTMLButtonElement>('[aria-label="Claude Opus 5.5 · 低"]');
    act(() => low!.click());
    expect(onPickModel).toHaveBeenCalledWith("agy", "claude-opus-5-5-low");
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(effortGroup()).toBeNull();
    expect(container.querySelector('[role="slider"]')).toBeNull();
  });

  it("keeps exact ID search and offers only matching catalog variants", () => {
    render(models[2].id, "agy", "claude-opus-5-5-high");
    expect(container.querySelector('[aria-label="Claude Opus 5.5 · 高"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Claude Opus 5.5 · 低"]')).toBeNull();
    expect(container.textContent).not.toContain("GPT-OSS");
  });

  it("does not invent extra levels for a single-variant model", () => {
    render("gpt-oss-120b-medium");
    const choices = container.querySelectorAll('[aria-label^="GPT-OSS 120B ·"]');
    expect(choices).toHaveLength(1);
    expect(choices[0].getAttribute("aria-checked")).toBe("true");
    act(() => (choices[0] as HTMLButtonElement).click());
    expect(onPickModel).toHaveBeenCalledWith("agy", "gpt-oss-120b-medium");
  });

  it("retains independent effort for a model without encoded levels and limits AGY to three stops", () => {
    render("custom-model");
    const group = effortGroup()!;
    expect(group).not.toBeNull();
    expect(
      [...group.querySelectorAll<HTMLElement>('[role="radio"]')].map((el) => el.getAttribute("data-effort")),
    ).toEqual(["low", "medium", "high"]);
    const high = group.querySelector<HTMLButtonElement>('[data-effort="high"]')!;
    act(() => high.click());
    expect(onEffortChange).toHaveBeenCalledWith("agy", "high");
    expect(onPickModel).not.toHaveBeenCalled();
  });

  it("hides ineffective effort even when the saved encoded ID is missing from the catalog", () => {
    render("retired-model-high");
    expect(effortGroup()).toBeNull();
    expect(container.querySelector('[role="slider"]')).toBeNull();
  });

  it("leaves other engines' similarly named model IDs as independent models", () => {
    render(models[2].id, "codex");
    expect(container.textContent).toContain("Claude Opus 5.5 (High)");
    expect(effortGroup()).not.toBeNull();
  });

  it("offers Claude's five named levels with keyboard navigation", () => {
    render("custom-model", "claude");
    const group = effortGroup()!;
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(5);
    const medium = group.querySelector<HTMLButtonElement>('[data-effort="medium"]')!;
    expect(medium.textContent).toBe("中");
    act(() => {
      medium.focus();
      medium.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onEffortChange).toHaveBeenCalledWith("claude", "high");
    expect(document.activeElement?.getAttribute("data-effort")).toBe("high");
  });
});
