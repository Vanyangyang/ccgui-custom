import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusComposerWhenVisible } from "./focus-composer";

/**
 * 切回聊天中心面后聚焦输入框的助手。中心面用 visibility:hidden 切换，隐藏
 * 元素上的 focus() 会被浏览器静默忽略；jsdom 不模拟这一点，所以用一个受控的
 * focus() 模拟「前若干帧还在隐藏面里」，锁住「时间窗内重试 + 拿到焦点即停」。
 */
const frames: FrameRequestCallback[] = [];

function flushFrame() {
  const pending = frames.splice(0, frames.length);
  pending.forEach((cb) => cb(0));
}

let editable: HTMLDivElement;

function makeRef(focus: () => void) {
  return { current: { focus } };
}

beforeEach(() => {
  frames.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  editable = document.createElement("div");
  // jsdom 不实现 contentEditable（连属性都不反射），而真实浏览器里 React 会
  // 渲染 `contenteditable="true"`，所以测试自己把属性写上去。
  editable.setAttribute("contenteditable", "true");
  editable.tabIndex = 0;
  document.body.appendChild(editable);
});

afterEach(() => {
  vi.unstubAllGlobals();
  editable.remove();
});

describe("focusComposerWhenVisible", () => {
  it("retries until the hidden surface becomes visible, then stops", () => {
    let visible = false;
    focusComposerWhenVisible(makeRef(() => (visible ? editable.focus() : undefined)) as never);

    flushFrame();
    expect(document.activeElement).not.toBe(editable);

    // 中心面切回来了（实测 ~250ms，这里第 2 帧）：下一次尝试就该拿到焦点。
    visible = true;
    flushFrame();
    expect(document.activeElement).toBe(editable);

    // 已聚焦 → 不再排新的帧（不持续抢焦点）。
    expect(frames.length).toBe(0);
  });

  it("stops as soon as a visible field has focus, so a deliberate click is not stolen", () => {
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();

    const focus = vi.fn(() => editable.focus());
    focusComposerWhenVisible(makeRef(focus) as never);
    flushFrame();

    expect(document.activeElement).toBe(other);
    expect(focus).not.toHaveBeenCalled();
    expect(frames.length).toBe(0);
    other.remove();
  });

  it("still focuses when the only focused field is inside a hidden surface", () => {
    // 被盖住的文件编辑器可能还占着 activeElement：那不是用户意图，也不该
    // 阻止 composer 拿到光标。
    const hiddenSurface = document.createElement("div");
    hiddenSurface.className = "invisible";
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.tabIndex = 0;
    hiddenSurface.appendChild(editor);
    document.body.appendChild(hiddenSurface);
    editor.focus();

    focusComposerWhenVisible(makeRef(() => editable.focus()) as never);
    flushFrame();

    expect(document.activeElement).toBe(editable);
    hiddenSurface.remove();
  });

  it("gives up after the time window instead of looping forever", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    focusComposerWhenVisible(makeRef(() => {}) as never, 50);
    flushFrame();
    // 时间窗耗尽：下一帧不再排。
    now.mockReturnValue(1000);
    flushFrame();
    expect(frames.length).toBe(0);
    now.mockRestore();
  });
});
