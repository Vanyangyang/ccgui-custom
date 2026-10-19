import { describe, expect, it } from "vitest";
import { DEFAULT_PET_SCALE, PET_BASE_SCALE, PET_SCALE_OPTIONS, normalizePetScale } from "./pet-scale";

describe("desktop pet scale", () => {
  it("uses the old 60% size as the new 100% baseline", () => {
    expect(PET_BASE_SCALE).toBe(0.6);
    expect(DEFAULT_PET_SCALE).toBe(1);
    expect(PET_SCALE_OPTIONS).toEqual([0.5, 0.75, 1, 1.25, 1.5]);
  });

  it("normalizes values to the 50%-150% range", () => {
    expect(normalizePetScale(0.4)).toBe(0.5);
    expect(normalizePetScale(1.6)).toBe(1.5);
    expect(normalizePetScale(undefined)).toBe(1);
  });
});
