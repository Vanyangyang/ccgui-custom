import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTailPin } from "./use-scroll-follow";

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

describe("tail pin paint ordering", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resize: () => void;
  let following: boolean;
  let height: number;
  let top: number;
  let paintedTops: number[];
  const scrollRef = { current: null as HTMLDivElement | null };
  const isFollowing = () => following;
  const scrollToBottom = () => { top = height - 400; };
  const disconnect = vi.fn();

  function Probe({ count, revision = 0 }: { count: number; revision?: number }) {
    useTailPin({ scrollRef, count, items: [], streaming: true, isFollowing, scrollToBottom });
    useLayoutEffect(() => { paintedTops.push(top); }, [count, revision]);
    return null;
  }

  beforeEach(() => {
    following = true;
    height = 1000;
    top = 0;
    paintedTops = [];
    disconnect.mockClear();
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    container = document.createElement("div");
    root = createRoot(container);
    scrollRef.current = document.createElement("div");
    scrollRef.current.innerHTML = '<div data-virtual-inner></div>';
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("pins appended rows before downstream layout effects see the viewport", () => {
    act(() => root.render(createElement(Probe, { count: 1 })));
    height = 1200;
    act(() => root.render(createElement(Probe, { count: 2 })));
    expect(paintedTops).toEqual([600, 800]);
  });

  it("pins a streaming commit without waiting for another animation frame", () => {
    act(() => root.render(createElement(Probe, { count: 1 })));
    height = 1080;
    act(() => root.render(createElement(Probe, { count: 1, revision: 1 })));
    expect(paintedTops.at(-1)).toBe(680);
  });

  it("corrects late measurements in the resize delivery, not the next paint", () => {
    act(() => root.render(createElement(Probe, { count: 1 })));
    height = 1172;
    act(() => resize());
    expect(top).toBe(772);
  });

  it("leaves history untouched while paused and disconnects on unmount", () => {
    act(() => root.render(createElement(Probe, { count: 1 })));
    following = false;
    top = 200;
    height = 1500;
    act(() => {
      root.render(createElement(Probe, { count: 2 }));
      resize();
    });
    expect(top).toBe(200);
    act(() => root.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
