import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import Power from "lucide-react/dist/esm/icons/power";
import { Button } from "@/components/base/buttons/button";
import { menuPopoverSurface } from "@/components/base/dropdown/menu-styles";
import { useTaskShutdownStore } from "./runtime";

export function TaskShutdownControl() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { status, pending, desiredEnabled, setEnabled } = useTaskShutdownStore();
  if (!status || !status.supported) return null;
  const active = status.phase === "waiting" || status.phase === "countdown" || (pending && desiredEnabled);
  const draining = status.phase === "countdown" && status.remainingSeconds === 0 && status.blockers.includes("native-operations");
  const statusText = status.phase === "countdown"
    ? draining ? t("taskShutdown.draining") : t("taskShutdown.countdown", { seconds: status.remainingSeconds ?? 60 })
    : t(`taskShutdown.${status.phase}`);
  return <DialogTrigger isOpen={open} onOpenChange={setOpen}>
    <AriaButton aria-label={t("taskShutdown.title")} aria-pressed={active}
      className={`inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-caption-1-regular outline-none transition-colors duration-150 hover:bg-background-tertiary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring ${active ? "text-text-warning-primary" : "text-text-secondary hover:text-text-primary"}`}>
      <Power size={13} aria-hidden />
      <span>{t("taskShutdown.title")}{status.phase !== "off" ? ` · ${statusText}` : ""}</span>
    </AriaButton>
    <Popover placement="top start" className={menuPopoverSurface({ width: "w-80", origin: "origin-bottom-left", padding: "p-3" })}>
      <Dialog aria-label={t("taskShutdown.title")} className="space-y-3 outline-none">
        <h2 className="text-body-medium text-text-primary">{t("taskShutdown.title")}</h2>
        <p className="text-body-2-regular text-text-secondary">{t("taskShutdown.description")}</p>
        <p className="text-body-2-regular text-text-secondary">{t("taskShutdown.warning")}</p>
        <p role={status.phase === "failed" ? "alert" : "status"} className="text-body-2-regular text-text-primary">
          {status.phase === "failed" ? t("taskShutdown.failed") : statusText}
        </p>
        {active && status.blockers.length > 0 && <ul className="list-inside list-disc space-y-1 text-caption-1-regular text-text-secondary">
          {[...new Set(status.blockers)].map(reason => <li key={reason}>{t(`taskShutdown.blockers.${reason}`, { defaultValue: t("taskShutdown.blockers.other") })}</li>)}
        </ul>}
        {status.phase === "failed" && status.error && <p className="max-h-28 overflow-auto break-words text-caption-1-regular text-text-secondary">{status.error}</p>}
        {active ? <Button size="small" disabled={pending && !desiredEnabled} onClick={() => { void setEnabled(false); }}>{t("taskShutdown.cancel")}</Button>
          : status.phase !== "requested" && <Button size="small" disabled={pending} onClick={() => { void setEnabled(true); }}>{t("taskShutdown.enable")}</Button>}
      </Dialog>
    </Popover>
  </DialogTrigger>;
}
