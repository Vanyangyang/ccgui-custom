/** Minimal label row for the GitHub-style blockquote alerts promoted by
 *  remark-github-alerts.ts: colored uppercase text, no icon. Kept separate
 *  from Markdown.tsx so the renderer file stays lean. */
import { useTranslation } from "react-i18next";
import type { AlertType } from "./remark-github-alerts";

const ALERT_LABEL_KEY: Record<AlertType, string> = {
  note: "chat.alertNote",
  tip: "chat.alertTip",
  important: "chat.alertImportant",
  warning: "chat.alertWarning",
  caution: "chat.alertCaution",
};

export function AlertTitle({ type }: { type: AlertType }) {
  const { t } = useTranslation();
  return <div className="md-alert-title">{t(ALERT_LABEL_KEY[type])}</div>;
}
