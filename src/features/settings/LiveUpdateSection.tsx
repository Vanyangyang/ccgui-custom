import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { SettingsCard, SettingsRow, SettingsSectionLabel } from "@/components/application/settings/settings-rows";
import { pickDirectory } from "@/lib/platform";
import { IS_CUSTOM_DISTRIBUTION } from "@/version/distribution";
import { canRequestSelfUpdate, useLiveUpdateStore, type LiveUpdateBlocker } from "@/features/update/live-update";
import {
  extractChannelSourceRoot,
  useStoredSelfDevWorkspacePath,
} from "@/features/update/self-dev-workspace";
import { formatLiveUpdateBlocker } from "@/features/update/SelfUpdateStatusChip";
import { SelfUpdateDetails } from "@/features/update/SelfUpdateDetails";

function Blocker({ blocker }: { blocker: LiveUpdateBlocker }) {
  const { t } = useTranslation();
  return <li>{formatLiveUpdateBlocker(t, blocker)}</li>;
}

export function LiveUpdateSection() {
  const { t } = useTranslation();
  const state = useLiveUpdateStore();
  const storedSelfDevPath = useStoredSelfDevWorkspacePath();
  const selfDevPath = extractChannelSourceRoot(state.channel) ?? storedSelfDevPath;
  const [source, setSource] = useState("");
  const [digest, setDigest] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string>();
  const pickerGeneration = useRef(0);
  const refreshFeedback = useActionFeedback({ spin: true });

  useEffect(() => () => { pickerGeneration.current++; }, []);

  if (!IS_CUSTOM_DISTRIBUTION) return null;
  const supported = state.support === "supported";
  const pending = state.transaction?.phase === "Preparing" || state.transaction?.phase === "Ready";
  const busy = state.requesting || ["importing", "applying", "cancelling", "handoff"].includes(state.stage);
  const validDigest = /^[a-fA-F0-9]{64}$/.test(digest.trim());
  const canImport = supported && !busy && !pending && !picking && !!source && validDigest && state.errorCode !== "recoveryFailed";
  const showImport = !pending && state.stage !== "applying" && state.stage !== "handoff" && state.stage !== "cancelling";
  const unsupportedText = state.support === "web" ? t("settings.liveUpdateWeb")
    : state.support === "unsupported" ? t("settings.liveUpdateUnsupported")
      : state.support === "checking" && state.checking ? t("settings.liveUpdateChecking") : undefined;

  async function choosePackage() {
    if (!supported || busy || picking) return;
    const generation = ++pickerGeneration.current;
    setPicking(true);
    setPickerError(undefined);
    try {
      const selected = await pickDirectory(t("settings.liveUpdateChooseFolder"));
      if (pickerGeneration.current === generation && selected) setSource(selected);
    } catch (error) {
      if (pickerGeneration.current === generation) setPickerError(error instanceof Error ? error.message : String(error));
    } finally {
      if (pickerGeneration.current === generation) setPicking(false);
    }
  }

  const channelWaiting = state.channel?.updateRequest?.waitingFor?.length
    ? t("settings.liveUpdateWaitingTasks", { tasks: state.channel.updateRequest.waitingFor.join(", ") })
    : undefined;
  const channelBuilding = state.channel?.batch?.phase === "Building" || state.channel?.batch?.phase === "Staging"
    ? t("settings.liveUpdateBuilding", { count: state.channel.batch.changes.length })
    : undefined;
  const channelReady = !channelWaiting && !channelBuilding && (state.channel?.ready?.length ?? 0) > 0
    ? t("settings.liveUpdateReadyCount", { count: state.channel!.ready.length })
    : undefined;

  const phaseText = state.requesting ? t("statusbar.selfUpdateRequesting")
    : state.stage === "importing" ? t("settings.liveUpdateImporting")
    : state.stage === "waiting" ? t("settings.liveUpdateWaiting")
      : state.stage === "applying" ? t("settings.liveUpdateApplying")
        : state.stage === "cancelling" ? t("settings.liveUpdateCancelling")
          : state.stage === "handoff" ? t("settings.liveUpdateHandoff")
            : channelBuilding ?? channelWaiting ?? (state.cancelled ? t("settings.liveUpdateCancelled") : channelReady);
  const spinning = busy || !!channelBuilding;

  return (
    <section className="flex w-full flex-col gap-2" aria-label={t("settings.liveUpdateTitle")} data-runtime-update-safe="true">
      <SettingsSectionLabel>{t("settings.liveUpdateTitle")}</SettingsSectionLabel>
      <SettingsCard>
        <SettingsRow anchor="liveUpdate" label={t("settings.liveUpdateDetailsTitle")}>
          {state.support !== "web" && (
            <Button size="small" variant="secondary" disabled={busy || state.checking || refreshFeedback.feedback === "running"}
              onClick={() => void refreshFeedback.start(() => state.refresh(), () => useLiveUpdateStore.getState().support !== "supported" || !!useLiveUpdateStore.getState().errorCode)}>
              <ActionFeedbackIcon icon={RefreshCw} feedback={refreshFeedback.feedback} spin />
              {t("settings.liveUpdateRefresh")}
            </Button>
          )}
        </SettingsRow>
        <div className="min-w-0 px-3 pb-3"><SelfUpdateDetails state={state} /></div>
        {selfDevPath && (
          <SettingsRow
            label={t("settings.selfDevWorkspace")}
            labelAdornment={
              <span className="inline-flex h-4 shrink-0 items-center rounded-sm border border-status-purple-border bg-status-purple-bg px-1.5 text-caption-2-medium text-status-purple-text">
                {t("chat.selfDevBadge")}
              </span>
            }
            description={selfDevPath}
          >
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {state.support !== "web" && (
                <Button
                  size="small"
                  variant="primary"
                  disabled={!canRequestSelfUpdate(state, selfDevPath)}
                  onClick={() => void state.requestUpdate(selfDevPath)}
                  data-testid="live-update-self-dev-build"
                >
                  {(state.requesting || !!channelBuilding) && (
                    <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                  )}
                  {state.requesting || !!channelBuilding
                    ? t("settings.selfDevWorkspaceBuilding")
                    : t("settings.selfDevWorkspaceBuildAndUpdate")}
                </Button>
              )}
              <Button
                size="small"
                variant="secondary"
                onClick={() =>
                  void import("@/features/update/use-self-dev-workspace").then((m) =>
                    m.reopenSelfDevWorkspaceInChat(selfDevPath),
                  )
                }
                data-testid="live-update-self-dev-open"
              >
                {t("settings.selfDevWorkspaceReopen")}
              </Button>
            </div>
          </SettingsRow>
        )}
      </SettingsCard>
      <SettingsCard>
        <SettingsRow label={t("settings.liveUpdateLocalPackage")} description={t("settings.liveUpdateDescription")} />
        <div className="flex min-w-0 flex-col gap-3 px-3 pb-3">
          {unsupportedText && <p className="text-body-2-regular text-text-secondary" role="status">{unsupportedText}</p>}
          {showImport && (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Button size="small" variant="secondary" disabled={!supported || busy || picking} onClick={() => void choosePackage()}>
                  {picking ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <FolderOpen className="size-4" aria-hidden />}
                  {t("settings.liveUpdateChooseFolder")}
                </Button>
                <p className="min-w-0 break-all text-body-2-regular text-text-secondary">{source || t("settings.liveUpdateNoFolder")}</p>
              </div>
              <Input size="small" label={t("settings.liveUpdateDigest")} value={digest} onChange={setDigest}
                isDisabled={!supported || busy} isInvalid={!!digest && !validDigest}
                hint={digest && !validDigest ? t("settings.liveUpdateInvalidDigest") : t("settings.liveUpdateDigestHint")}
                placeholder={t("settings.liveUpdateDigestPlaceholder")} />
              <div className="flex flex-wrap gap-2">
                <Button size="small" variant="primary" disabled={!canImport} onClick={() => void state.stagePackage(source, digest)}>
                  {state.stage === "importing" && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
                  {t("settings.liveUpdateImport")}
                </Button>
              </div>
            </>
          )}
          {state.transaction && state.stage !== "idle" && (
            <p className="break-all text-body-2-regular text-text-secondary">{t("settings.liveUpdateCandidate", { version: state.transaction.candidate.version, release: state.transaction.candidate.releaseId })}</p>
          )}
          {phaseText && <p className="flex items-center gap-2 text-body-2-regular text-text-secondary" role="status">
            {spinning && <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}{phaseText}
          </p>}
          {state.stage === "waiting" && state.blockers.length > 0 && (
            <div className="text-body-2-regular text-text-secondary">
              <p>{t("settings.liveUpdateWaitingReasons")}</p>
              <ul className="list-disc space-y-1 pl-5">{state.blockers.map((blocker, index) => <Blocker key={`${blocker.participant ?? "native"}:${blocker.reason}:${index}`} blocker={blocker} />)}</ul>
            </div>
          )}
          {state.errorCode && <div role="alert" className="break-words text-body-2-regular text-text-error-primary">
            <p>{t(`settings.liveUpdateErrors.${state.errorCode}`)}</p>
            {state.error && <p>{state.error}</p>}
            {state.recoveryError && <p>{state.recoveryError}</p>}
          </div>}
          {pickerError && <p role="alert" className="break-words text-body-2-regular text-text-error-primary">{t("settings.liveUpdatePickerFailed", { error: pickerError })}</p>}
          {state.requestError && <p role="alert" className="break-words text-body-2-regular text-text-error-primary">{t("statusbar.selfUpdateRequestFailed")}: {state.requestError}</p>}
          {state.canCancel && <div>
            <Button size="small" variant="secondary" onClick={() => void state.cancel()}>{t("settings.liveUpdateCancel")}</Button>
          </div>}
        </div>
      </SettingsCard>
    </section>
  );
}
