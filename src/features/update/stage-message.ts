import { useTranslation } from "react-i18next";
import { downloadPercent, type UpdateStage } from "./store";

interface StageMessageInput {
  stage: UpdateStage;
  /** Version of the pending update, shown on the "available" stage. */
  version?: string;
  downloadedBytes: number;
  totalBytes?: number;
  error?: string;
}

/**
 * One-line copy for the update stages that more than one surface renders —
 * the floating toast (UpdateToast), the settings update row (UpdateSection)
 * and the release-notes pane (ReleaseNotesPane) — so they can never drift
 * apart while two of them are on screen during a download.
 *
 * The caller owns the stages with surface-specific copy: the toast hides
 * idle/checking/latest and the other two render those from
 * `useUpdateDescription` below.
 */
export function useUpdateStageMessage({
  stage,
  version,
  downloadedBytes,
  totalBytes,
  error,
}: StageMessageInput): string | null {
  const { t } = useTranslation();
  switch (stage) {
    case "available":
      return t("settings.updateAvailable", { version });
    case "downloading": {
      const percent = downloadPercent(downloadedBytes, totalBytes);
      return t("settings.updateDownloading") + (percent !== null ? ` ${percent}%` : "");
    }
    case "installing":
      return t("settings.updateInstalling");
    case "restarting":
      return t("settings.updateRestarting");
    case "error":
      return t("settings.updateError", { message: error });
    default:
      return null;
  }
}

interface UpdateDescriptionInput extends StageMessageInput {
  /** Latest release on the server, known after an interactive check that
   *  ended in the "up to date" result. */
  latestVersion?: string;
  /** ISO publish date of that release, when the manifest has one. */
  latestPubDate?: string;
}

/**
 * Full description of the current update state — the stage line plus the
 * two results the toast never renders: "checking…" and the "up to date"
 * line with the newest release's version and publish date. Shared by the
 * settings update row and the release-notes pane so both report the same
 * thing after the user clicks 检查更新.
 */
export function useUpdateDescription({
  stage,
  version,
  downloadedBytes,
  totalBytes,
  error,
  latestVersion,
  latestPubDate,
}: UpdateDescriptionInput): string | undefined {
  const { t, i18n } = useTranslation();
  const message = useUpdateStageMessage({ stage, version, downloadedBytes, totalBytes, error });
  if (stage === "checking") return t("settings.updateChecking");
  if (stage === "latest") {
    // The "up to date" line keeps its own richer copy (version + date); an
    // unparseable/missing date falls back to the version-only sentence.
    const parsed = latestPubDate ? new Date(latestPubDate) : null;
    const date =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleDateString(i18n.language) : null;
    if (!latestVersion) return t("settings.updateLatest");
    return date
      ? t("settings.updateLatestDetail", { version: latestVersion, date })
      : t("settings.updateLatestDetailNoDate", { version: latestVersion });
  }
  return message ?? undefined;
}
