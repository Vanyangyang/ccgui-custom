/**
 * Notice for pages whose management actions are desktop-only: the web bridge
 * deliberately does not dispatch their commands, so a remote browser must not
 * render controls that cannot work. Shared by Skills and MCP.
 */
import { useTranslation } from "react-i18next";
import MonitorDown from "lucide-react/dist/esm/icons/monitor-down";

export function LocalOnlyNotice({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-separator-border bg-background-primary-default p-4">
      <p className="flex items-center gap-2 text-body-medium text-text-primary">
        <MonitorDown className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
        {t("settings.localOnlyTitle")}
      </p>
      <p className="text-body-2-regular text-text-secondary">{message}</p>
    </div>
  );
}
