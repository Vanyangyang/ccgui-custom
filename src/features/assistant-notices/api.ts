import { invoke, isWeb, listen } from "@/lib/transport";
import { useEffect, useRef, useState } from "react";
import type { AutoTitleModel } from "@/lib/ipc";
import type { AssistantNotice, AssistantNoticeDisplay, AssistantNoticesConfig, AssistantNoticesStatus, CompletionAudioSettings, CompletionAudioView, CompletionAudioVoice } from "./types";

export { isWeb };
function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isWeb) return Promise.reject(new Error("Desktop only"));
  return invoke<T>(command, args);
}

export const assistantNotices = {
  models: () => native<AutoTitleModel[]>("assistant_notices_models"),
  status: () => native<AssistantNoticesStatus>("assistant_notices_status"),
  configure: (config: AssistantNoticesConfig, expectedRevision: number) => native<AssistantNoticesStatus>("assistant_notices_configure", { config, expectedRevision }),
  displays: () => native<AssistantNoticeDisplay[]>("assistant_notices_displays"),
  audioSettings: () => native<CompletionAudioView>("assistant_notices_audio_settings"),
  configureAudio: (settings: CompletionAudioSettings, expectedRevision: number) => native<CompletionAudioView>("assistant_notices_audio_configure", { settings, expectedRevision }),
  audioVoices: () => native<CompletionAudioVoice[]>("assistant_notices_audio_voices"),
  previewAudio: (engine: string, settings: CompletionAudioSettings) => native<void>("assistant_notices_audio_preview", { engine, settings }),
  list: () => native<AssistantNotice[]>("assistant_notices_list"),
  history: () => native<AssistantNotice[]>("assistant_notices_history", { limit: 10 }),
  read: (id: string) => native<boolean>("assistant_notices_read", { id }),
  pin: (id: string, pinned: boolean) => native<boolean>("assistant_notices_pin", { id, pinned }),
  open: (id: string, action: "open" | "draft") => native<void>("assistant_notices_open", { id, action }),
  hold: (id: string, held: boolean) => native<void>("assistant_notices_hold", { id, held }),
  drag: () => native<void>("assistant_notices_drag"),
  pointer: (interactive: boolean) => native<void>("assistant_notices_pointer", { interactive }),
  size: (height: number) => native<void>("assistant_notices_size", { height }),
  changed: (callback: () => void) => isWeb ? Promise.resolve(() => {}) : listen("assistant-notices://changed", callback),
  statusChanged: (callback: (status: AssistantNoticesStatus) => void) => isWeb ? Promise.resolve(() => {}) : listen<AssistantNoticesStatus>("assistant-notices://status", event => callback(event.payload)),
};

/** One in-flight request and one pending refresh per mounted consumer. */
export function useAssistantNoticeFeed(mode: "list" | "history", enabled = true) {
  const [notices, setNotices] = useState<AssistantNotice[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<AssistantNoticesStatus | null>(null);
  const reload = useRef<() => void>(() => {});
  const retry = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (isWeb || !enabled) return;
    let cleanup = () => {};
    function connect(): Promise<void> {
      cleanup();
      let disposed = false;
      let running: Promise<void> | null = null;
      let pending = false;
      let statusRevision = 0;
      let requestError = false;
      let subscriptionError = false;
      const stops: Array<() => void> = [];
      cleanup = () => { disposed = true; stops.forEach(stop => stop()); };
      setLoading(true);
      // Keep a failed subscription visible even when the one-off read succeeds.
      const report = () => { if (!disposed) setError(requestError || subscriptionError); };
      function load(): Promise<void> {
        if (disposed) return Promise.resolve();
        pending = true;
        if (running) return running;
        running = (async () => {
          while (pending && !disposed) {
            pending = false;
            try {
              const revision = statusRevision;
              const [next, nextStatus] = await Promise.all([assistantNotices[mode](), assistantNotices.status()]);
              if (!disposed) {
                setNotices(next); requestError = false;
                if (revision === statusRevision) setStatus(current => current && current.revision > nextStatus.revision ? current : nextStatus);
              }
            } catch { requestError = true; }
            finally { if (!disposed) { report(); setLoading(false); } }
          }
        })().finally(() => {
          running = null;
          // A listener can finish registering after the loop exits but before
          // this microtask runs; its requested catch-up read must not be lost.
          if (pending && !disposed) return load();
        });
        return running;
      }
      reload.current = () => { void load(); };
      const subscribe = (promise: Promise<() => void>) => promise.then(stop => {
        if (disposed) stop();
        else { stops.push(stop); return load(); }
      }).catch(() => { subscriptionError = true; if (!disposed) { report(); setLoading(false); } });
      return Promise.all([
        subscribe(assistantNotices.changed(() => { void load(); })),
        subscribe(assistantNotices.statusChanged(next => { if (disposed) return; statusRevision++; setStatus(current => current && current.revision > next.revision ? current : next); void load(); })),
        load(),
      ]).then(() => {
        if (!disposed && (requestError || subscriptionError)) throw new Error("Assistant notice feed unavailable");
      });
    }
    retry.current = connect;
    void connect().catch(() => {});
    return () => { cleanup(); reload.current = () => {}; retry.current = async () => {}; };
  }, [mode, enabled]);
  return { notices: enabled ? notices : [], status, error: enabled && error, loading: enabled && loading, reload: () => reload.current(), retry: () => retry.current() };
}
