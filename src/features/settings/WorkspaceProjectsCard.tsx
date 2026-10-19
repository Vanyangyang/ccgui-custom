import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { Select, SelectItem } from "@/components/base/select/select";
import type { Workspace, WorkspaceGroup } from "@/lib/ipc";

/** Compact select trigger (h 32, radius/lg), matching the settings pages'
 *  (外观 / 对话与输入) rows. */
const SELECT_TRIGGER = "h-8 w-auto gap-1 rounded-lg px-2 py-1.5";

/** Per-project group assignment list. A group dropdown with only "未分组" is
 *  noise: the list only makes sense once at least one group exists. */
export function WorkspaceProjectsCard({
  workspaces,
  groups,
  selfDevWorkspaceId,
  onAssign,
}: {
  workspaces: Workspace[];
  groups: WorkspaceGroup[];
  selfDevWorkspaceId?: string | null;
  onAssign: (workspaceId: string, key: Key | null) => void;
}) {
  const { t } = useTranslation();
  if (groups.length === 0 || workspaces.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel anchor="projects">
        {t("settings.projects")}
        <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
          {t("settings.projectsDesc")}
        </span>
      </SettingsSectionLabel>
      <SettingsCard>
        {workspaces.map((workspace) => (
          <SettingsRow
            key={workspace.id}
            label={workspace.name}
            labelAdornment={
              selfDevWorkspaceId === workspace.id ? (
                <span className="inline-flex h-4 shrink-0 items-center rounded-sm border border-status-purple-border bg-status-purple-bg px-1.5 text-caption-2-medium text-status-purple-text">
                  {t("chat.selfDevBadge")}
                </span>
              ) : undefined
            }
            description={workspace.path}
          >
            <Select
              aria-label={t("settings.projects")}
              selectedKey={workspace.groupId ?? ""}
              onSelectionChange={(key) => onAssign(workspace.id, key)}
              triggerClassName={SELECT_TRIGGER}
            >
              <SelectItem id="">{t("settings.ungrouped")}</SelectItem>
              {groups.map((group) => (
                <SelectItem key={group.id} id={group.id}>
                  {group.name}
                </SelectItem>
              ))}
            </Select>
          </SettingsRow>
        ))}
      </SettingsCard>
    </div>
  );
}
