import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_BANNER_AUTO_DISMISS_MS, ErrorBanner } from "./ErrorBanner";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ErrorBanner", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("auto-dismisses after ERROR_BANNER_AUTO_DISMISS_MS when left untouched", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(<ErrorBanner message="Request timed out" onDismiss={onDismiss} />);
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Request timed out");
    act(() => {
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not reset the countdown when re-rendered with a fresh onDismiss closure", () => {
    const firstDismiss = vi.fn();
    const latestDismiss = vi.fn();
    act(() => {
      root.render(<ErrorBanner message="Transient failure" onDismiss={() => firstDismiss()} />);
    });

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    act(() => {
      root.render(<ErrorBanner message="Transient failure" onDismiss={() => latestDismiss()} />);
    });

    act(() => {
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS - 3_000);
    });
    expect(firstDismiss).not.toHaveBeenCalled();
    expect(latestDismiss).toHaveBeenCalledTimes(1);
  });

  it("resets the countdown when the error message changes", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(<ErrorBanner message="First error" onDismiss={onDismiss} />);
    });

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    act(() => {
      root.render(<ErrorBanner message="Second error" onDismiss={onDismiss} />);
    });

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("pauses auto-dismiss while hovered or focused and resumes after leaving", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(<ErrorBanner message="Copyable error detail" onDismiss={onDismiss} />);
    });

    const alert = host.querySelector<HTMLElement>('[role="alert"]')!;
    const textSpan = alert.querySelector<HTMLElement>("span[tabindex='0']")!;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    act(() => {
      alert.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      alert.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      textSpan.focus();
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      textSpan.blur();
    });
    act(() => {
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("clears the timer on unmount", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(<ErrorBanner message="Unmounting error" onDismiss={onDismiss} />);
    });

    act(() => {
      root.unmount();
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS * 2);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
