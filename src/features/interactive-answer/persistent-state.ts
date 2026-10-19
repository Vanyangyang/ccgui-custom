import { answerPersistence, type AnswerPersistence } from "./persistence";
import { cleanAnswerState } from "./state";
import type { AnswerState } from "./protocol";

export type SaveStatus = "loading" | "saved" | "saving" | "loadError" | "saveError" | "conflict" | "localOnly";
export interface StateView { values: AnswerState; ready: boolean; status: SaveStatus; sourceHash: string; generation: number }
type Intent = { values: AnswerState; reset: boolean; revision: number };
const sameValues = (left: AnswerState, right: AnswerState) => {
  const keys = Object.keys(left).sort(), other = Object.keys(right).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && left[key] === right[key]);
};

/** One serialized writer per exact source. Failed intent keeps its original CAS. */
export class PersistentAnswerState {
  private view: StateView;
  private revision = 0;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loading = false;
  private writing = false;
  private pending: Omit<Intent, "revision"> | undefined;
  private failed: Intent | undefined;
  constructor(readonly identity: string | undefined, readonly source: string, private defaults: AnswerState, private api: AnswerPersistence = answerPersistence) {
    this.view = { values: { ...defaults }, ready: !identity, status: identity ? "loading" : "localOnly", sourceHash: "", generation: 0 };
  }
  getSnapshot = (): StateView => this.view;
  private publish(patch: Partial<StateView>) { this.view = { ...this.view, ...patch }; this.listeners.forEach(fn => fn()); }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    void this.load();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearTimeout(this.timer);
        this.timer = undefined;
        // Capture the final edit before virtualization/unmount, against this key only.
        void this.flush();
      }
    };
  };
  async load() {
    if (!this.identity || this.view.ready || this.loading) return;
    this.loading = true;
    this.publish({ status: "loading" });
    try {
      const snapshot = await this.api.read(this.identity, this.source);
      this.revision = snapshot.revision;
      this.publish({ values: cleanAnswerState(snapshot.values, this.defaults), sourceHash: snapshot.sourceHash, ready: true, status: "saved" });
    } catch { this.publish({ status: "loadError" }); }
    finally { this.loading = false; }
  }
  update = (values: Record<string, unknown>, reset = false) => {
    if (!this.view.ready || this.loading) return;
    const cleaned = cleanAnswerState(values, this.defaults);
    if (!reset && JSON.stringify(cleaned) === JSON.stringify(this.view.values)) return;
    this.publish({ values: cleaned, generation: this.view.generation + (reset ? 1 : 0) });
    if (!this.identity) return;
    this.pending = { values: cleaned, reset };
    if (!this.failed) this.publish({ status: "saving" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
  };
  reset = () => this.update(this.defaults, true);
  retry = () => { if (!this.view.ready) void this.load(); else if (this.view.status === "loadError") void this.reloadSaved(); else void this.flush(true); };
  reloadSaved = async () => {
    if (!this.identity || !this.view.ready || this.writing || this.loading) return;
    this.loading = true;
    clearTimeout(this.timer); this.timer = undefined;
    this.publish({ status: "loading" });
    try {
      const saved = await this.api.read(this.identity, this.source);
      this.revision = saved.revision;
      this.failed = undefined; this.pending = undefined;
      this.publish({ values: cleanAnswerState(saved.values, this.defaults), sourceHash: saved.sourceHash,
        status: "saved", generation: this.view.generation + 1 });
    } catch { this.publish({ status: "loadError" }); }
    finally { this.loading = false; }
  };
  private async flush(retry = false) {
    if (!this.identity || !this.view.ready || this.writing || this.loading || (this.failed && !retry)) return;
    const intent = this.failed ?? (this.pending ? { ...this.pending, revision: this.revision } : undefined);
    if (!intent) return;
    if (!this.failed) this.pending = undefined;
    this.failed = undefined;
    this.writing = true;
    const failureStatus = this.view.status;
    let readingRetry = retry;
    this.publish({ status: "saving" });
    try {
      // A transport error can hide a committed write. Verify the exact intent
      // before retrying; never promote a conflicting local value to a fresh CAS.
      let saved = retry ? await this.api.read(this.identity, this.source)
        : await this.api.write(this.identity, this.source, intent.revision, intent.values, intent.reset);
      readingRetry = false;
      if (retry) {
        if (saved.revision === intent.revision) {
          saved = await this.api.write(this.identity, this.source, intent.revision, intent.values, intent.reset);
        } else if (saved.revision < intent.revision || !sameValues(saved.values, intent.values)) {
          throw new Error("interactive_answer_conflict");
        }
      }
      this.revision = saved.revision;
      this.publish({ sourceHash: saved.sourceHash, status: this.pending ? "saving" : "saved" });
    } catch (error) {
      this.failed = intent;
      this.publish({ status: readingRetry && (failureStatus === "conflict" || failureStatus === "saveError") ? failureStatus
        : String(error).includes("interactive_answer_conflict") ? "conflict" : "saveError" });
    } finally {
      this.writing = false;
      if (!this.failed && this.pending) void this.flush();
    }
  }
}

const cache = new Map<string, PersistentAnswerState>();
export function persistentAnswerState(identity: string | undefined, source: string, defaults: AnswerState): PersistentAnswerState {
  if (!identity) return new PersistentAnswerState(undefined, source, defaults);
  const key = JSON.stringify([identity, source]);
  const state = cache.get(key) ?? new PersistentAnswerState(identity, source, defaults);
  cache.delete(key);
  cache.set(key, state);
  while (cache.size > 128) cache.delete(cache.keys().next().value!);
  return state;
}
