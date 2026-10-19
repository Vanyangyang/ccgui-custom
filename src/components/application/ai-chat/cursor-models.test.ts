import { beforeEach, describe, expect, it } from "vitest";
import {
  collapseCursorModels,
  cursorContextTokens,
  cursorLaunchModel,
  cursorRememberedModel,
  effectiveCursorParams,
  encodeCursorLaunchModel,
  inferParamsFromSlug,
  matchCursorBase,
  orderCursorModels,
  publishCursorCatalog,
  writeCursorModelParams,
  type CursorModel,
} from "./cursor-models";

const grok: CursorModel = {
  id: "grok-4.7",
  name: "Grok 4.7",
  parameters: [
    { id: "context", name: "Context", current: "256k", options: [{ value: "256k", name: "256K" }, { value: "500k", name: "500K" }] },
    { id: "reasoning_effort", name: "Effort", current: "high", options: [
      { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "Extra High" },
    ] },
    { id: "fast", name: "Fast", current: "true", options: [{ value: "false", name: "Off" }, { value: "true", name: "Fast" }] },
  ],
};
const composer: CursorModel = {
  id: "composer-2.5",
  name: "Composer 2.5",
  parameters: [{ id: "fast", name: "Fast", options: [{ value: "false", name: "Off" }, { value: "true", name: "Fast" }] }],
};
const gemini: CursorModel = { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", parameters: [] };

describe("cursor model grouping", () => {
  beforeEach(() => { localStorage.clear(); publishCursorCatalog([]); });

  it("recovers saved CLI display names using catalog identities and option values", () => {
    publishCursorCatalog([grok, composer, gemini]);
    const label = "Grok 4.7 256K High Fast";
    expect(matchCursorBase(label, [grok])?.id).toBe("grok-4.7");
    expect(cursorRememberedModel(label)).toBe("grok-4.7");
    expect(cursorLaunchModel(label)).toBe('grok-4.7\u001e{"context":"256k","reasoning_effort":"high","fast":"true"}');
    expect(matchCursorBase("Grok 4.7 unknown-mode", [grok])).toBeUndefined();
    expect(matchCursorBase(label, [grok, { ...grok, id: "custom-grok" }])).toBeUndefined();
    writeCursorModelParams("grok-4.7", { context: "500k", reasoning_effort: "xhigh", fast: "false" });
    expect(cursorLaunchModel(label)).toBe('grok-4.7\u001e{"context":"500k","reasoning_effort":"xhigh","fast":"false"}');
  });

  it("keeps saved effort across text and ACP catalog refreshes", () => {
    expect(effectiveCursorParams(grok, { effort: "low", context: "500k", fast: "false" }))
      .toEqual({ context: "500k", reasoning_effort: "low", fast: "false" });
    const textModel = { ...grok, parameters: grok.parameters.map((parameter) => parameter.id === "reasoning_effort" ? { ...parameter, id: "effort" } : parameter) };
    expect(effectiveCursorParams(textModel, { reasoning_effort: "xhigh" }).effort).toBe("xhigh");
  });

  it("retains recovered label options after canonicalization and the next launch", () => {
    publishCursorCatalog([grok]);
    const label = "Grok 4.7 500K Low";
    const first = cursorLaunchModel(label);
    expect(first).toBe('grok-4.7\u001e{"context":"500k","reasoning_effort":"low","fast":"false"}');
    const remembered = cursorRememberedModel(label);
    publishCursorCatalog([{ ...grok }]);
    expect(cursorLaunchModel(remembered)).toBe(first);
  });

  it("keeps one row per model and floats pinned models", () => {
    const ordered = orderCursorModels([grok, composer, gemini], ["gemini-3.1-pro"], "");
    expect(ordered.map((model) => model.id)).toEqual(["gemini-3.1-pro", "grok-4.7", "composer-2.5"]);
    expect(orderCursorModels([grok, composer], [], "composer").map((model) => model.name)).toEqual(["Composer 2.5"]);
  });

  it("maps an exploded slug back to the base model and its parameters", () => {
    expect(matchCursorBase("grok-4.7-high-fast", [grok, composer])?.id).toBe("grok-4.7");
    expect(inferParamsFromSlug("grok-4.7-high-fast", grok)).toEqual({ fast: "true", reasoning_effort: "high" });
    expect(inferParamsFromSlug("grok-4.7-low", grok).fast).toBe("false");
    expect(inferParamsFromSlug("grok-4.7", grok)).toEqual({});
  });

  it("uses the saved context size and omits fast when the model has none", () => {
    expect(cursorContextTokens(grok, { context: "500k" })).toBe(500_000);
    expect(cursorContextTokens(gemini, {})).toBeUndefined();
    expect(effectiveCursorParams(composer, { fast: "true" })).toEqual({ fast: "true" });
    expect(encodeCursorLaunchModel("grok-4.7", { context: "500k", fast: "true" })).toBe(
      'grok-4.7\u001e{"context":"500k","fast":"true"}',
    );
  });

  it("collapses the text catalog and launches the base id", () => {
    const collapsed = collapseCursorModels([
      { id: "grok-4.7-high", label: "Grok 4.7  High" },
      { id: "grok-4.7-high-fast", label: "Grok 4.7  High Fast" },
      { id: "grok-4.7-low", label: "Grok 4.7  Low" },
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
    ]);
    expect(collapsed.map((model) => model.name)).toEqual(["Grok 4.7", "Composer 2.5"]);
    expect(collapsed[0].parameters.map((parameter) => parameter.id)).toEqual(["effort", "fast"]);
    expect(collapsed[1].parameters.map((parameter) => parameter.id)).toEqual(["fast"]);
    publishCursorCatalog([grok, gemini]);
    expect(cursorLaunchModel("grok-4.7-high-fast")).toContain("grok-4.7\u001e");
    expect(cursorLaunchModel("grok-4.7-high-fast")).not.toContain("high-fast");
    expect(cursorLaunchModel("gemini-3.1-pro")).toBe("gemini-3.1-pro\u001e{}");
  });
});
