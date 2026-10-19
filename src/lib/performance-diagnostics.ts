const COUNTERS = ["engineEvents", "toolEvents", "textEvents"] as const;
const DURATIONS = ["engineBatch", "liveRenderCommit", "eventLoopLag", "longTask"] as const;
const RETENTION_MS = 300_000;

type Counter = typeof COUNTERS[number];
type Duration = typeof DURATIONS[number];
type DurationSummary = { count: number; totalMs: number; maxMs: number };
type Totals = {
  counters: Partial<Record<Counter, number>>;
  durations: Partial<Record<Duration, DurationSummary>>;
};
export type PerformanceContext = {
  sessions: number;
  messages: number;
  streaming: number;
  activeMessages?: number;
  liveTextUnits?: number;
  liveThinkingUnits?: number;
  timelineMounted?: number;
  mountedProcessItems?: number;
};
type RendererSample = Totals & { at: number; hidden: boolean; contextAvailable: boolean; context: PerformanceContext };

function finite(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function copyTotals(totals: Totals): Totals {
  return {
    counters: { ...totals.counters },
    durations: Object.fromEntries(Object.entries(totals.durations).map(([key, value]) => [key, { ...value }])),
  };
}

export class PerformanceRecorder {
  private enabled = true;
  private samples: RendererSample[] = [];
  private totals: Totals = { counters: {}, durations: {} };
  private previousBeat: { at: number; hidden: boolean } | null = null;
  readonly startedAt = Date.now();

  constructor(private capacity = 60, private heartbeatMs = 1000) {}

  isEnabled() { return this.enabled; }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.previousBeat = null;
    if (!enabled) {
      this.samples = [];
      this.totals = { counters: {}, durations: {} };
    }
  }

  count(key: Counter, amount: number) {
    if (!this.enabled || !COUNTERS.includes(key) || !finite(amount)) return;
    this.totals.counters[key] = (this.totals.counters[key] ?? 0) + amount;
  }

  duration(key: Duration, milliseconds: number) {
    if (!this.enabled || !DURATIONS.includes(key) || !finite(milliseconds)) return;
    const summary = this.totals.durations[key] ?? { count: 0, totalMs: 0, maxMs: 0 };
    summary.count += 1;
    summary.totalMs += milliseconds;
    summary.maxMs = Math.max(summary.maxMs, milliseconds);
    this.totals.durations[key] = summary;
  }

  heartbeat(at: number, hidden: boolean) {
    if (!this.enabled) return;
    if (this.previousBeat && !hidden && !this.previousBeat.hidden) {
      this.duration("eventLoopLag", Math.max(0, at - this.previousBeat.at - this.heartbeatMs));
    }
    this.previousBeat = { at, hidden };
  }

  sample(at: number, hidden: boolean, context?: PerformanceContext) {
    if (!this.enabled) return;
    const numeric = (value: number | undefined) => value !== undefined && finite(value) ? value : 0;
    this.samples.push({
      at, hidden, ...this.totals,
      contextAvailable: context !== undefined && [context.sessions, context.messages, context.streaming].every(finite),
      context: {
        sessions: numeric(context?.sessions), messages: numeric(context?.messages), streaming: numeric(context?.streaming),
        activeMessages: numeric(context?.activeMessages),
        liveTextUnits: numeric(context?.liveTextUnits),
        liveThinkingUnits: numeric(context?.liveThinkingUnits),
        timelineMounted: numeric(context?.timelineMounted),
        mountedProcessItems: numeric(context?.mountedProcessItems),
      },
    });
    this.samples = this.samples.filter((sample) => at - sample.at < RETENTION_MS);
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
    this.totals = { counters: {}, durations: {} };
  }

  snapshot() {
    return {
      scope: "this-window" as const,
      enabled: this.enabled,
      startedAt: this.startedAt,
      sampleIntervalMs: 5000,
      capacity: this.capacity,
      retentionMs: RETENTION_MS,
      samples: this.samples.filter((sample) => Date.now() - sample.at < RETENTION_MS)
        .map((sample) => ({ ...sample, context: { ...sample.context }, ...copyTotals(sample) })),
      pending: copyTotals(this.totals),
    };
  }
}

export const performanceRecorder = new PerformanceRecorder();
