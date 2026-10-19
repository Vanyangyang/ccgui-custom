import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { getAppVersion } from "@/lib/platform";
import { useUpdateStore, type UpdateStage } from "@/features/update/store";
import { useUpdateDescription } from "@/features/update/stage-message";
import { CUSTOM_UPSTREAM_RELEASE, IS_CUSTOM_DISTRIBUTION } from "@/version/distribution";
import { LiveUpdateSection } from "./LiveUpdateSection";

/** Update page: app identity + version and the check-for-updates row. */
export function UpdateSection() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const updateStage = useUpdateStore((s) => s.stage);
  const updateVersion = useUpdateStore((s) => s.version);
  const downloadedBytes = useUpdateStore((s) => s.downloadedBytes);
  const totalBytes = useUpdateStore((s) => s.totalBytes);
  const updateError = useUpdateStore((s) => s.error);
  const latestVersion = useUpdateStore((s) => s.latestVersion);
  const latestPubDate = useUpdateStore((s) => s.latestPubDate);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const startUpdate = useUpdateStore((s) => s.startUpdate);

  // available / downloading / installing / restarting / error share the
  // toast's copy — both can be on screen at once during a download.
  /** An install is running: the row reports progress instead of offering
   *  a check that would race it. */
  const updateInFlight =
    updateStage === "downloading" || updateStage === "installing" || updateStage === "restarting";
  // Checking… / 已是最新版本 (with the newest release's version + date) /
  // the shared stage copy — same hook the release-notes pane uses.
  const updateDescription = useUpdateDescription({
    stage: updateStage,
    version: updateVersion,
    downloadedBytes,
    totalBytes,
    error: updateError,
    latestVersion,
    latestPubDate,
  });

  useEffect(() => {
    let cancelled = false;
    getAppVersion()
      .then((v) => {
        if (!cancelled && v) setVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex w-full flex-col gap-6">
      {/* App identity + version */}
      <div className="flex w-full flex-col gap-2">
        <SettingsSectionLabel>{t("settings.checkUpdates")}</SettingsSectionLabel>
        <SettingsCard>
          <SettingsRow anchor="appVersion" label="CC GUI" description={IS_CUSTOM_DISTRIBUTION ? t("settings.customDistribution", { upstream: CUSTOM_UPSTREAM_RELEASE }) : t("settings.aboutDesc")}>
            <span className="text-body-regular text-text-secondary">
              {version ? `v${version}` : "…"}
            </span>
          </SettingsRow>
          <SettingsRow anchor="checkUpdates" label={t("settings.checkUpdates")} description={IS_CUSTOM_DISTRIBUTION ? t("settings.customUpdateMaintenance") : updateDescription}>
            {!IS_CUSTOM_DISTRIBUTION && <UpdateControls
              stage={updateStage}
              inFlight={updateInFlight}
              onCheck={() => void checkForUpdates({ interactive: true })}
              onStart={() => void startUpdate()}
            />}
          </SettingsRow>
        </SettingsCard>
      </div>
      {IS_CUSTOM_DISTRIBUTION && <LiveUpdateSection />}
    </div>
  );
}

/** Row controls: check button plus the update CTA once a release is known. */
function UpdateControls({
  stage,
  inFlight,
  onCheck,
  onStart,
}: {
  stage: UpdateStage;
  inFlight: boolean;
  onCheck: () => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  if (inFlight) {
    // Progress rides in the description; the CTA stays visible but inert so
    // the row does not jump mid-install.
    return (
      <Button size="small" variant="primary" disabled>
        {t("settings.updateNow")}
      </Button>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button
        size="small"
        variant="secondary"
        disabled={stage === "checking"}
        onClick={onCheck}
      >
        {t("settings.checkUpdates")}
      </Button>
      {stage === "available" && (
        <Button size="small" variant="primary" onClick={onStart}>
          {t("settings.updateNow")}
        </Button>
      )}
    </div>
  );
}
