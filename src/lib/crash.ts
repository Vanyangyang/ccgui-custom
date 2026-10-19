import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWeb } from "./transport";

/**
 * Crash capture — guarantees a broken app is explainable instead of a silent
 * white screen. Three producers feed one store:
 *
 *   - the top-level React error boundary (render / lifecycle errors),
 *   - the global `error` / `unhandledrejection` listeners below (async and
 *     event-handler errors React boundaries never see),
 *   - the boot watchdog in index.html (bundle failed to load, or a crash
 *     before React mounted) — it reads the same persisted report.
 *
 * Consumers are `CrashScreen` (full page, React) and the plain-DOM boot
 * fallback in index.html (used when React cannot render at all). Reports are
 * kept in an in-memory ring for diagnostics and mirrored to localStorage so
 * the next launch can explain a crash that happened before React mounted.
 *
 * Not every `window` error is a crash: browsers report their own harmless
 * warnings through the same channel (see BENIGN_ERROR_PREFIXES), and
 * background network requests fail whenever the machine is offline or the
 * host is unreachable (see BENIGN_NETWORK_PREFIXES). Those stop at the ring —
 * recording them is diagnostics, surfacing them is a false alarm.
 */

export type CrashSource = "render" | "error" | "unhandledrejection" | "boot";

export interface CrashReport {
  id: number;
  source: CrashSource;
  message: string;
  stack?: string;
  componentStack?: string;
  time: string;
  appVersion?: string;
  userAgent: string;
  /**
   * Browser noise or an environmental network failure rather than an app
   * breakage: kept in the diagnostics ring, never shown as a crash screen and
   * never mirrored to storage.
   */
  benign?: boolean;
}

/** Same key index.html's boot watchdog reads. Keep in sync. */
export const LAST_CRASH_STORAGE_KEY = "ccgui:last-crash";
const MAX_KEPT = 20;
/** De-dupe a burst of identical errors (e.g. one rejection loop). */
const DEDUPE_WINDOW_MS = 2000;
/**
 * Messages the browser emits on `window` while nothing is actually broken,
 * matched by prefix because the wording varies by engine:
 *
 *   - `ResizeObserver loop ...`: an observer callback changed layout in the
 *     same frame its notifications were being delivered, so the follow-up
 *     notification is dropped. WebKit words it "completed with undelivered
 *     notifications", older Chromium "limit exceeded". The app keeps running;
 *     the underlying layout feedback loop is a performance concern, not a
 *     crash.
 *   - `Script error`: a cross-origin script threw and the browser withheld
 *     the details, leaving nothing actionable to show.
 */
const BENIGN_ERROR_PREFIXES = [
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
  "Script error",
];

/**
 * Environmental network failures — a request that never got a response —
 * worded by the HTTP stacks this app uses:
 *
 *   - `error sending request for url …`: reqwest's Display for connect/DNS/
 *     TLS failures, forwarded verbatim by Rust commands and the updater
 *     plugin. The classic case is the background update check failing while
 *     the machine is offline or GitHub is unreachable.
 *   - `Load failed` / `Failed to fetch` / `NetworkError …`: the webview's
 *     own fetch() rejection wording (WebKit / Chromium / Gecko).
 *
 * A failed request is a condition of the network, not a broken app: every
 * feature that issues one (update check, marketplace, …) surfaces its own
 * failure state, so the global capture records these for diagnostics but
 * never puts up the crash screen.
 */
const BENIGN_NETWORK_PREFIXES = [
  "error sending request for url",
  "Load failed",
  "Failed to fetch",
  "NetworkError when attempting to fetch resource",
];

let seq = 0;
let appVersion: string | undefined;
let reports: CrashReport[] = [];
let latest: CrashReport | null = null;
let lastSignature = "";
let lastSignatureAt = 0;
/** Benign signatures already kept this session, so a repeating warning cannot
 *  crowd real reports out of the ring. */
const keptBenign = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function normalize(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message || error.name || "Error", stack: error.stack };
  }
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

function currentUserAgent(): string {
  return typeof navigator === "undefined" ? "unknown" : navigator.userAgent;
}

/** Cached from bootstrap so reports carry the running version. */
export function setCrashAppVersion(version: string | null | undefined): void {
  if (version) appVersion = version;
}

/**
 * Build a report without publishing it. The React boundary uses this in the
 * static `getDerivedStateFromError`, which must stay side-effect free.
 */
export function createCrashReport(
  source: CrashSource,
  error: unknown,
  componentStack?: string,
): CrashReport {
  const { message, stack } = normalize(error);
  return {
    id: ++seq,
    source,
    message,
    stack,
    componentStack,
    time: new Date().toISOString(),
    appVersion,
    userAgent: currentUserAgent(),
  };
}

function persist(report: CrashReport): void {
  try {
    window.localStorage.setItem(LAST_CRASH_STORAGE_KEY, JSON.stringify(report));
  } catch {
    // Storage disabled/full: the in-memory report still reaches the UI.
  }
}

/**
 * Append to the ring and, for a real crash, mirror the report to storage and
 * wake subscribers. Benign noise returns after the ring: it is kept once per
 * message per session (that it happened is the useful part, not how often) and
 * deliberately skips `persist` so a slow next launch cannot report it as the
 * reason the app failed to start.
 */
function record(report: CrashReport): void {
  const signature = `${report.source}:${report.message}`;

  if (report.benign) {
    if (keptBenign.has(signature)) return;
    keptBenign.add(signature);
    reports = [...reports, report].slice(-MAX_KEPT);
    return;
  }

  const now = Date.now();
  if (signature === lastSignature && now - lastSignatureAt < DEDUPE_WINDOW_MS) return;
  lastSignature = signature;
  lastSignatureAt = now;

  reports = [...reports, report].slice(-MAX_KEPT);
  latest = report;
  persist(report);
  notify();
}

/** Record a report, mirror it to storage, and wake subscribers. */
export function publishCrash(report: CrashReport): void {
  record(report);
}

function isBenignErrorMessage(message: string): boolean {
  return (
    BENIGN_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix)) ||
    BENIGN_NETWORK_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
}

export function reportCrash(
  source: CrashSource,
  error: unknown,
  componentStack?: string,
): CrashReport {
  const report = createCrashReport(source, error, componentStack);
  publishCrash(report);
  return report;
}

/** Latest undismissed crash, or null. Stable ref for useSyncExternalStore. */
export function getCrashSnapshot(): CrashReport | null {
  return latest;
}

export function subscribeCrashes(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** Hide the crash screen without clearing the diagnostic ring. */
export function dismissCrash(): void {
  if (!latest) return;
  latest = null;
  notify();
}

/** Drop the diagnostic ring and dedupe state (user "clear", or test setup). */
export function clearCrashReports(): void {
  reports = [];
  latest = null;
  lastSignature = "";
  lastSignatureAt = 0;
  keptBenign.clear();
  notify();
}

/** All kept reports, oldest first — for diagnostics export. */
export function getCrashReports(): CrashReport[] {
  return reports;
}

export function useCrashReport(): CrashReport | null {
  return useSyncExternalStore(subscribeCrashes, getCrashSnapshot, getCrashSnapshot);
}

/** Human-readable dump for the "copy details" action. */
export function formatCrashReport(report: CrashReport): string {
  const lines = [
    "CC GUI crash report",
    `time:    ${report.time}`,
    `source:  ${report.source}`,
    `version: ${report.appVersion ?? "unknown"}`,
    `message: ${report.message}`,
  ];
  if (report.stack) lines.push("", "stack:", report.stack);
  if (report.componentStack) lines.push("", "component stack:", report.componentStack);
  lines.push("", `userAgent: ${report.userAgent}`);
  return lines.join("\n");
}

let installed = false;

/** Install window-level capture once. Idempotent. */
export function installGlobalCrashHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // One capture path for both global events: classify the message, then flag
  // browser noise and environmental network failures as benign (ring only).
  // The same wording thrown during render is still an app bug — the React
  // boundary reports those itself and never goes through here.
  const capture = (source: CrashSource, raw: unknown) => {
    const report = createCrashReport(source, raw);
    if (isBenignErrorMessage(report.message)) report.benign = true;
    publishCrash(report);
  };

  window.addEventListener("error", (event) => {
    // Resource load failures (img/script) surface as `error` events on the
    // element with no Error object — not app crashes; ignore them.
    if (!event.error && !event.message) return;
    capture("error", event.error ?? event.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    capture("unhandledrejection", event.reason);
  });
}

/** Mark the app as successfully mounted for index.html's boot watchdog. */
export function markAppMounted(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.appMounted = "1";
}

export function isAppMounted(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.appMounted === "1";
}

export function reloadApp(): void {
  window.location.reload();
}

/** Quit the desktop app; no-op affordance on web (caller hides the button). */
export function quitApp(): void {
  if (isWeb) return;
  void getCurrentWindow().destroy().catch(() => {});
}
