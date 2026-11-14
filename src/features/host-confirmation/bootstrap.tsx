import { Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import i18n from "@/lib/i18n";
import { applyFontPreferences, readCachedFontPreferences } from "@/features/settings/font";
import { HostConfirmation } from "./HostConfirmation";
import type { ConfirmationContent } from "./types";

class ConfirmationBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { queueMicrotask(this.props.onError); }
  render() { return this.state.failed ? <p role="alert">{i18n.t("hostConfirmation.loadError")}</p> : this.props.children; }
}

/** Host-only entry: deliberately excludes App, chat stores and plugin runtime. */
export function startHostConfirmationApp(): () => void {
  let disposed = false;
  let answered = false;
  let affirmativeAttempted = false;
  let inFlight = false;
  let ready = false;
  let root: Root | undefined;
  const respond = async (accepted: boolean) => {
    if (disposed || answered || inFlight || (accepted && affirmativeAttempted)) return;
    if (accepted) affirmativeAttempted = true;
    inFlight = true;
    try {
      await invoke("host_confirmation_respond", { accepted });
      answered = true;
    } finally { inFlight = false; }
  };
  const teardown = (failed: boolean) => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("pagehide", stop);
    // Closing is always a denial. The native one-shot response owns races with
    // an already submitted choice; teardown never sends another affirmative.
    if (!answered) void invoke("host_confirmation_respond", { accepted: false, ...(failed ? { failed: true } : {}) }).catch(() => {});
    root?.unmount();
    if (ready) delete document.documentElement.dataset.appMounted;
  };
  const stop = () => teardown(false);
  window.addEventListener("pagehide", stop);
  if (import.meta.hot) import.meta.hot.dispose(stop);
  const fail = () => { teardown(true); };
  void (async () => {
    applyFontPreferences(readCachedFontPreferences());
    const content = await invoke<ConfirmationContent>("host_confirmation_read");
    if (disposed) return;
    await i18n.changeLanguage(content.language);
    if (disposed) return;
    document.documentElement.classList.toggle("dark", content.dark);
    const element = document.getElementById("root");
    if (!element) throw new Error("Missing confirmation root");
    root = createRoot(element);
    root.render(<ConfirmationBoundary onError={fail}><HostConfirmation content={content} respond={respond} onReady={() => {
      if (disposed || ready) return;
      ready = true;
      // index.html's shared watchdog checks this after 8 seconds. Only mark
      // the actual React commit, not createRoot/render or the native IPC call.
      // Keep this lightweight entry independent of the main crash/chat runtime.
      document.documentElement.dataset.appMounted = "1";
      void invoke("host_confirmation_ready").catch(fail);
    }} /></ConfirmationBoundary>);
  })().catch(fail);
  return stop;
}
