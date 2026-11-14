import { useTranslation } from "react-i18next";
import { SettingsSectionLabel } from "@/components/application/settings/settings-rows";

export function TaskWorkspaceAccess() {
  const { t } = useTranslation();

  return <section className="flex min-w-0 flex-col gap-3 px-3" aria-label={t("settings.taskAccessTitle")}>
    <SettingsSectionLabel>{t("settings.taskAccessTitle")}</SettingsSectionLabel>
    <p className="text-body-2-regular text-text-secondary">{t("settings.taskAccessDescription")}</p>
  </section>;
}
