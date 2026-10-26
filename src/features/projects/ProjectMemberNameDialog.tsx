import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "@/components/dialogs";
import { Input } from "@/components/base/input/input";
import { Button } from "@/components/base/buttons/button";
import { useProjectsStore } from "./store";

/** A project member has one editable display name, shared by AI and manual edits. */
export function ProjectMemberNameDialog({ projectId, memberId, onClose }: {
  projectId: string; memberId: string; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(() => useProjectsStore.getState().projects.find((p) => p.id === projectId)?.members.find((m) => m.id === memberId)?.label ?? "");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (busyRef.current || !name.trim()) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      // Merge only this name into the latest local project so unrelated edits
      // received while the prompt was open are not reverted by the dialog.
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
      if (!project || project.sourcePluginId || !project.members.some((m) => m.id === memberId)) throw new Error(t("projects.memberChanged"));
      await useProjectsStore.getState().save({ id: project.id, name: project.name, defaultPath: project.defaultPath,
        members: project.members.map(({ status: _status, ...member }) => ({ ...member, label: member.id === memberId ? name.trim() : member.label })) });
      onClose();
    } catch (e) { setError(String(e)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <ModalShell label={t("projects.label")} onClose={() => { if (!busyRef.current) onClose(); }}>
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Input autoFocus label={t("projects.label")} value={name} onChange={setName} isDisabled={busy} />
      {error && <p role="alert" className="text-body-2-regular text-text-error-primary">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="small" variant="secondary" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" size="small" disabled={busy || !name.trim()}>{t("common.save")}</Button>
      </div>
    </form>
  </ModalShell>;
}
