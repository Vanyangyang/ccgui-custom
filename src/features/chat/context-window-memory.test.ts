import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSUMED_CONTEXT_WINDOW } from "./usage";
import {
  recallContextWindow,
  rememberContextWindow,
  resolveContextMax,
  resolveContextMaxInfo,
} from "./context-window-memory";

describe("context window memory", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("remembers a reported window per engine and model slot", () => {
    rememberContextWindow("claude", "default", 1_000_000);

    expect(recallContextWindow("claude", "default")).toBe(1_000_000);
    // Another slot (or engine) has its own memory.
    expect(recallContextWindow("claude", "sonnet")).toBeUndefined();
    expect(recallContextWindow("codex", "default")).toBeUndefined();
  });

  it("returns undefined for unknown slots and ignores non-positive windows", () => {
    expect(recallContextWindow("claude", "default")).toBeUndefined();

    rememberContextWindow("claude", "default", 0);

    expect(recallContextWindow("claude", "default")).toBeUndefined();
  });

  it("treats a broken storage as a cache miss instead of crashing", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });

    expect(() =>
      rememberContextWindow("claude", "default", 1_000_000),
    ).not.toThrow();

    setItem.mockRestore();
    expect(recallContextWindow("claude", "default")).toBeUndefined();
  });

  it("starts a fresh session at the remembered window instead of the 200k guess", () => {
    rememberContextWindow("claude", "default", 1_000_000);

    expect(
      resolveContextMax({
        usage: undefined,
        engine: "claude",
        model: "default",
      }),
    ).toBe(1_000_000);
  });

  it("distinguishes an assumed 200K from a catalog or remembered 200K capacity", () => {
    const opts = { usage: undefined, engine: "claude", model: "sonnet" };
    expect(resolveContextMaxInfo(opts)).toEqual({ max: ASSUMED_CONTEXT_WINDOW, known: false });
    expect(resolveContextMaxInfo({ ...opts, catalogWindow: 200_000 })).toEqual({ max: 200_000, known: true });
    rememberContextWindow("claude", "sonnet", 200_000);
    expect(resolveContextMaxInfo(opts)).toEqual({ max: 200_000, known: true });
  });

  it("accepts explicit capacity without token usage and rejects nonfinite capacity", () => {
    const opts = { engine: "agy", model: "fixture", usage: { model_context_window: 1000000 } };
    expect(resolveContextMaxInfo(opts)).toEqual({ max: 1000000, known: true });
    rememberContextWindow("agy", "fixture", Infinity);
    expect(recallContextWindow("agy", "fixture")).toBeUndefined();
    localStorage.setItem("ccgui.context-window.agy.fixture", "Infinity");
    expect(resolveContextMaxInfo({ ...opts, usage: null, catalogWindow: Infinity }).known).toBe(false);
  });

  it("shows the documented Gemini 4 API capacity without guessing subscription aliases", () => {
    const opts = { engine: "agy", model: "gemini-4-argon", usage: null };
    expect(resolveContextMaxInfo(opts)).toEqual({ max: 1_048_576, known: true });
    expect(resolveContextMaxInfo({ ...opts, usage: { model_context_window: 256_000 } })).toEqual({ max: 256_000, known: true });
    expect(resolveContextMaxInfo({ ...opts, model: "gemini-4-argon-high" }).known).toBe(false);
    expect(resolveContextMaxInfo({ ...opts, model: "custom-model" }).known).toBe(false);
  });

  it("prefers a live report, then memory, then the catalog, then the guess", () => {
    rememberContextWindow("claude", "default", 500_000);

    // A live report (the engine's own window) wins over memory and catalog.
    expect(
      resolveContextMax({
        usage: {
          input_tokens: 10,
          total_tokens: 10,
          model_context_window: 1_000_000,
        },
        engine: "claude",
        model: "default",
        catalogWindow: 200_000,
      }),
    ).toBe(1_000_000);

    // No live window: memory wins over the catalog.
    expect(
      resolveContextMax({
        usage: { input_tokens: 10, total_tokens: 10 },
        engine: "claude",
        model: "default",
        catalogWindow: 200_000,
      }),
    ).toBe(500_000);

    // No memory for this slot: the catalog wins.
    expect(
      resolveContextMax({
        usage: undefined,
        engine: "claude",
        model: "sonnet",
        catalogWindow: 200_000,
      }),
    ).toBe(200_000);

    // Nothing anywhere: the shared guess.
    expect(
      resolveContextMax({ usage: undefined, engine: "pi", model: "x" }),
    ).toBe(ASSUMED_CONTEXT_WINDOW);
  });
});
