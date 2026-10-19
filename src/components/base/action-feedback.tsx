import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import Check from "lucide-react/dist/esm/icons/check";
import { cx } from "@/utils/cx";

/**
 * Shared click feedback for refresh-style action buttons: the action icon
 * spins while the work runs, cross-fades to a green check on success, then
 * fades back. Failures skip the check and snap straight back to idle.
 *
 * Reference implementation: the 变更 panel's refresh button.
 */

export type ActionFeedback = "idle" | "running" | "success";

type IconComponent = ComponentType<{ className?: string }>;

/** One spin lap; mirrors --animate-refresh-spin in theme.css. */
const SPIN_MS = 600;
/** How long the success check stays before reverting to the action icon. */
const SUCCESS_MS = 900;

/** Owns one button's running → success → idle cycle, timers included. */
function useFeedbackCycle({ spin }: { spin: boolean }) {
  const [feedback, setFeedback] = useState<ActionFeedback>("idle");
  const timers = useRef<number[]>([]);
  const mounted = useRef(true);
  // Mutated in place (never reassigned) so the unmount cleanup — which sees
  // the same array — also clears timers scheduled after the first click.
  const clearTimers = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current.length = 0;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  /** Enter `running` and report when the spin started. */
  const begin = useCallback(() => {
    // A click during the success flash restarts the cycle immediately.
    clearTimers();
    setFeedback("running");
    return performance.now();
  }, [clearTimers]);

  /** Leave `running`; a non-failure lands on the check once the spin is up. */
  const settle = useCallback(
    (startedAt: number, failed: boolean) => {
      // An in-flight read can finish after navigation unmounted the button.
      // Cleanup already ran, so never create new timers for that old view.
      if (!mounted.current) return;
      const elapsed = performance.now() - startedAt;
      const delay = spin
        ? // Finish the current lap (and always complete at least one full
          // turn) before swapping icons, so the icon finishes upright.
          elapsed < SPIN_MS
          ? SPIN_MS - elapsed
          : (SPIN_MS - (elapsed % SPIN_MS)) % SPIN_MS
        : 0;
      timers.current.push(
        window.setTimeout(() => {
          setFeedback(failed ? "idle" : "success");
          if (!failed) {
            timers.current.push(
              window.setTimeout(() => setFeedback("idle"), SUCCESS_MS),
            );
          }
        }, delay),
      );
    },
    [spin],
  );

  return { feedback, begin, settle };
}

/**
 * Click-driven feedback for actions that hand back a promise. `isFailure`
 * lets non-throwing actions report failure from state (the returned promise
 * keeps the action's settlement, rejections included, so error plumbing
 * downstream still fires).
 */
export function useActionFeedback({ spin = false }: { spin?: boolean } = {}) {
  const { feedback, begin, settle } = useFeedbackCycle({ spin });

  const start = (
    action: () => Promise<unknown>,
    isFailure?: () => boolean,
  ): Promise<unknown> => {
    const startedAt = begin();
    return action().then(
      (value) => {
        settle(startedAt, isFailure?.() ?? false);
        return value;
      },
      (error: unknown) => {
        settle(startedAt, true);
        throw error;
      },
    );
  };

  return { feedback, start };
}

/**
 * State-driven variant for actions whose in-flight state already lives in a
 * store or parent prop (no click promise to wrap): spins while `running` is
 * true and flashes the check when it falls back to false.
 */
export function useRunningFeedback(running: boolean): ActionFeedback {
  const { feedback, begin, settle } = useFeedbackCycle({ spin: true });
  const startedAt = useRef(0);
  const wasRunning = useRef(false);

  useEffect(() => {
    if (running) {
      if (!wasRunning.current) {
        wasRunning.current = true;
        startedAt.current = begin();
      }
      return;
    }
    // Nothing to flash when no run was observed: mounting idle must not
    // produce a check. A run that starts later gets its own.
    if (!wasRunning.current) return;
    wasRunning.current = false;
    settle(startedAt.current, false);
  }, [running, begin, settle]);

  return feedback;
}

/**
 * Action icon with click feedback: optionally spins while running and
 * cross-fades to a check on success, then fades back. The spin lives on the
 * inner span and the cross-fade on the outer one — a single transform would
 * fight the spin keyframes and snap when the animation class is removed.
 */
export function ActionFeedbackIcon({
  icon: Icon,
  feedback,
  spin = false,
  iconClassName = "size-4",
  runningClassName,
}: {
  icon: IconComponent;
  feedback: ActionFeedback;
  spin?: boolean;
  /** Size classes shared by the wrapper and both icons (default `size-4`). */
  iconClassName?: string;
  /** Extra classes while running, e.g. a brand color for the spinner. */
  runningClassName?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        "relative inline-flex shrink-0 items-center justify-center",
        iconClassName,
      )}
    >
      <span
        className={cx(
          "inline-flex transition-[opacity,transform] duration-150 ease-out",
          feedback === "success" ? "scale-50 opacity-0" : "scale-100 opacity-100",
        )}
      >
        <Icon
          className={cx(
            iconClassName,
            feedback === "running" && runningClassName,
            spin && feedback === "running" && "animate-refresh-spin",
          )}
        />
      </span>
      <Check
        className={cx(
          "absolute text-notification-success-foreground transition-[opacity,transform]",
          iconClassName,
          feedback === "success"
            ? "scale-100 opacity-100 duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            : "scale-50 opacity-0 duration-150 ease-out",
        )}
      />
    </span>
  );
}
