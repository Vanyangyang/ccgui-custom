import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabDragReorder } from "./use-tab-drag-reorder";
import type { SessionTabItem } from "./SessionTab";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const TAB_A: SessionTabItem = {
  key: "claude/a",
  label: "A",
  streaming: false,
  session: { engine: "claude", sessionId: "a", workspacePath: "/repo" },
};
const TAB_B: SessionTabItem = {
  key: "claude/b",
  label: "B",
  streaming: false,
  session: { engine: "claude", sessionId: "b", workspacePath: "/repo" },
};

let node: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

/** 页签条内一个 tab（带 data-tab-key，供命中判定），底下 600px 是「对话区」。 */
function Harness({
  onReorder,
  onDragOut,
}: {
  onReorder?: (a: string, b: string, before: boolean) => void;
  onDragOut?: (tab: SessionTabItem, event: PointerEvent) => boolean;
}) {
  const { handleTabPointerDown } = useTabDragReorder(onReorder, onDragOut);
  return (
    <div data-tab-strip="" style={{ height: 40 }}>
      {[TAB_A, TAB_B].map((tab) => (
        <div
          key={tab.key}
          data-tab-key={tab.key}
          onPointerDown={handleTabPointerDown(tab)}
          style={{ display: "inline-block", width: 100, height: 32 }}
        />
      ))}
    </div>
  );
}

function pointer(type: string, x: number, y: number) {
  window.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

async function render(props: Parameters<typeof Harness>[0]) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
  const strip = node.querySelector<HTMLElement>("[data-tab-strip]");
  if (!strip) throw new Error("strip missing");
  strip.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 40, right: 800, bottom: 40, x: 0, y: 0 }) as DOMRect;
  return [
    ...node.querySelectorAll<HTMLElement>("[data-tab-key]"),
  ] as HTMLElement[];
}

function down(tab: HTMLElement, x = 50, y = 16) {
  return act(async () => {
    tab.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, button: 0 }),
    );
  });
}

describe("useTabDragReorder", () => {
  it("reorders on a horizontal drag inside the strip", async () => {
    const onReorder = vi.fn();
    const [tabA, tabB] = await render({ onReorder });
    tabB.getBoundingClientRect = () =>
      ({ left: 110, top: 0, width: 100, height: 32, right: 210, bottom: 32, x: 110, y: 0 }) as DOMRect;
    document.elementFromPoint = () => tabB;
    await down(tabA);
    await act(async () => pointer("pointermove", 150, 16));
    await act(async () => pointer("pointerup", 150, 16));
    expect(onReorder).toHaveBeenCalledWith("claude/a", "claude/b", true);
  });

  it("hands a drag that leaves the strip downward to the split layer", async () => {
    const onReorder = vi.fn();
    const onDragOut = vi.fn().mockReturnValue(true);
    const [tabA] = await render({ onReorder, onDragOut });
    document.elementFromPoint = () => null;
    await down(tabA);
    await act(async () => pointer("pointermove", 60, 120));
    expect(onDragOut).toHaveBeenCalledTimes(1);
    expect(onDragOut.mock.calls[0][0]).toBe(TAB_A);
    await act(async () => pointer("pointerup", 60, 120));
    // 已交接：既不排序，也不再重复交接。
    expect(onReorder).not.toHaveBeenCalled();
    expect(onDragOut).toHaveBeenCalledTimes(1);
  });

  it("keeps reordering when the drag-out target declines the hand-off", async () => {
    const onReorder = vi.fn();
    const onDragOut = vi.fn().mockReturnValue(false);
    const [tabA, tabB] = await render({ onReorder, onDragOut });
    tabB.getBoundingClientRect = () =>
      ({ left: 110, top: 0, width: 100, height: 32, right: 210, bottom: 32, x: 110, y: 0 }) as DOMRect;
    document.elementFromPoint = () => tabB;
    await down(tabA);
    await act(async () => pointer("pointermove", 60, 120));
    await act(async () => pointer("pointerup", 150, 16));
    expect(onDragOut).toHaveBeenCalled();
    expect(onReorder).toHaveBeenCalledWith("claude/a", "claude/b", true);
  });

  it("ignores presses on the close button", async () => {
    const onReorder = vi.fn();
    const onDragOut = vi.fn().mockReturnValue(true);
    const [tabA] = await render({ onReorder, onDragOut });
    const button = document.createElement("button");
    tabA.append(button);
    await act(async () => {
      button.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 60, clientY: 16, button: 0 }),
      );
    });
    await act(async () => pointer("pointermove", 60, 120));
    await act(async () => pointer("pointerup", 60, 120));
    expect(onDragOut).not.toHaveBeenCalled();
  });
});
