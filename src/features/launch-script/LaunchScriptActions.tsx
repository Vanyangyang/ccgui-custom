import { useCallback, useEffect, useSyncExternalStore, useState } from "react";
import { useTranslation } from "react-i18next";
import Play from "lucide-react/dist/esm/icons/play";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/input/textarea";
import { ModalShell } from "@/components/dialogs";
import {
  LAUNCH_SCRIPT_ACTION_ID,
  readPinnedIds,
  subscribePinnedIds,
} from "@/features/open-app/open-app";
import { cx } from "@/utils/cx";
import {
  createLaunchScriptEntry,
  onLaunchScriptEditorRequest,
  readLaunchScripts,
  writeLaunchScripts,
  type LaunchScriptEntry,
} from "./launch-script";
import { runLaunchScript } from "./run";

const RUN_BUTTON_CLASSES = cx(
  "flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none transition-colors",
  "text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary",
  "focus-visible:ring-2 focus-visible:ring-border-focus-ring",
);

/**
 * Header cluster for per-workspace startup scripts, ported from the legacy
 * app's LaunchScriptButton: the primary script gets a play button (click to
 * run, right-click to edit), labelled scripts render as labelled pills, and the
 * dialog edits the primary script with an expandable "new script" section.
 * `index: null` edits the not-yet-created first script.
 */
export function LaunchScriptActions({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LaunchScriptEntry[]>(() =>
    readLaunchScripts(workspacePath),
  );
  const [editIndex, setEditIndex] = useState<number | null | false>(false);
  const [showNew, setShowNew] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftScript, setDraftScript] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newScript, setNewScript] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Workspace switch resets this cluster wholesale: the header mounts it
  // with key={workspacePath}, so the useState initializer above reloads
  // that workspace's scripts with no open dialog.
  const persist = useCallback(
    (next: LaunchScriptEntry[]) => {
      setEntries(next);
      writeLaunchScripts(workspacePath, next);
    },
    [workspacePath],
  );

  const dialogOpen = editIndex !== false;

  const openEditor = useCallback(
    (index: number | null) => {
      // Read from storage (not render state) so the 更多 menu's editor request
      // can call this without depending on a possibly stale closure.
      const stored = readLaunchScripts(workspacePath);
      const entry = index === null ? null : stored[index];
      setDraftLabel(entry?.label ?? "");
      setDraftScript(entry?.script ?? "");
      setNewLabel("");
      setNewScript("");
      setShowNew(false);
      setError(null);
      setEditIndex(index);
    },
    [workspacePath],
  );

  // Pin state lives in the open-app cluster's storage so the 更多 menu's
  // checkbox controls this cluster's visibility across components.
  const pinnedIds = useSyncExternalStore(subscribePinnedIds, readPinnedIds);
  const pinned = pinnedIds.includes(LAUNCH_SCRIPT_ACTION_ID);

  // The 更多 menu's 启动脚本 row asks this cluster to open its editor; the
  // dialog stays reachable even while the header buttons are unpinned.
  useEffect(() => {
    return onLaunchScriptEditorRequest(() => {
      openEditor(readLaunchScripts(workspacePath).length > 0 ? 0 : null);
    });
  }, [workspacePath, openEditor]);

  const closeDialog = useCallback(() => {
    setEditIndex(false);
    setShowNew(false);
    setError(null);
  }, []);

  const runEntry = useCallback(
    (entry: LaunchScriptEntry, index: number) => {
      setError(null);
      void runLaunchScript(workspacePath, entry.script).catch((e: unknown) => {
        // Surface the failure in the editor so a rejected run is never silent.
        setError(t("launchScript.runFailed", { message: String(e) }));
        openEditor(index);
      });
    },
    [workspacePath, t, openEditor],
  );

  const saveEdit = useCallback(() => {
    if (editIndex === false) return;
    const trimmed = draftScript.trim();
    const next = [...entries];
    if (editIndex === null) {
      if (trimmed) next.push(createLaunchScriptEntry(draftLabel, trimmed));
    } else if (trimmed) {
      next[editIndex] = { ...next[editIndex], label: draftLabel.trim(), script: trimmed };
    } else {
      // Empty script on save deletes the entry.
      next.splice(editIndex, 1);
    }
    persist(next);
    closeDialog();
  }, [editIndex, draftScript, draftLabel, entries, persist, closeDialog]);

  const createNew = useCallback(() => {
    if (!newScript.trim()) return;
    persist([...entries, createLaunchScriptEntry(newLabel, newScript)]);
    closeDialog();
  }, [entries, newLabel, newScript, persist, closeDialog]);

  const primary = entries[0] ?? null;
  const primaryLabel = primary ? t("launchScript.run") : t("launchScript.set");

  return (
    <div className="flex items-center gap-0.5">
      {pinned && (
        <>
          <button
            type="button"
            title={primary ? `${primary.label || primaryLabel}: ${primary.script}` : primaryLabel}
            aria-label={primaryLabel}
            onClick={() => (primary ? runEntry(primary, 0) : openEditor(null))}
            onContextMenu={(event) => {
              event.preventDefault();
              openEditor(primary ? 0 : null);
            }}
            className={cx(RUN_BUTTON_CLASSES, primary?.label ? "gap-1 px-2" : "w-7")}
          >
            <Play className={primary?.label ? "size-3.5" : "size-4"} aria-hidden />
            {primary?.label && (
              <span className="max-w-24 truncate text-caption-1-medium">{primary.label}</span>
            )}
          </button>
          {entries.slice(1).map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              title={entry.script}
              aria-label={entry.label || entry.script}
              onClick={() => runEntry(entry, index + 1)}
              onContextMenu={(event) => {
                event.preventDefault();
                openEditor(index + 1);
              }}
              className={cx(RUN_BUTTON_CLASSES, "gap-1 px-2")}
            >
              <Play className="size-3.5" aria-hidden />
              <span className="max-w-24 truncate text-caption-1-medium">
                {entry.label || entry.script}
              </span>
            </button>
          ))}
        </>
      )}
      {dialogOpen && (
        <ModalShell
          onClose={closeDialog}
          label={t("launchScript.title")}
          className="w-[420px] max-w-[calc(100vw-32px)]"
        >
          <div className="flex flex-col gap-3">
            <p className="text-title-3-medium text-text-primary">{t("launchScript.title")}</p>
            <Input
              label={t("launchScript.label")}
              value={draftLabel}
              onChange={setDraftLabel}
              size="small"
            />
            <TextArea
              autoFocus
              mono
              rows={5}
              placeholder={t("launchScript.placeholder")}
              hint={t("launchScript.hint")}
              value={draftScript}
              onChange={setDraftScript}
            />
            {error && <p className="text-caption-1-medium text-text-error-primary">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="small" onClick={closeDialog}>
                {t("common.cancel")}
              </Button>
              <Button variant="secondary" size="small" onClick={() => setShowNew(true)}>
                {t("launchScript.new")}
              </Button>
              <Button variant="primary" size="small" onClick={saveEdit}>
                {t("common.save")}
              </Button>
            </div>
            {showNew && (
              <div className="flex flex-col gap-3 border-t border-separator-border pt-3">
                <p className="text-body-medium text-text-primary">
                  {t("launchScript.newTitle")}
                </p>
                <Input
                  label={t("launchScript.label")}
                  value={newLabel}
                  onChange={setNewLabel}
                  size="small"
                />
                <TextArea
                  mono
                  rows={4}
                  placeholder={t("launchScript.placeholder")}
                  value={newScript}
                  onChange={setNewScript}
                />
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="small" onClick={() => setShowNew(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    onClick={createNew}
                    disabled={!newScript.trim()}
                  >
                    {t("common.create")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </ModalShell>
      )}
    </div>
  );
}
