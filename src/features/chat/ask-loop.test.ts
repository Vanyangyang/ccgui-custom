import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/ipc";
import { ASK_OTHER_OPTION, declaredMulti, parseAskFrame } from "./store/ask-loop";

const OPTIONS = [{ label: "A" }, { label: "B" }, { label: "C" }];

describe("parseAskFrame", () => {
  it("keeps the question's own rows and drops the CLI's runtime ones", () => {
    const frame = parseAskFrame("要不要继续？", [
      ...OPTIONS,
      { label: "✓ Done selecting" },
      { label: ASK_OTHER_OPTION },
    ]);
    expect(frame.base).toBe("要不要继续？");
    expect(frame.progress).toBeNull();
    expect(frame.selectedCount).toBeNull();
    expect(frame.options.map((option) => option.label)).toEqual(["A", "B", "C"]);
  });

  it("strips the selected-count prefix and the progress suffix", () => {
    const frame = parseAskFrame("(2 selected) 你更关注哪个方向？（可多选） (3/3)", [
      ...OPTIONS,
      { label: ASK_OTHER_OPTION },
    ]);
    expect(frame.base).toBe("你更关注哪个方向？（可多选）");
    expect(frame.selectedCount).toBe(2);
    expect(frame.progress).toEqual([3, 3]);
  });

  it("reads a selected count the CLI wrote after the question", () => {
    const frame = parseAskFrame("选哪个？ (1 selected)", OPTIONS);
    expect(frame.base).toBe("选哪个？");
    expect(frame.selectedCount).toBe(1);
  });
});

describe("declaredMulti", () => {
  const frame = parseAskFrame("(1 selected) 方向？ (3/3)", [
    { label: "A" },
    { label: ASK_OTHER_OPTION },
  ]);
  const askRow = (third: unknown) =>
    [{ args: { questions: [null, null, third] } } as unknown as Message];

  it("matches the declared question by index, text and option list", () => {
    expect(
      declaredMulti(
        askRow({ question: "方向？", multi: true, options: [{ label: "A" }] }),
        frame,
      ),
    ).toBe(true);
  });

  it("refuses a declaration that does not describe the frame", () => {
    expect(
      declaredMulti(
        askRow({ question: "方向？", multi: true, options: [{ label: "B" }] }),
        frame,
      ),
    ).toBe(false);
    expect(
      declaredMulti(
        askRow({ question: "另一个问句", multi: true, options: [{ label: "A" }] }),
        frame,
      ),
    ).toBe(false);
    expect(
      declaredMulti(
        askRow({ question: "方向？", multi: false, options: [{ label: "A" }] }),
        frame,
      ),
    ).toBe(false);
    expect(declaredMulti([], frame)).toBe(false);
  });
});
