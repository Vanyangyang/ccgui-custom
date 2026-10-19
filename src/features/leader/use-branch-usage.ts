import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { SessionState } from "@/features/chat/store";
import type { LeaderBranch } from "./types";
import type { LeaderUsageSample } from "./branch-health";

const HISTORY_PAGE_SIZE = 100;
const MAX_READINGS = 128;
const MAX_CONCURRENT_READS = 4;
const keyFor = (branch: LeaderBranch) => JSON.stringify([branch.engine, branch.sessionId, branch.workspacePath]);
interface Reading {
  branch: LeaderBranch;
  fingerprint: string;
  sample?: LeaderUsageSample | null;
  readFailed: boolean;
  ready: boolean;
  pending: boolean;
}

/** A panel owns one bounded reader. It never hydrates chat state or opens tabs. */
class BranchUsageReader {
  entries = new Map<string, Reading>();
  private running = 0;
  private paused = true;
  private waiters: Array<() => void> = [];
  constructor(private changed: () => void) {}

  reconcile(branches: LeaderBranch[], bySession: Record<string, SessionState>) {
    const next = new Map<string, Reading>();
    for (const branch of branches.slice(0, MAX_READINGS)) {
      if (!branch.sessionId || !["claude", "codex"].includes(branch.engine)) continue;
      const session = bySession[`${branch.engine}/${branch.sessionId}`];
      const busy = session?.streaming || ["starting", "running", "reclaiming"].includes(branch.state);
      // Deltas and checkpoint deadline updates must not re-read the file.
      // Re-read on a new run, settle/state transition, or subsequent idle activity.
      const fingerprint = JSON.stringify([branch.runId, branch.state, !!session?.streaming, busy ? 0 : branch.lastActivityAt]);
      const key = keyFor(branch), previous = this.entries.get(key);
      next.set(key, previous?.fingerprint === fingerprint ? previous : { branch, fingerprint, ready: false, pending: false, readFailed: false });
    }
    this.entries = next;
    if (!this.paused) this.changed();
    this.pump();
  }

  private pump() {
    if (this.paused) return;
    while (this.running < MAX_CONCURRENT_READS) {
      const candidate = [...this.entries].find(([, entry]) => !entry.ready && !entry.pending);
      if (!candidate) break;
      const [key, entry] = candidate;
      entry.pending = true; this.running += 1;
      void ipc.loadSessionPage(entry.branch.engine, entry.branch.sessionId!, HISTORY_PAGE_SIZE)
        .then((page) => {
          // Explicit null/false/0 is an unknown latest snapshot, not an
          // unreported row. It must replace older occupancy rather than skip it.
          const latest = [...page.messages].reverse().find((message) => message.usage !== undefined);
          return { sample: latest ? { usage: latest.usage, model: latest.model, fetchedAt: Date.now() } : null, readFailed: false };
        })
        .catch(() => ({ sample: null, readFailed: true }))
        .then(({ sample, readFailed }) => {
          if (this.entries.get(key) === entry) {
            entry.sample = sample; entry.readFailed = readFailed; entry.ready = true; entry.pending = false;
            if (!this.paused) this.changed();
          }
          this.running -= 1;
          this.pump();
          if (this.running === 0) this.waiters.splice(0).forEach((resolve) => resolve());
        });
    }
  }

  refresh() {
    for (const [key, entry] of this.entries) this.entries.set(key, { ...entry, ready: false, pending: false });
    this.pump();
    return this.running ? new Promise<void>((resolve) => this.waiters.push(resolve)) : Promise.resolve();
  }
  resume() { this.paused = false; this.pump(); this.changed(); }
  // Keep in-flight ownership during React StrictMode's setup/cleanup/setup.
  // A final unmount stops queued reads and ignores late React updates; its
  // bounded samples are released with the hook after pending IPC settles.
  pause() { this.paused = true; this.waiters.splice(0).forEach((resolve) => resolve()); }
}

export function useBranchUsage(branches: LeaderBranch[], bySession: Record<string, SessionState>) {
  const [, rerender] = useState(0);
  const reader = useRef<BranchUsageReader>();
  if (!reader.current) reader.current = new BranchUsageReader(() => rerender((value) => value + 1));
  // Only this signature drives reads. Streaming text does not enter it.
  const signature = JSON.stringify(branches.map((branch) => {
    const session = branch.sessionId ? bySession[`${branch.engine}/${branch.sessionId}`] : undefined;
    const busy = session?.streaming || ["starting", "running", "reclaiming"].includes(branch.state);
    return [keyFor(branch), branch.runId, branch.state, !!session?.streaming, busy ? 0 : branch.lastActivityAt];
  }));
  useEffect(() => { reader.current!.reconcile(branches, bySession); }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reader.current!.resume(); return () => reader.current!.pause(); }, []);
  const refresh = useCallback(() => reader.current!.refresh(), []);
  return {
    sampleFor: (branch: LeaderBranch) => reader.current!.entries.get(keyFor(branch))?.sample,
    readFailedFor: (branch: LeaderBranch) => reader.current!.entries.get(keyFor(branch))?.readFailed === true,
    hasReadFailure: () => [...reader.current!.entries.values()].some((entry) => entry.readFailed),
    refresh,
  };
}
