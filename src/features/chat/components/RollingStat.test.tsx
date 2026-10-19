import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RollingStat } from "./RollingStat";

// React's act() environment flag — a well-known global the runtime can't
// validate, so a named cast with no narrowing is the right boundary.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
/** RAF 被接管后挂起的回调队列，按轮次手动 flush（jsdom 的 RAF 是定时器，不能让断言等它）。 */
let rafQueue: FrameRequestCallback[];

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue[id - 1] = () => {};
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** 跑若干轮 RAF：挂载 → apply → 各位数字列。 */
async function flushRaf(rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    await act(async () => {
      const batch = rafQueue.splice(0, rafQueue.length);
      batch.forEach((cb) => cb(performance.now()));
    });
  }
}

async function renderStat(value: number, prefix = "+") {
  await act(async () => {
    root.render(<RollingStat prefix={prefix} value={value} data-testid="stat" />);
  });
}

function stat(): HTMLElement {
  return container.querySelector<HTMLElement>("[data-testid='stat']")!;
}

function digitColumns(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-rolling-digit]")];
}

/** 当前实际停在滚动条上的数字（从各列 translateY 反推）。 */
function shownDigits(): string {
  return digitColumns()
    .map((column) => {
      const strip = column.firstElementChild as HTMLElement;
      return (/translateY\(-(\d+)em\)/.exec(strip.style.transform) ?? [])[1] ?? "?";
    })
    .join("");
}

describe("RollingStat", () => {
  it("renders the target immediately and rolls from 0 after mount", async () => {
    await renderStat(12);

    // 语义值立刻就是目标值，滚动只是视觉过程
    expect(stat().getAttribute("data-value")).toBe("12");
    expect(stat().getAttribute("aria-label")).toBe("+12");
    // 首帧仍停在 0：先 paint 0，再滚到目标
    expect(stat().getAttribute("data-display-value")).toBe("0");
    expect(shownDigits()).toBe("0");

    await flushRaf();
    expect(stat().getAttribute("data-display-value")).toBe("12");
    expect(shownDigits()).toBe("12");
    expect(digitColumns()).toHaveLength(2);
  });

  it("rolls to the new value when the value changes", async () => {
    await renderStat(12);
    await flushRaf();

    await renderStat(87);
    // 目标先更新，滚动随后
    expect(stat().getAttribute("data-value")).toBe("87");
    expect(stat().getAttribute("data-display-value")).toBe("12");

    await flushRaf();
    expect(stat().getAttribute("data-display-value")).toBe("87");
    expect(shownDigits()).toBe("87");
  });

  it("prepends a column when the digit count grows and reuses the rest", async () => {
    await renderStat(12);
    await flushRaf();
    const before = digitColumns();
    expect(before).toHaveLength(2);

    await renderStat(128);
    await flushRaf();
    const after = digitColumns();
    expect(after).toHaveLength(3);
    // key 用从右往左的位序：已有列被复用（不重建、不重滚），新列挂在最左
    expect(after[1]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
    expect(shownDigits()).toBe("128");
  });

  it("hides the digit strip from assistive tech and keeps the prefix readable", async () => {
    await renderStat(2568, "−");
    await flushRaf();

    expect(stat().getAttribute("aria-label")).toBe("−2568");
    expect(stat().getAttribute("role")).toBe("img");
    expect(digitColumns()).toHaveLength(4);
    for (const column of digitColumns()) {
      expect(column.getAttribute("aria-hidden")).toBe("true");
    }
    expect(stat().textContent?.startsWith("−")).toBe(true);
  });

  it("normalizes negatives and fractions to a non-negative integer", async () => {
    await renderStat(-7);
    expect(stat().getAttribute("data-value")).toBe("0");
    expect(stat().getAttribute("aria-label")).toBe("+0");

    await renderStat(12.6);
    expect(stat().getAttribute("data-value")).toBe("13");
    await flushRaf();
    expect(shownDigits()).toBe("13");
  });
});
