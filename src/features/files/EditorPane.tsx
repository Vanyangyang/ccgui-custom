import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { useTranslation } from "react-i18next";
import { ipc, type FileContent } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { Button } from "@/components/base/buttons/button";
import { CenteredSpinner, EmptyState } from "@/components/base/empty-state";
import { fileName, useFilesStore } from "./store";
import { BinaryFileView, ImageFileView } from "./EditorFallbackViews";
import { FileEditorHeader } from "./FileEditorHeader";
import { MarkdownPreview } from "./MarkdownPreview";
import { registerShortcutHandler } from "@/features/shortcuts/runtime";

const MARKDOWN_RE = /\.(md|markdown)$/i;
const CM_BASIC_SETUP = { foldGutter: false, highlightActiveLine: true };

/** Tracks the app theme class on <html> so CodeMirror follows light/dark. */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export function EditorPane({ path }: { path: string }) {
  const { t } = useTranslation();
  const entry = useFilesStore((s) => s.fileStates[path]);
  const reloadFile = useFilesStore((s) => s.reloadFile);

  if (!entry || entry.loading) {
    return <CenteredSpinner />;
  }
  if (entry.error) {
    return (
      <EmptyState className="flex-col gap-3 p-6">
        <p className="text-body-medium text-text-error-primary">{t("files.fileNotFound")}</p>
        <p className="max-w-md break-all text-caption-1-regular text-text-tertiary">
          {entry.error}
        </p>
        <Button variant="secondary" size="small" onClick={() => void reloadFile(path)}>
          {t("common.refresh")}
        </Button>
      </EmptyState>
    );
  }
  if (!entry.content) {
    return <CenteredSpinner />;
  }
  // key remounts the editor with a fresh draft whenever the file (re)loads.
  return <FileEditor key={`${path}:${entry.loadNonce}`} path={path} content={entry.content} />;
}

function FileEditor({ path, content }: { path: string; content: FileContent }) {
  const setFileDirty = useFilesStore((s) => s.setFileDirty);
  // Inactive (invisible) editors stay mounted; only the visible tab may
  // answer Cmd/Ctrl+S, or every open file would save at once.
  const isActiveTab = useFilesStore((s) => s.activeFilePath === path);
  const dark = useIsDark();

  const [draft, setDraft] = useState(content.text ?? "");
  const [savedText, setSavedText] = useState(content.text ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mdMode, setMdMode] = useState<"edit" | "preview">(() => (MARKDOWN_RE.test(path) ? "preview" : "edit"));
  const [langExt, setLangExt] = useState<Extension[]>([]);

  const name = fileName(path);
  const isMarkdown = MARKDOWN_RE.test(name);
  // Truncated files are partial (editing + saving would clobber the tail);
  // remote-readOnly files are complete but unwritable — both stay read-only.
  const readOnly = content.truncated || content.readOnly === true;
  const dirty = !readOnly && draft !== savedText;

  // Publish dirty state so the tab strip can dot the tab and confirm closes.
  useEffect(() => {
    setFileDirty(path, dirty);
    return () => setFileDirty(path, false);
  }, [dirty, path, setFileDirty]);

  // Resolve a CodeMirror grammar from the file extension (lazy-loaded).
  useEffect(() => {
    let cancelled = false;
    setLangExt([]);
    const desc = LanguageDescription.matchFilename(languages, name);
    if (!desc) return;
    void desc.load().then((ext) => {
      if (!cancelled) setLangExt([ext]);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await ipc.writeFile(path, draft);
      setSavedText(draft);
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  }, [path, draft]);

  // Cmd/Ctrl+S saves from anywhere while this editor is mounted. The listener
  // subscribes once; refs keep it reading the latest save/dirty/saving so it
  // isn't re-attached on every keystroke. The refs sync after commit; the
  // only reader is the keydown handler, which always fires post-commit.
  const saveRef = useRef(save);
  const dirtyRef = useRef(dirty);
  const savingRef = useRef(saving);
  const activeRef = useRef(isActiveTab);
  useEffect(() => {
    saveRef.current = save;
    dirtyRef.current = dirty;
    savingRef.current = saving;
    activeRef.current = isActiveTab;
  });
  // Save key lives in the shortcut runtime (default ⌘S, configurable in
  // Settings → Shortcuts). Refs keep the handler reading the latest
  // save/dirty/saving so it isn't re-registered on every keystroke.
  useEffect(() => {
    if (readOnly) return;
    return registerShortcutHandler("saveFile", () => {
      if (!activeRef.current) return;
      if (dirtyRef.current && !savingRef.current) void saveRef.current();
    });
  }, [readOnly]);

  if (content.kind === "image") {
    return <ImageFileView name={name} dataUrl={content.dataUrl} />;
  }

  if (content.kind === "binary") {
    return <BinaryFileView name={name} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileEditorHeader
        path={path}
        name={name}
        dirty={dirty}
        readOnly={readOnly}
        isMarkdown={isMarkdown}
        mdMode={mdMode}
        onMdModeChange={setMdMode}
        saving={saving}
        onSave={save}
      />
      {saveError && (
        <p className="shrink-0 break-all border-b border-border-button-default px-3 py-1.5 text-caption-1-regular text-text-error-primary">
          {saveError}
        </p>
      )}
      {isMarkdown && mdMode === "preview" ? (
        <MarkdownPreview path={path} draft={draft} />
      ) : (
        <CodeMirror
          className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full"
          height="100%"
          value={draft}
          onChange={setDraft}
          extensions={langExt}
          theme={dark ? "dark" : "light"}
          readOnly={readOnly}
          basicSetup={CM_BASIC_SETUP}
        />
      )}
    </div>
  );
}

export default EditorPane;
