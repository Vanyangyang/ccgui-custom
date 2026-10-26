import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSectionLabel } from "@/components/application/settings/settings-rows";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select, SelectItem } from "@/components/base/select/select";
import { ConfirmDialog } from "@/components/dialogs";
import { pickDirectory } from "@/lib/platform";
import type { Workspace } from "@/lib/ipc";
import { normalizeProjectPath } from "./paths";
import { useProjectsStore, useProjectsSubscription } from "./store";
import type { ProjectInput, WorkspaceProject } from "./types";

export function ProjectViewsCard({ workspaces }: { workspaces: Workspace[] }) {
  const { t } = useTranslation();
  useProjectsSubscription();
  const projects = useProjectsStore((s) => s.projects);
  const loadError = useProjectsStore((s) => s.error);
  const loaded = useProjectsStore((s) => s.loaded);
  const [draft, setDraft] = useState<ProjectInput | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceProject | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await action(); } catch (e) { setError(String(e)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const addPath = (path: string) => setDraft((current) => {
    if (!current || current.members.some((m) => normalizeProjectPath(m.path) === normalizeProjectPath(path))) return current;
    return { ...current, defaultPath: current.defaultPath || path, members: [...current.members, { id: crypto.randomUUID(), path, label: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, role: "development" }] };
  });
  const save = () => void run(async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.members.length || draft.members.some((m) => !m.label.trim()) || !draft.members.some((m) => normalizeProjectPath(m.path) === normalizeProjectPath(draft.defaultPath))) throw new Error(t("projects.required"));
    await useProjectsStore.getState().save(draft);
    setDraft(null);
  });
  return <section className="flex flex-col gap-2" data-testid="project-views-card">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <SettingsSectionLabel>{t("projects.title")}</SettingsSectionLabel>
      <Button className="shrink-0" size="small" disabled={busy || !!draft || !loaded} onClick={() => { setError(null); setDraft({ name: "", defaultPath: "", members: [] }); }}>{t("projects.create")}</Button>
    </div>
    <p className="text-body-2-regular text-text-tertiary">{t("projects.description")}</p>
    {(error || loadError) && <div role="alert" className="text-body-2-regular text-text-error-primary">{error || loadError}{loadError && <Button size="small" disabled={busy} onClick={() => void useProjectsStore.getState().load()}>{t("projects.retry")}</Button>}</div>}
    <SettingsCard>
      {!projects.length && !draft && <p className="p-4 text-body-2-regular text-text-tertiary">{loaded ? t("projects.empty") : t("common.loading")}</p>}
      {projects.map((project) => <div key={project.id} className="flex items-center justify-between gap-3 p-4 max-sm:flex-col max-sm:items-stretch">
        <div className="min-w-0 flex-1"><p className="text-body-medium text-text-primary">{project.name}</p><p className="break-all text-body-2-regular text-text-tertiary">{project.defaultPath}</p>
          {project.sourcePluginId && <p className="text-body-2-regular text-text-tertiary">{t("projects.source", { source: project.sourcePluginId })} · {t("projects.pluginManaged")}</p>}
          <ul className="text-body-2-regular text-text-secondary">{project.members.map((m) => <li key={m.id}>{m.label}{m.status !== "available" && ` · ${t(`projects.${m.status}`)}`}</li>)}</ul>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!project.sourcePluginId && <Button variant="secondary" size="small" disabled={busy || !!draft} onClick={() => { setError(null); setDraft({ id: project.id, name: project.name, defaultPath: project.defaultPath, members: project.members.map(({ status: _status, ...m }) => m) }); }}>{t("projects.edit")}</Button>}
          <Button variant="secondary" size="small" disabled={busy || !!draft} onClick={() => setDeleting(project)}>{t("projects.remove")}</Button>
        </div>
      </div>)}
      {draft && <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3 border-t border-border-secondary p-4">
        <Input label={t("projects.name")} value={draft.name} onChange={(name) => setDraft({ ...draft, name })} isDisabled={busy} />
        <Select aria-label={t("projects.defaultPath")} selectedKey={draft.defaultPath || null} onSelectionChange={(key) => key && setDraft({ ...draft, defaultPath: String(key) })} isDisabled={busy}>
          {draft.members.map((m) => <SelectItem key={m.path} id={m.path} textValue={m.label}>{m.label} · {m.path}</SelectItem>)}
        </Select>
        <p className="break-all text-body-2-regular text-text-tertiary">{t("projects.defaultPath")}: {draft.defaultPath}</p>
        {draft.members.map((member) => <div key={member.id} className="flex flex-col gap-2 rounded-xl border border-border-secondary p-3">
          <p className="break-all text-body-2-regular text-text-tertiary">{member.path}</p>
          <Input label={t("projects.label")} value={member.label} isDisabled={busy} onChange={(label) => setDraft({ ...draft, members: draft.members.map((m) => m.id === member.id ? { ...m, label } : m) })} />
          <div><Button variant="secondary" size="small" disabled={busy} onClick={() => setDraft({ ...draft, members: draft.members.filter((m) => m.id !== member.id) })}>{t("projects.removeMember")}</Button></div>
        </div>)}
        <div className="flex flex-wrap gap-2">
          <Select aria-label={t("projects.addWorkspace")} placeholder={t("projects.selectWorkspace")} selectedKey={null} isDisabled={busy} onSelectionChange={(key) => { const w = workspaces.find((w) => w.id === key); if (w) addPath(w.path); }}>
            {workspaces.map((w) => <SelectItem key={w.id} id={w.id} textValue={w.path}>{w.name} · {w.path}</SelectItem>)}
          </Select>
          <Button variant="secondary" size="small" disabled={busy} onClick={() => void run(async () => { const path = await pickDirectory(t("projects.addDirectory")); if (path) addPath(path); })}>{t("projects.addDirectory")}</Button>
          <Button size="small" variant="primary" disabled={busy} onClick={save}>{t("common.save")}</Button>
          <Button variant="secondary" size="small" disabled={busy} onClick={() => { setDraft(null); setError(null); }}>{t("common.cancel")}</Button>
        </div>
      </fieldset>}
    </SettingsCard>
    {deleting && <ConfirmDialog message={t("projects.removeConfirm", { name: deleting.name })} onCancel={() => { if (!busy) setDeleting(null); }} onConfirm={() => void run(async () => { await useProjectsStore.getState().remove(deleting.id); setDeleting(null); })} />}
  </section>;
}
