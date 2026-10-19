import { describe, expect, it } from "vitest";
import { annotationsComplete, boxFromDrag, boxPercents, imageFraction } from "./geometry";

describe("image annotation geometry", () => {
  it("maps pointers through the transformed image rect and clamps outside points", () => {
    // A 400×200 image zoomed 2× and panned: its on-screen rect already carries both.
    const rect = { left: -100, top: 50, width: 800, height: 400 };
    expect(imageFraction({ clientX: 300, clientY: 250 }, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(imageFraction({ clientX: -500, clientY: 900 }, rect)).toEqual({ x: 0, y: 1 });
    expect(imageFraction({ clientX: 10, clientY: 10 }, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("normalizes reversed drags and ignores click-sized ones", () => {
    const box = boxFromDrag({ x: 0.6, y: 0.5 }, { x: 0.2, y: 0.1 })!;
    expect(box.x).toBeCloseTo(0.2);
    expect(box.y).toBeCloseTo(0.1);
    expect(box.width).toBeCloseTo(0.4);
    expect(box.height).toBeCloseTo(0.4);
    expect(boxFromDrag({ x: 0.3, y: 0.3 }, { x: 0.305, y: 0.5 })).toBeNull();
  });

  it("reports whole-percent bounds and requires a note on every box", () => {
    expect(boxPercents({ x: 0.123, y: 0.3, width: 0.277, height: 0.224 })).toEqual({ x1: 12, x2: 40, y1: 30, y2: 52 });
    const box = { id: 1, x: 0, y: 0, width: 0.5, height: 0.5, note: "按钮被截断" };
    expect(annotationsComplete([])).toBe(false);
    expect(annotationsComplete([box])).toBe(true);
    expect(annotationsComplete([box, { ...box, id: 2, note: "  " }])).toBe(false);
  });
});
