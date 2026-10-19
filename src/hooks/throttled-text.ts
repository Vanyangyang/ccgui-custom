/** Short replies can be parsed more often; large documents need breathing
 * room for input, layout and reveal frames between full Markdown parses. */
export function streamParseInterval(length: number): number {
  return length <= 4000 ? 32 : length <= 16000 ? 64 : 128;
}

/** A live commit competes with the reveal frames for the main thread: at
 * 200 tok/s the base cadence asks for 30 full-document parses per second, and
 * a parse that overruns the frame budget starves presentation (the text then
 * lands in uneven chunks). A commit that costs more than the base interval
 * gets proportionally more room next time — a bounded backoff that keeps the
 * parse pipeline near half the wall clock instead of as fast as possible. */
export function nextParseInterval(base: number, commitMs: number): number {
  if (!(commitMs > 0)) return base;
  return Math.min(160, Math.max(base, Math.round(commitMs * 2)));
}

export interface ThrottleClock {
  now(): number;
  timeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}
const browserClock: ThrottleClock = {
  now: () => performance.now(),
  timeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: id => clearTimeout(id),
};

/** Committed input and displayed text have a single owner. Timers publish the
 * latest input, never a captured older React state update. */
export class ThrottledText {
  private input: string;
  private visible: string;
  private lastEmit: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private clock: ThrottleClock;
  private listeners = new Set<() => void>();
  constructor(value: string, clock: ThrottleClock = browserClock) {
    this.input = this.visible = value;
    this.clock = clock;
    this.lastEmit = clock.now();
  }
  read = () => this.visible;
  subscribe = (notify: () => void) => {
    this.listeners.add(notify);
    return () => { this.listeners.delete(notify); };
  };
  bypass(value: string, interval: number) {
    return interval <= 0 || !value.startsWith(this.input);
  }
  update(value: string, interval: number) {
    const immediate = this.bypass(value, interval);
    this.input = value;
    this.cancel();
    if (value === this.visible) return;
    const wait = interval - (this.clock.now() - this.lastEmit);
    if (immediate || wait <= 0) this.publish();
    else this.timer = this.clock.timeout(() => {
      this.timer = undefined;
      this.publish();
    }, wait);
  }
  private publish() {
    this.lastEmit = this.clock.now();
    if (this.visible === this.input) return;
    this.visible = this.input;
    for (const notify of this.listeners) notify();
  }
  cancel() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
