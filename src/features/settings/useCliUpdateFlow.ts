import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, type CliUpdatePlan } from "@/lib/ipc";
import type { EngineId } from "./providers";
import { readCliUpdateSnapshot, useCliVersionStatus, type CliUpdateSnapshot } from "./useCliVersionStatus";
import i18n from "@/lib/i18n";

export type CliUpdateFlowStatus = "idle" | "planning" | "ready" | "running" | "done" | "error";
export interface CliUpdateLogLine { stream: "stdout" | "stderr"; text: string }
export interface CliUpdateFlowState {
  status: CliUpdateFlowStatus;
  plan: CliUpdatePlan | null;
  error: string | null;
  runId: string | null;
  logs: CliUpdateLogLine[];
}
const IDLE: CliUpdateFlowState = { status: "idle", plan: null, error: null, runId: null, logs: [] };
export interface CliUpdateFlow {
  state: CliUpdateFlowState;
  begin: () => Promise<void>;
  confirm: () => Promise<void>;
  close: () => void;
}

/** Installation belongs to the host. The invoke starts it once; snapshots and
 * sequenced events recover the same attempt after another client or a reconnect. */
export function useCliUpdateFlow(
  engine: EngineId,
  callbacks?: { onSuccess?: () => void; onError?: (message: string) => void },
): CliUpdateFlow {
  const { update, updateSnapshot, reconnectRevision } = useCliVersionStatus(engine);
  const [state, setState] = useState<CliUpdateFlowState>(IDLE);
  const current = useRef(state);
  current.current = state;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const mounted = useRef(true);
  const generation = useRef(0);
  const confirming = useRef(false);
  const confirmGeneration = useRef(0);
  const seenFinishedRun = useRef<string | null>(null);
  const notifiedRun = useRef<string | null>(null);
  const lastSequence = useRef(-1);
  const seenReconnect = useRef(reconnectRevision);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    confirming.current = false;
    confirmGeneration.current += 1;
    seenFinishedRun.current = null;
    notifiedRun.current = null;
    seenReconnect.current = reconnectRevision;
    current.current = IDLE;
    lastSequence.current = -1;
    setState(IDLE);
    return () => { mounted.current = false; generation.current += 1; };
  }, [engine]);

  const notify = useCallback((snapshot: Pick<CliUpdateSnapshot, "runId" | "status" | "error">) => {
    if (!mounted.current || snapshot.status === "running" || notifiedRun.current === snapshot.runId) return;
    notifiedRun.current = snapshot.runId;
    seenFinishedRun.current = snapshot.runId;
    if (snapshot.status === "done") callbacksRef.current?.onSuccess?.();
    else callbacksRef.current?.onError?.(snapshot.error ?? i18n.t("settings.cliUpdateFailed"));
  }, []);

  const restore = useCallback((snapshot: CliUpdateSnapshot, plan?: CliUpdatePlan | null) => {
    if (!mounted.current || snapshot.engine !== engine || snapshot.sequence < lastSequence.current) return;
    lastSequence.current = snapshot.sequence;
    setState((previous) => ({
      status: snapshot.status, plan: plan === undefined ? previous.plan : plan,
      runId: snapshot.runId, logs: snapshot.logs.map(({ stream, text }) => ({ stream, text })), error: snapshot.error,
    }));
    notify(snapshot);
  }, [engine, notify]);

  useEffect(() => {
    if (updateSnapshot && current.current.runId === updateSnapshot.runId && current.current.status !== "idle") restore(updateSnapshot);
  }, [updateSnapshot, restore]);

  useEffect(() => {
    if (seenReconnect.current === reconnectRevision) return;
    seenReconnect.current = reconnectRevision;
    const attempt = current.current;
    if (!attempt.runId || attempt.status !== "running") return;
    // A restarted host has no record of the old attempt. Its absence is an
    // unknown outcome, never success and never permission to resend it.
    if (!updateSnapshot || updateSnapshot.runId !== attempt.runId) {
      const error = i18n.t("settings.cliUpdateOutcomeUnknown");
      setState((cur) => ({ ...cur, status: "error", error }));
      callbacksRef.current?.onError?.(error);
    } else {
      lastSequence.current = -1;
      restore(updateSnapshot);
    }
  }, [reconnectRevision, updateSnapshot, restore]);

  const begin = useCallback(async () => {
    const ticket = ++generation.current;
    const active = () => mounted.current && generation.current === ticket;
    setState({ ...IDLE, status: "planning" });
    try {
      const snapshot = await readCliUpdateSnapshot(engine);
      if (!active()) return;
      if (snapshot && (snapshot.status === "running" || seenFinishedRun.current !== snapshot.runId)) {
        restore(snapshot, null);
        return;
      }
      const plan = await ipc.cliUpdatePlan(engine);
      if (active()) setState({ ...IDLE, status: "ready", plan });
    } catch (error) {
      if (!active()) return;
      const message = error instanceof Error ? error.message : String(error);
      setState({ ...IDLE, status: "error", error: message });
      callbacksRef.current?.onError?.(message);
    }
  }, [engine, restore]);

  const confirm = useCallback(async () => {
    const previous = current.current;
    if (confirming.current || !previous.plan?.canRun || !["ready", "error"].includes(previous.status)) return;
    confirming.current = true;
    const confirmation = ++confirmGeneration.current;
    const ticket = generation.current;
    const active = () => mounted.current && generation.current === ticket;
    let runId: string | null = null;
    try {
      // A different client may have started since this plan was previewed.
      const snapshot = await readCliUpdateSnapshot(engine);
      if (!active()) return;
      if (snapshot?.status === "running") { restore(snapshot); return; }
      runId = `${engine}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      lastSequence.current = snapshot?.sequence ?? -1;
      setState((cur) => ({ ...cur, status: "running", runId, logs: [], error: null }));
      await update(runId);
      if (!active()) return;
      // Only the complete native lifecycle returns a successful result.
      setState((cur) => cur.runId === runId ? { ...cur, status: "done", error: null } : cur);
      notify({ runId, status: "done", error: null });
    } catch (error) {
      if (!active()) return;
      const message = error instanceof Error ? error.message : String(error);
      try {
        const snapshot = await readCliUpdateSnapshot(engine);
        if (!active()) return;
        if (snapshot && (snapshot.runId === runId || snapshot.status === "running")) { restore(snapshot); return; }
      } catch { /* An accepted host run survives transport loss. */ }
      if (!active()) return;
      if (runId && message.includes("web bridge disconnected")) return;
      setState((cur) => ({ ...cur, status: "error", error: message }));
      if (runId) notify({ runId, status: "error", error: message });
      else callbacksRef.current?.onError?.(message);
    } finally {
      if (confirmGeneration.current === confirmation) confirming.current = false;
    }
  }, [engine, update, restore, notify]);

  const close = useCallback(() => {
    if (current.current.status === "running") return;
    generation.current += 1;
    confirmGeneration.current += 1;
    confirming.current = false;
    setState(IDLE);
  }, []);
  return { state, begin, confirm, close };
}
