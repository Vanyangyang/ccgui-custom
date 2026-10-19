import { describe, expect, it } from "vitest";
import {
  atlasBackgroundPosition,
  atlasFrame,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
  PET_ANIMATION_ROWS,
  PET_STATUS_ROWS,
} from "./pet-atlas";

describe("pet v2 atlas", () => {
  it("uses the standard 192x208 cells and action rows", () => {
    expect([PET_CELL_WIDTH, PET_CELL_HEIGHT]).toEqual([192, 208]);
    expect(PET_STATUS_ROWS).toMatchObject({ idle: 0, running: 7, waiting: 6, failed: 5, review: 8 });
    expect(PET_ANIMATION_ROWS).toMatchObject({ stand: 0, rest: 4, lay: 5, jump: 3 });
    expect(atlasFrame("running", 9)).toEqual({ row: 7, column: 1 });
  });

  it("keeps animation frames inside the 8-column sheet", () => {
    expect(atlasBackgroundPosition("failed", 10)).toBe("-384px -1040px");
  });

  it("does not animate into transparent trailing cells", () => {
    const frameCounts = Array.from({ length: 11 }, () => 8);
    frameCounts[7] = 6;
    expect(atlasFrame("running", 6, 0, frameCounts)).toEqual({ row: 7, column: 0 });
    expect(atlasBackgroundPosition("running", 6, 0, frameCounts)).toBe("0px -1456px");
  });

  it("maps interaction animations to the Codex v2 action rows", () => {
    const frameCounts = Array.from({ length: 11 }, () => 8);
    frameCounts[3] = 4;
    frameCounts[4] = 5;
    expect(atlasFrame("jump", 4, 0, frameCounts)).toEqual({ row: 3, column: 0 });
    expect(atlasFrame("rest", 5, 0, frameCounts)).toEqual({ row: 4, column: 0 });
    expect(atlasFrame("lay", 6, 0, frameCounts)).toEqual({ row: 5, column: 6 });
  });
});
