// Real UI, synthetic IPC and document-local storage. No native app or model.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import i18n from "@/lib/i18n";
import { ipc, type AppSettings, type SessionMeta } from "@/lib/ipc";
import { GeneralSection } from "@/features/settings/GeneralSection";
import { RenameSessionDialog } from "@/features/chat/RenameSessionDialog";

declare global {
  interface Window {
    __autoTitleFixture: {
      state: {
        settings: AppSettings;
        session: SessionMeta;
        outcome: "changed" | "keep" | "timeout";
        delayMs: number;
        calls: { kind: string; detail: unknown }[];
        suggestions: number;
        renames: number;
      };
      notify: () => void;
      log: (kind: string, detail: unknown) => void;
    };
  }
}

const fixture = window.__autoTitleFixture;
const params = new URLSearchParams(location.search);
const inFrame = params.get("frame") === "1";

function Fixture() {
  const [, redraw] = useState(0);
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState(i18n.language.startsWith("en") ? "en" : "zh");
  const [narrow, setNarrow] = useState(!inFrame && params.get("width") === "320");
  const { state } = fixture;
  useEffect(() => {
    const refresh = () => redraw((n) => n + 1);
    window.addEventListener("auto-title-fixture:change", refresh);
    return () => window.removeEventListener("auto-title-fixture:change", refresh);
  }, []);

  const changeLanguage = (next: string) => {
    void i18n.changeLanguage(next);
    setLanguage(next);
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
  };
  const seedTitle = (customTitle: string | null) => {
    state.session.customTitle = customTitle;
    fixture.notify();
    setOpen(true);
  };
  const controlClass = "rounded border border-border-button-default bg-background-primary-default px-3 py-2 text-text-primary";

  return <main className="mx-auto flex w-full max-w-[900px] flex-col gap-4 bg-background-primary-default p-4 text-text-primary">
    <h1 className="text-heading-3">Auto-title manual QA · mocked IPC</h1>
    <p className="text-body-regular">Real GeneralSection + RenameSessionDialog. Preferences, history and writes exist only in this document's memory.</p>
    <div className="flex flex-wrap gap-2">
      <button id="lang-zh" className={controlClass} onClick={() => changeLanguage("zh")}>中文</button>
      <button id="lang-en" className={controlClass} onClick={() => changeLanguage("en")}>English</button>
      {!inFrame && <button id="narrow-toggle" className={controlClass} onClick={() => setNarrow((v) => !v)}>
        {narrow ? "Full width" : "320 px preview"}
      </button>}
    </div>
    {narrow ? <>
      <p>A separate 320 px iframe viewport with its own mock state; its modal uses the real narrow viewport.</p>
      <iframe title="Auto-title at 320 pixels" src={`./auto-title.html?frame=1&lang=${language}`}
        className="mx-auto max-w-full border border-border-button-default" style={{ width: 320, height: 1100 }} />
    </> : <>
      <section className="flex flex-col gap-3 rounded-xl border border-border-button-default p-3">
        <h2 className="text-body-medium">Rename controls</h2>
        <div className="flex flex-wrap gap-2">
          <button id="open-rename" className={controlClass} onClick={() => setOpen(true)}>Open rename</button>
          <button id="open-unlocked" className={controlClass} onClick={() => seedTitle(null)}>Open without manual title</button>
          <button id="open-locked" className={controlClass} onClick={() => seedTitle("My manual title")}>Open with manual title</button>
        </div>
        <label className="flex flex-wrap items-center gap-2">Suggestion outcome
          <select id="suggestion-outcome" className={controlClass} value={state.outcome} onChange={(event) => {
            state.outcome = event.target.value as typeof state.outcome;
            fixture.notify();
          }}>
            <option value="changed">Changed title</option>
            <option value="keep">Keep current title</option>
            <option value="timeout">Timeout failure</option>
          </select>
        </label>
        <label className="flex flex-wrap items-center gap-2">Delay
          <select id="suggestion-delay" className={controlClass} value={state.delayMs} onChange={(event) => {
            state.delayMs = Number(event.target.value);
            fixture.notify();
          }}>
            <option value={5000}>5 seconds — edit while waiting</option>
            <option value={15000}>15 seconds — close while waiting</option>
            <option value={300}>300 ms — quick feedback</option>
          </select>
        </label>
        <p>Pick outcome before opening. Generate, then edit while waiting: the draft and caret must remain; confirm alone writes a title.</p>
        <pre id="fixture-state" className="overflow-auto whitespace-pre-wrap break-words text-caption-1-regular">{JSON.stringify({
          displayedTitle: state.session.customTitle || state.session.title,
          manualTitle: state.session.customTitle,
          autoTitleEnabled: state.settings.autoTitleEnabled,
          autoTitleEngine: state.settings.autoTitleEngine,
          autoTitleModel: state.settings.autoTitleModel,
          autoTitleEffort: state.settings.autoTitleEffort,
          suggestions: state.suggestions,
          renameWrites: state.renames,
        }, null, 2)}</pre>
        <details><summary>Mock IPC calls</summary>
          <pre id="fixture-calls" className="overflow-auto whitespace-pre-wrap break-words text-caption-1-regular">{JSON.stringify(state.calls, null, 2)}</pre>
        </details>
      </section>
      <section aria-label="Real general settings"><GeneralSection /></section>
      {open && <RenameSessionDialog
        session={{ ...state.session }}
        onClose={() => setOpen(false)}
        onRename={(title) => { void ipc.renameSession(state.session.engine, state.session.sessionId, title); }}
      />}
    </>}
  </main>;
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
