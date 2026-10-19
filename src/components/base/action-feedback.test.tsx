import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import {
  ActionFeedbackIcon,
  useActionFeedback,
  useRunningFeedback,
} from "./action-feedback";

// React 18's act() requires this flag to be set by the test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Click-driven harness: a button whose icon runs the shared cycle. */
function ClickButton({
  action,
  isFailure,
}: {
  action: () => Promise<unknown>;
  isFailure?: () => boolean;
}) {
  const { feedback, start } = useActionFeedback({ spin: true });
  return (
    <button
      type="button"
      // Call sites hand the promise to their own error plumbing; the harness
      // only needs the feedback, so the rejection is swallowed here.
      onClick={() => void start(action, isFailure).catch(() => undefined)}
    >
      <ActionFeedbackIcon icon={RefreshCw} feedback={feedback} spin />
    </button>
  );
}

/** Store/prop-driven harness: the in-flight flag arrives from outside. */
function RunningIcon({ running }: { running: boolean }) {
  return (
    <ActionFeedbackIcon icon={RefreshCw} feedback={useRunningFeedback(running)} spin />
  );
}

describe("action feedback", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
    }
    container.remove();
    vi.useRealTimers();
  });

  async function render(node: React.ReactNode) {
    const nextRoot = createRoot(container);
    root = nextRoot;
    await act(async () => {
      nextRoot.render(node);
    });
  }

  const spinning = () => container.querySelector(".animate-refresh-spin");
  const visibleCheck = () => container.querySelector(".lucide-check.opacity-100");
  const click = () => act(() => container.querySelector("button")!.click());

  function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("spins while a click action runs, checks, then returns to the icon", async () => {
    const pending = deferred();
    await render(<ClickButton action={() => pending.promise} />);

    click();
    expect(spinning()).not.toBeNull();
    expect(visibleCheck()).toBeNull();

    // The check waits out the rest of the lap so the icon lands upright.
    await act(async () => pending.resolve());
    act(() => vi.advanceTimersByTime(500));
    expect(visibleCheck()).toBeNull();
    expect(spinning()).not.toBeNull();

    act(() => vi.advanceTimersByTime(200));
    expect(visibleCheck()).not.toBeNull();
    expect(spinning()).toBeNull();

    act(() => vi.advanceTimersByTime(1000));
    expect(visibleCheck()).toBeNull();
    expect(container.querySelector(".lucide-refresh-cw")).not.toBeNull();
  });

  it("skips the check when the action rejects", async () => {
    const rejected = deferred();
    await render(<ClickButton action={() => rejected.promise} />);

    click();
    await act(async () => rejected.reject(new Error("boom")));
    act(() => vi.advanceTimersByTime(2000));
    expect(visibleCheck()).toBeNull();
    expect(spinning()).toBeNull();
    expect(container.querySelector(".lucide-refresh-cw")).not.toBeNull();
  });

  it("lets a non-throwing action report failure through isFailure", async () => {
    let failed = true;
    await render(
      <ClickButton action={() => Promise.resolve()} isFailure={() => failed} />,
    );

    click();
    await act(async () => undefined);
    act(() => vi.advanceTimersByTime(2000));
    expect(visibleCheck()).toBeNull();

    failed = false;
    click();
    await act(async () => undefined);
    act(() => vi.advanceTimersByTime(700));
    expect(visibleCheck()).not.toBeNull();
  });

  it("mounts idle without a check and flashes once a run completes", async () => {
    await render(<RunningIcon running={false} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(visibleCheck()).toBeNull();

    await act(async () => root!.render(<RunningIcon running />));
    expect(spinning()).not.toBeNull();
    expect(visibleCheck()).toBeNull();

    await act(async () => root!.render(<RunningIcon running={false} />));
    act(() => vi.advanceTimersByTime(700));
    expect(visibleCheck()).not.toBeNull();
    expect(spinning()).toBeNull();

    act(() => vi.advanceTimersByTime(1000));
    expect(visibleCheck()).toBeNull();
  });

  it("drops pending timers when the button unmounts mid-cycle", async () => {
    const pending = deferred();
    await render(<ClickButton action={() => pending.promise} />);

    click();
    await act(async () => pending.resolve());
    // Timers scheduled after the click (the lap + the check dwell) must not
    // survive the unmount.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => root!.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = null;
  });

  it.each(["resolve", "reject"] as const)(
    "does not recreate feedback timers when an action %s after unmount",
    async (outcome) => {
      const pending = deferred();
      await render(<ClickButton action={() => pending.promise} />);
      click();
      await act(async () => root!.unmount());
      root = null;
      expect(vi.getTimerCount()).toBe(0);

      await act(async () => {
        if (outcome === "resolve") pending.resolve();
        else pending.reject(new Error("late failure"));
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
