import { Component, type ErrorInfo, type ReactNode } from "react";
import { CrashScreen } from "./CrashScreen";
import { isRuntimeSubmissionPaused } from "@/lib/runtime-checkpoint";
import {
  createCrashReport,
  dismissCrash,
  markAppMounted,
  publishCrash,
  useCrashReport,
  type CrashReport,
} from "@/lib/crash";

/**
 * Top-level crash boundary — the app's last line of defence against a silent
 * white screen. It sits above everything in bootstrap.tsx:
 *
 *   - render / lifecycle errors are caught and shown as a full CrashScreen
 *     (the tree below is already unmounted, so this is strictly better than
 *     blank);
 *   - uncaught async / event-handler errors never reach a boundary, so the
 *     healthy branch also mounts CrashHost, which watches the shared crash
 *     store and takes over with the same screen.
 *
 * A successful mount marks the app as up for index.html's boot watchdog, so
 * a crash *before* React renders falls back to the plain-DOM panel there.
 */
export class AppCrashBoundary extends Component<
  { children: ReactNode },
  { report: CrashReport | null }
> {
  override state: { report: CrashReport | null } = { report: null };

  static getDerivedStateFromError(error: unknown): { report: CrashReport } {
    // Must stay side-effect free; componentDidCatch below publishes it.
    return { report: createCrashReport("render", error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    const report = this.state.report ?? createCrashReport("render", error);
    if (info.componentStack) report.componentStack = info.componentStack;
    publishCrash(report);
  }

  override componentDidMount() {
    markAppMounted();
  }

  override render() {
    if (this.state.report) return <CrashScreen report={this.state.report} />;
    return (
      <>
        {this.props.children}
        <CrashHost />
      </>
    );
  }
}

/** Subscribes to global (non-render) crashes and surfaces them full-screen,
 *  dismissible because the tree underneath may still be usable. */
function CrashHost() {
  const report = useCrashReport();
  if (!report || report.source === "render" || report.source === "boot") return null;
  return <CrashScreen report={report} dismissible={!isRuntimeSubmissionPaused()} onDismiss={dismissCrash} />;
}
