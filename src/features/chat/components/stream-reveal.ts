/** Presentation-only cursor: stored messages always retain the complete text.
 *
 * The cursor is anchored to the TAIL of the text — a `holdback` of trailing
 * characters still hidden — instead of an absolute prefix index. Markdown
 * re-parsing rewrites the rendered text constantly (syntax markers are
 * consumed: `# `, `- `, backticks, `**`, link targets), so a prefix cursor
 * had to reset whenever the text changed shape, and at high token rates that
 * reset dumped the whole unrevealed backlog in a single frame (measured:
 * 20–62 chars/frame at 200 tok/s, up to 140 at 400 tok/s; only ≤15 at
 * 40 tok/s, which is why slow streams never showed it).
 *
 * The holdback is drained linearly so everything received is on screen by
 * `REVEAL_MAX_LAG_MS`: a provider burst (OMP writes ~100 characters every
 * ~144ms at 200 tok/s) is spread across the frames of its own arrival
 * cadence, and continuous output advances at the arrival rate with a bounded
 * lag. Done/hidden/reduced-motion paths bypass the animation entirely.
 */
export interface RevealClock {
  now(): number;
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  timeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}
const browserClock: RevealClock = {
  now: () => performance.now(),
  frame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id),
  timeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: id => clearTimeout(id),
};

/** Upper bound on how long received text may stay hidden. Every burst is
 *  drained by this deadline, so the display never lags more than this. */
export const REVEAL_MAX_LAG_MS = 240;
/** Shortest spread for one burst: below this the drain reads as a jump, not
 *  as flowing text (the old fixed 80ms drain is the floor, not the rule). */
const MIN_LAG_MS = 80;
/** A backlog this large is a wholesale dump (tab restore, session switch,
 *  first paint of a long snapshot), not a stream: show it at once instead of
 *  animating for seconds. */
const MAX_HOLDBACK = 600;
/** No frame for this long means rAF is suspended (occluded window, background
 *  tab): settle rather than leaving text half-revealed behind the scenes. */
const STALL_MS = 100;

/** A wholesale swap shares almost nothing with what came before: replaying a
 *  different message character by character is not "smooth", it is wrong.
 *  Only the head can diverge during markdown re-parsing (a construct at the
 *  start of the text completing), so a generous head threshold is enough. */
function isReplacement(previous: string, next: string): boolean {
  if (!previous || !next) return false;
  const limit = Math.min(previous.length, next.length);
  let common = 0;
  while (common < limit && previous[common] === next[common]) common += 1;
  return common < Math.min(24, limit * 0.5);
}

export class StreamReveal {
  private text = "";
  /** Published visible prefix of `text`; Infinity = historical instance that
   *  has not received a live update yet (everything is already visible). */
  private visible: number;
  /** Trailing characters already rendered but not published yet. */
  private holdback = 0;
  /** Wall-clock time by which the current holdback must be fully revealed. */
  private deadline = 0;
  /** Measured arrival: cadence (ms between text changes) and rate (characters
   *  per ms). A burst is spread over the cadence that produced it, so the
   *  drain finishes as the next burst lands instead of leaving the text
   *  frozen in between; a rate-matching drain keeps a long fast stream from
   *  accumulating unbounded lag. */
  private cadence = 80;
  private rate = 0;
  private lastArrival: number | undefined;
  private frame: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastTick = 0;
  private listeners = new Set<{ start: number; end: number; notify: () => void }>();
  private clock: RevealClock;
  constructor(live: boolean, clock: RevealClock = browserClock) {
    this.clock = clock;
    this.visible = live ? 0 : Infinity;
  }
  read(start: number, length: number) {
    return Math.max(0, Math.min(length, this.visible - start));
  }
  subscribe(start: number, length: number, notify: () => void) {
    const listener = { start, end: start + length, notify };
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(next: number) {
    const previous = this.visible;
    this.visible = next;
    if (next === previous) return;
    for (const listener of this.listeners) {
      if (next < previous || (listener.end > previous && listener.start < next)) listener.notify();
    }
  }
  update(text: string, animate: boolean) {
    if (text === this.text) {
      if (!animate) {
        this.finish();
        return;
      }
      // A pending drain must survive a cancelled frame loop (effect cleanup on
      // HMR/Fast Refresh, StrictMode's double effect, a remount that keeps the
      // controller). Re-arm it without moving the deadline, so an unchanged
      // snapshot can never leave half-revealed text on screen.
      if (this.holdback > 0) this.run(this.clock.now());
      return;
    }
    const now = this.clock.now();
    const previous = this.text;
    this.text = text;
    if (!animate || this.visible === Infinity || isReplacement(previous, text)) {
      this.finish();
      return;
    }
    // The rendered text may change shape without being a literal extension
    // (markdown consumed `**`, `# `, a link target…). The new characters are
    // what needs revealing — not the whole snapshot — so track the cursor
    // relative to the end and let a reshape move it with the text.
    const gained = text.length - previous.length;
    this.holdback = Math.max(0, this.holdback + gained);
    if (this.holdback > MAX_HOLDBACK) {
      this.finish();
      return;
    }
    if (gained > 0 && this.lastArrival !== undefined) {
      const gap = now - this.lastArrival;
      // Sub-frame gaps are part of one provider batch, not a cadence.
      if (gap >= 16) {
        this.cadence = this.cadence * 0.5 + Math.min(gap, 220) * 0.5;
        this.rate = this.rate > 0 ? this.rate * 0.5 + (gained / gap) * 0.5 : gained / gap;
      }
    }
    this.lastArrival = now;
    // Text may only be pulled back by text that actually disappeared.
    if (this.text.length < this.visible) this.publish(this.text.length);
    if (this.holdback <= 0) {
      this.cancel();
      return;
    }
    // Never drain faster than the arrival cadence (that would empty the queue
    // and stall between bursts) nor faster than the measured rate can feed
    // (that would burn the whole burst in one frame); both are bounded by
    // MAX_LAG so the display never lags more than that.
    const spread = this.rate > 0
      ? Math.max(this.cadence * 1.1, this.holdback / this.rate)
      : REVEAL_MAX_LAG_MS;
    this.deadline = now + Math.min(REVEAL_MAX_LAG_MS, Math.max(MIN_LAG_MS, spread));
    this.run(now);
  }
  /** Start (or keep) the single drain loop plus its stalled-frame watchdog.
   *  One continuous loop per burst beats restarting an animation per commit:
   *  restarts recompute the pacing and produce uneven steps. */
  private run(now: number) {
    if (this.frame === undefined) {
      this.lastTick = now;
      this.frame = this.clock.frame(() => this.tick());
    }
    if (this.timer === undefined) {
      const watchdog = () => {
        this.timer = undefined;
        const idle = this.clock.now() - this.lastTick;
        if (idle >= STALL_MS) {
          this.finish();
          return;
        }
        this.timer = this.clock.timeout(watchdog, STALL_MS - idle);
      };
      this.timer = this.clock.timeout(watchdog, STALL_MS);
    }
  }
  /** Drain at the rate that clears the holdback exactly at `deadline`. The
   *  release is fractional, so a small burst still lands one character at a
   *  time over its whole cadence instead of emptying the queue in one frame. */
  private tick() {
    this.frame = undefined;
    const now = this.clock.now();
    const remaining = this.deadline - now;
    if (this.holdback <= 0.5 || remaining <= 0) {
      this.holdback = 0;
      this.publish(this.text.length);
      this.cancel();
      return;
    }
    const dt = Math.max(0, Math.min(now - this.lastTick, remaining));
    this.lastTick = now;
    this.holdback = Math.max(0, this.holdback - (this.holdback * dt) / remaining);
    // Never step backwards inside the loop; only shrinking text may do that
    // (handled by update()).
    const target = this.text.length - Math.round(this.holdback);
    if (target > this.visible) this.publish(target);
    this.frame = this.clock.frame(() => this.tick());
  }
  finish() {
    this.cancel();
    this.holdback = 0;
    this.publish(this.text.length);
  }
  cancel() {
    if (this.frame !== undefined) this.clock.cancelFrame(this.frame);
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.frame = undefined;
    this.timer = undefined;
  }
}

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
/** Never show half an emoji, combining sequence, or surrogate pair. */
export function visiblePrefix(text: string, count: number) {
  return createVisibleTextReader(text).prefix(count);
}

/** Window follows the revealed cursor, not the received tail, so a large
 * thinking chunk cannot hide all content while the cursor catches up. */
export function visibleWindow(text: string, count: number, limit: number) {
  return createVisibleTextReader(text).window(count, limit);
}

/** Same contract as `visibleWindow`, but the window starts on a LINE boundary.
 * Pre-wrapped thinking text re-wraps when its first character changes, so a
 * character cut makes the whole paragraph shift; dropping whole rows keeps
 * the block's line count stable while the cursor drains a burst. */
export function visibleLineWindow(text: string, count: number, limit: number) {
  return createVisibleTextReader(text).lineWindow(count, limit);
}

/** One segmentation handle per text snapshot, shared by all reveal frames.
 * In particular, long thinking text must not recreate both full-text and
 * prefix segmentation handles on every frame. Boundaries still use the
 * platform grapheme algorithm, including joined emoji and combining marks. */
export function createVisibleTextReader(text: string) {
  let segments: ReturnType<Intl.Segmenter["segment"]> | undefined;
  const boundary = (count: number) => {
    if (count >= text.length) return text.length;
    if (count <= 0) return 0;
    segments ??= segmenter?.segment(text);
    return segments?.containing?.(count)?.index ?? text.length;
  };
  return {
    prefix: (count: number) => text.slice(0, boundary(count)),
    window(count: number, limit: number) {
      const end = boundary(count);
      if (end <= limit) return text.slice(0, end);
      const start = boundary(end - limit);
      // Without grapheme support, show complete text rather than split emoji.
      return text.slice(start > end - limit ? 0 : start, end);
    },
    lineWindow(count: number, limit: number): { text: string; truncated: boolean } {
      const end = boundary(count);
      if (end <= limit) return { text: text.slice(0, end), truncated: false };
      const cut = end - limit;
      const newline = text.indexOf("\n", cut);
      // No line boundary inside the window (one enormous line) or the only
      // newline after the cut is past the revealed cursor: fall back to a
      // grapheme-safe character cut — there is no row to drop as a whole.
      const start = newline === -1 || newline >= end ? boundary(cut) : newline + 1;
      return { text: text.slice(start, end), truncated: true };
    },
  };
}
