import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS, getDefaultEffort, getEffortLevels, normalizeEffortLevel } from "./effort-levels";

describe("engine effort levels", () => {
  it("defaults Claude to xhigh and keeps other engines at medium", () => {
    expect(getDefaultEffort("claude")).toBe("xhigh");
    expect(getDefaultEffort("codex")).toBe("medium");
    expect(getDefaultEffort("pi")).toBe("medium");
  });
  it("uses engine-specific stops for Claude and AGY and preserves the six-stop catalog for other engines", () => {
    expect(getEffortLevels("claude")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getEffortLevels("agy")).toEqual(["low", "medium", "high"]);
    for (const engine of ["codex", "omp", "pi", "qoder", "qoder-cn", "grok", "opencode", "kimi", "dsh", "custom"]) {
      expect(getEffortLevels(engine)).toBe(EFFORT_LEVELS);
    }
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("normalizes legacy Claude ultra and unsupported AGY xhigh/max/ultra selections", () => {
    expect(normalizeEffortLevel("claude", "ultra")).toBe("max");
    for (const value of ["low", "medium", "high", "xhigh", "max", "custom", "", null, undefined]) {
      expect(normalizeEffortLevel("claude", value)).toBe(value);
    }
    for (const value of ["xhigh", "max", "ultra"] as const) {
      expect(normalizeEffortLevel("agy", value)).toBe("high");
    }
    for (const value of ["low", "medium", "high", "custom", "", null, undefined]) {
      expect(normalizeEffortLevel("agy", value)).toBe(value);
    }
    expect(normalizeEffortLevel("codex", "ultra")).toBe("ultra");
    expect(normalizeEffortLevel("omp", "ultra")).toBe("ultra");
  });
});
