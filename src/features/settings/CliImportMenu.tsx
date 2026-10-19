import { useTranslation } from "react-i18next";
import Download from "lucide-react/dist/esm/icons/download";
import ArrowLeftRight from "lucide-react/dist/esm/icons/arrow-left-right";
import FileText from "lucide-react/dist/esm/icons/file-text";
import {
  Dropdown,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";

/** cc-switch import dropdown on the channels header of the engines it manages. */
export function CliImportMenu({
  busy,
  onSyncAuto,
  onImportFile,
}: {
  busy: boolean;
  onSyncAuto: () => void;
  onImportFile: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dropdown>
      <DropdownTrigger
        aria-label={t("settings.cliImportEntry")}
        isDisabled={busy}
        className="inline-flex h-8 items-center gap-1 rounded-lg border border-border-button-default bg-background-primary-default px-2 py-1.5 text-body-medium text-text-primary shadow-xs hover:bg-background-primary-hover hover:border-border-button-hover disabled:opacity-50"
      >
        <Download className="size-[18px] shrink-0" aria-hidden />
        <span className="inline-flex items-center px-0.5">
          {t("settings.cliImportEntry")}
        </span>
      </DropdownTrigger>
      <DropdownPopover
        aria-label={t("settings.cliImportEntry")}
        placement="bottom end"
        className="w-max min-w-64"
      >
        <DropdownItem className="px-2 py-1.5 whitespace-nowrap" onSelect={onSyncAuto}>
          <ArrowLeftRight
            className="size-4 shrink-0 text-foreground-icon-secondary"
            aria-hidden
          />
          {t("settings.cliImportAuto")}
        </DropdownItem>
        <DropdownItem className="px-2 py-1.5 whitespace-nowrap" onSelect={onImportFile}>
          <FileText
            className="size-4 shrink-0 text-foreground-icon-secondary"
            aria-hidden
          />
          {t("settings.cliImportFile")}
        </DropdownItem>
      </DropdownPopover>
    </Dropdown>
  );
}
