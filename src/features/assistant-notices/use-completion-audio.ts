import { useEffect, useRef, useState } from "react";
import { assistantNotices, isWeb } from "./api";
import { noticeConfigError } from "./config";
import type { CompletionAudioEngine, CompletionAudioSettings, CompletionAudioView, CompletionAudioVoice } from "./types";

type Edits = { top: Partial<Omit<CompletionAudioSettings, "engines">>; engines: Record<string, Partial<CompletionAudioEngine>> };
const noEdits = (): Edits => ({ top: {}, engines: {} });

function isView(value: unknown): value is CompletionAudioView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<CompletionAudioView>;
  return typeof view.revision === "number" && !!view.settings && typeof view.settings.engines === "object"
    && !!view.defaults && typeof view.defaults.engines === "object" && !!view.autoVoices;
}

/** Replay only fields the user touched on top of the latest saved settings. */
function rebase(base: CompletionAudioSettings, edits: Edits): CompletionAudioSettings {
  const engines = { ...base.engines };
  for (const [engine, patch] of Object.entries(edits.engines)) if (engines[engine]) engines[engine] = { ...engines[engine], ...patch };
  return { ...base, ...edits.top, engines };
}

/**
 * Completion audio preferences, loaded only once the notice service reports
 * itself usable. Saving is driven by the page's shared Save button.
 */
export function useCompletionAudio(enabled: boolean) {
  const [view, setView] = useState<CompletionAudioView | null>(null);
  const [draft, setDraft] = useState<CompletionAudioSettings | null>(null);
  const [voices, setVoices] = useState<CompletionAudioVoice[]>([]);
  const [voicesError, setVoicesError] = useState(false);
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const edits = useRef<Edits>(noEdits());
  const latest = useRef<CompletionAudioView | null>(null);
  const turn = useRef(0);
  const saving = useRef(false);

  async function load(): Promise<void> {
    const current = ++turn.current;
    const [settings, installed] = await Promise.allSettled([assistantNotices.audioSettings(), assistantNotices.audioVoices()]);
    // A newer load, unmount or disable owns the state.
    if (current !== turn.current) return;
    if (settings.status === "fulfilled" && isView(settings.value)) {
      latest.current = settings.value; setView(settings.value);
      setDraft(rebase(settings.value.settings, edits.current)); setError("");
    } else setError("assistantNotices.audioSettingsError");
    if (installed.status === "fulfilled" && Array.isArray(installed.value)) { setVoices(installed.value); setVoicesError(false); }
    else setVoicesError(true);
  }
  useEffect(() => {
    if (isWeb || !enabled) return;
    void load();
    return () => { turn.current++; };
  }, [enabled]);

  function change(patch: Partial<Omit<CompletionAudioSettings, "engines">>) {
    if (!draft || saving.current) return;
    edits.current = { ...edits.current, top: { ...edits.current.top, ...patch } };
    setDraft(current => current ? { ...current, ...patch } : current); setDirty(true);
  }
  function changeEngine(engine: string, patch: Partial<CompletionAudioEngine>) {
    if (!draft?.engines[engine] || saving.current) return;
    edits.current = { ...edits.current, engines: { ...edits.current.engines, [engine]: { ...edits.current.engines[engine], ...patch } } };
    setDraft(current => current?.engines[engine] ? { ...current, engines: { ...current.engines, [engine]: { ...current.engines[engine], ...patch } } } : current); setDirty(true);
  }
  /** Stage every default as an explicit edit; nothing is written until Save. */
  function reset() {
    if (!view || saving.current) return;
    const { engines, ...top } = view.defaults;
    edits.current = { top, engines: { ...engines } };
    setDraft(view.defaults); setDirty(true);
  }
  async function save() {
    if (!draft || !latest.current || !dirty || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    const current = turn.current;
    try {
      const next = await assistantNotices.configureAudio(draft, latest.current.revision);
      if (current === turn.current && isView(next)) {
        latest.current = next; setView(next); setDraft(next.settings);
        edits.current = noEdits(); setDirty(false);
      }
    } catch (cause) {
      if (current === turn.current) setError(noticeConfigError(cause));
      throw cause;
    } finally { saving.current = false; if (current === turn.current) setBusy(false); }
  }
  async function preview(engine: string) {
    if (!draft) return;
    setPreviewError("");
    try { await assistantNotices.previewAudio(engine, draft); }
    catch { setPreviewError("assistantNotices.audioPreviewError"); throw new Error("preview failed"); }
  }
  return { view, draft, voices, voicesError, error, previewError, dirty, busy, change, changeEngine, reset, save, preview, reload: () => saving.current ? Promise.resolve() : load() };
}
