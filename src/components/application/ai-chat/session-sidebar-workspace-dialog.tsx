import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "@/components/dialogs";
import { Button } from "@/components/base/buttons/button";
import { useChatStore } from "@/features/chat/store";
import { ipc, type SessionMeta, type Workspace } from "@/lib/ipc";
import type { TFunction } from "i18next";

/** Matches the native sidebar assignment target eligibility check. */
export function isLocalSidebarWorkspace(workspace: Workspace): boolean {
  const path = workspace.path;
  const absolute = /^[A-Za-z]:[\\/]/.test(path) || (path.startsWith("/") && !path.startsWith("//"));
  return absolute && !path.startsWith("\\\\") && !path.includes("://")
    && !["wsl", "ssh", "remote"].some((key) => Object.prototype.hasOwnProperty.call(workspace.meta ?? {}, key));
}

export function sidebarAssignmentError(cause: unknown, t: TFunction): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause);
  try {
    const parsed = typeof cause === "object" && !(cause instanceof Error) ? cause : JSON.parse(raw);
    if (parsed?.code === "SESSION_SIDEBAR_ASSIGNMENT_CONFLICT" && Array.isArray(parsed.conflicts)) {
      return parsed.conflicts.map((conflict: { engine?: string; sessionId?: string; code?: string; message?: string }) =>
        `${conflict.engine ?? ""}/${conflict.sessionId ?? ""}: ${t(`chat.sidebarWorkspaceConflicts.${conflict.code}`, { defaultValue: conflict.message ?? conflict.code ?? raw })}`,
      ).join("\n");
    }
  } catch { /* Non-JSON transport errors remain readable. */ }
  return raw ?? String(cause);
}

/** This dialog only writes display metadata. Session execution keeps its cwd. */
export function SessionSidebarWorkspaceDialog({ session, onClose }: { session: SessionMeta; onClose: () => void }) {
  const { t } = useTranslation();
  const workspaces = useChatStore((s) => s.workspaces);
  const aliases = useChatStore((s) => s.workspaceAliases);
  const [path, setPath] = useState(session.sidebarWorkspacePath ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const targets = workspaces.filter(isLocalSidebarWorkspace);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await ipc.assignSessionSidebarWorkspaces(crypto.randomUUID(), [{
        engine: session.engine,
        sessionId: session.sessionId,
        expectedWorkspacePath: session.workspacePath,
        expectedSidebarWorkspacePath: session.sidebarWorkspacePath ?? null,
        sidebarWorkspacePath: path || null,
      }]);
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) setError(sidebarAssignmentError(cause, t));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <ModalShell label={t("chat.sidebarWorkspace")} onClose={() => { if (!busy) onClose(); }} className="w-[28rem] max-w-[calc(100vw-2rem)]">
      <h2 className="text-body-medium font-semibold">{t("chat.sidebarWorkspace")}</h2>
      <p className="mt-2 text-body-regular text-text-secondary">{t("chat.sidebarWorkspaceHint")}</p>
      <p className="mt-2 break-all text-body-small text-text-tertiary">{t("chat.sidebarWorkspaceSource", { path: session.workspacePath })}</p>
      <select aria-label={t("chat.sidebarWorkspace")} value={path} disabled={busy} onChange={(event) => setPath(event.target.value)} className="mt-4 w-full rounded-lg border border-border-button-default bg-background-primary-default p-2 text-body-regular text-text-primary">
        <option value="">{t("chat.sidebarWorkspaceRestore")}</option>
        {path && !targets.some((w) => w.path === path) && <option value={path} disabled>{path}</option>}
        {targets.map((w) => <option key={w.id} value={w.path}>{aliases[w.id]?.trim() || w.name} — {w.path}</option>)}
      </select>
      {error && <p role="alert" className="mt-2 whitespace-pre-wrap break-words text-body-small text-text-error-primary">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" size="small" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" size="small" disabled={busy || path === (session.sidebarWorkspacePath ?? "")} onClick={() => void save()}>{t("common.save")}</Button>
      </div>
    </ModalShell>
  );
}
