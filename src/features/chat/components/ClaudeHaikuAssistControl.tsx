import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { Switch } from "@/components/base/switch/switch";
import { menuPopoverSurface } from "@/components/base/dropdown/menu-styles";

/** Controlled by the owning conversation, including in a split pane. */
export function ClaudeHaikuAssistControl({ enabled, mainModel, runningEnabled, onChange }: {
  enabled: boolean;
  mainModel: string | undefined;
  runningEnabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const mode = t(enabled ? "chat.haikuAssistOn" : "chat.haikuAssistOff");
  const pending = runningEnabled !== undefined && runningEnabled !== enabled;
  const model = t("chat.haikuAssistMainModel", { model: mainModel || t("chat.haikuAssistDefaultModel") });
  return (
    <DialogTrigger>
      <Button aria-label={`${t("chat.haikuAssist")} · ${mode} · ${model}`}
        className="shrink-0 cursor-pointer rounded-md px-1.5 py-1 text-body-2-medium text-text-secondary outline-none transition-colors duration-150 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring">
        {mode}{pending && ` · ${t("chat.haikuAssistPending")}`}
      </Button>
      <Popover placement="top start" className={menuPopoverSurface({ width: "w-80", origin: "origin-bottom-left", padding: "p-3" })}>
        <Dialog aria-label={t("chat.haikuAssist")} className="outline-none">
          <div className="flex items-center justify-between gap-3">
            <span className="text-body-medium text-text-primary">{t("chat.haikuAssist")}</span>
            <Switch size="sm" isSelected={enabled} onChange={onChange}
              aria-label={t("chat.haikuAssist")} aria-describedby={descriptionId} />
          </div>
          <p className="mt-2 break-words text-body-2-medium text-text-primary">{model}</p>
          {runningEnabled !== undefined && <p className="mt-1 text-body-2-regular text-text-secondary">
            {t("chat.haikuAssistRunning", { mode: t(runningEnabled ? "chat.haikuAssistOn" : "chat.haikuAssistOff") })}
          </p>}
          <div id={descriptionId} className="mt-2 space-y-2 text-body-2-regular text-text-secondary">
            <p>{t("chat.haikuAssistDescription")}</p>
            <p>{t("chat.haikuAssistTiming")}</p>
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
