import { useState } from "react";
import { useTranslation } from "react-i18next";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import Settings2 from "lucide-react/dist/esm/icons/settings-2";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { Switch } from "@/components/base/switch/switch";
import { ConfirmDialog } from "@/components/dialogs";
import type { PluginInfo, PluginUpdate } from "@/lib/ipc";
import { cx } from "@/utils/cx";
import { PluginAvatar } from "./PluginAvatar";
import { useLocalArtwork } from "./artwork";
import { usePluginSettingsKey } from "./use-plugin-settings-key";
import { usePluginStates, usePluginsStore } from "../manager/usePlugins";
import type { PluginRuntimeState } from "../runtime/loader";
import { useMarketplaceStore } from "../marketplace/store";

const BADGE =
  "rounded-md bg-background-secondary-default px-1.5 py-0.5 text-xs text-text-secondary";

const ICON_BUTTON =
  "cursor-pointer rounded-lg p-1.5 text-foreground-icon-secondary transition-colors hover:bg-background-primary-hover hover:text-foreground-icon-primary disabled:cursor-not-allowed disabled:opacity-60";

/** Runtime states that get an error badge on the row; installed/loading/
 *  active are healthy and need no label. */
const STATE_LABELS: Partial<Record<PluginRuntimeState, string>> = {
  failed: "plugins.stateFailed",
  quarantined: "plugins.stateQuarantined",
  incompatible: "plugins.stateIncompatible",
};

/** One installed plugin in the 已安装 tab: identity opens details, controls
 *  stay outside the detail button (no nested buttons). */
export function PluginInstalledRow({
  plugin,
  onOpenDetail,
}: {
  plugin: PluginInfo;
  onOpenDetail: (id: string) => void;
}) {
  const uninstall = usePluginsStore((s) => s.uninstall);
  const settingsKey = usePluginSettingsKey(plugin.id);
  const update = useMarketplaceStore((s) => s.updates.find((u) => u.id === plugin.id));
  // Artwork lives outside the install record: the market index carries the
  // resolved URL, and an installed-only plugin falls back to the paths its own
  // manifest declares (read through the host). A primitive selector keeps
  // re-renders tied to the icon itself, not to every index refresh.
  const marketIcon = useMarketplaceStore(
    (s) => s.entries.find((entry) => entry.id === plugin.id)?.icon ?? null,
  );
  const localIcon = useLocalArtwork(
    marketIcon ? null : plugin.id,
    marketIcon ? null : plugin.icon,
  );
  const [confirming, setConfirming] = useState(false);
  const states = usePluginStates();
  const runtime = states.find((s) => s.id === plugin.id);
  const stateLabel = runtime ? STATE_LABELS[runtime.state] : undefined;
  const errorText = runtime?.error ?? plugin.lastError;
  const failed =
    plugin.quarantined || runtime?.state === "quarantined" || runtime?.state === "failed";

  return (
    <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-background-primary-hover">
      <PluginAvatar id={plugin.id} name={plugin.name} src={marketIcon ?? localIcon} />
      <PluginRowIdentity
        plugin={plugin}
        stateLabel={stateLabel}
        errorText={errorText}
        onOpenDetail={onOpenDetail}
      />
      <PluginRowActions
        plugin={plugin}
        update={update}
        failed={failed}
        settingsKey={settingsKey}
        onRequestUninstall={() => setConfirming(true)}
      />

      {confirming && (
        <PluginConfirmUninstall
          plugin={plugin}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void uninstall(plugin, false);
          }}
        />
      )}
    </div>
  );
}

/** Identity button: name, version/tier/source badges, runtime error badge
 *  and one-line description. */
function PluginRowIdentity({
  plugin,
  stateLabel,
  errorText,
  onOpenDetail,
}: {
  plugin: PluginInfo;
  stateLabel: string | undefined;
  errorText: string | null | undefined;
  onOpenDetail: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => onOpenDetail(plugin.id)}
      className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 text-left"
    >
      <span className="flex w-full min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-body-medium text-text-primary">{plugin.name}</span>
        {plugin.version && <span className={BADGE}>v{plugin.version}</span>}
        <span className={BADGE}>
          {t(plugin.tier === "declarative" ? "plugins.hub.tierDeclarative" : "plugins.hub.tierJs")}
        </span>
        <span className={BADGE}>{t(`plugins.source.${plugin.source}`, plugin.source)}</span>
        {stateLabel && (
          <span className={cx(BADGE, "text-text-error-primary")}>{t(stateLabel)}</span>
        )}
        {errorText && (
          <span
            className={cx(BADGE, "max-w-56 truncate text-text-error-primary")}
            title={errorText}
          >
            {errorText}
          </span>
        )}
      </span>
      {plugin.description && (
        <span className="w-full truncate text-body-2-regular text-text-secondary">
          {plugin.description}
        </span>
      )}
    </button>
  );
}

/** Trailing controls: update, retry-after-failure, settings, uninstall and
 *  the enable switch. */
function PluginRowActions({
  plugin,
  update,
  failed,
  settingsKey,
  onRequestUninstall,
}: {
  plugin: PluginInfo;
  update: PluginUpdate | undefined;
  failed: boolean;
  settingsKey: string | null;
  onRequestUninstall: () => void;
}) {
  const { t } = useTranslation();
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  const retry = usePluginsStore((s) => s.retry);
  const installing = useMarketplaceStore((s) => s.installing);
  const install = useMarketplaceStore((s) => s.install);
  // Same spin → check feedback as every other refresh action. On success the
  // row turns healthy and this button unmounts, so the flash is just the
  // consistent landing when it stays.
  const retryAction = useActionFeedback({ spin: true });
  const retrying = retryAction.feedback === "running";

  // Switch flips mirror the load/unload pair in the store; while retrying we
  // disable it so a half-cleared quarantine can't be toggled.
  return (
    <div className="flex shrink-0 items-center gap-1">
      {update && (
        <button
          type="button"
          disabled={!!installing}
          onClick={() => void install(plugin.id)}
          className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg bg-background-secondary-default px-3 py-1.5 text-body-2-medium text-text-primary transition-colors hover:bg-background-secondary-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {installing?.id === plugin.id && (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          )}
          {t("plugins.hub.updateTo", { version: update.latestVersion })}
        </button>
      )}
      {(plugin.enabled || failed) && (
        <button
          type="button"
          aria-label={t("plugins.reload")}
          title={t("plugins.reloadHint")}
          disabled={retrying}
          onClick={() => {
            if (retrying) return;
            void retryAction.start(() => retry(plugin), () => usePluginsStore.getState().error != null);
          }}
          className={ICON_BUTTON}
        >
          <ActionFeedbackIcon icon={RotateCcw} feedback={retryAction.feedback} spin />
        </button>
      )}
      {settingsKey && (
        <button
          type="button"
          aria-label={t("plugins.hub.openSettings")}
          title={t("plugins.hub.openSettings")}
          onClick={() => {
            window.location.hash = `#/settings?page=${encodeURIComponent(settingsKey)}`;
          }}
          className={ICON_BUTTON}
        >
          <Settings2 className="size-4" aria-hidden />
        </button>
      )}
      {plugin.source !== "builtin" && (
        <button
          type="button"
          aria-label={t("plugins.uninstall")}
          title={t("plugins.uninstall")}
          onClick={onRequestUninstall}
          className={ICON_BUTTON}
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      )}
      <Switch
        size="sm"
        aria-label={plugin.name}
        isDisabled={retrying}
        isSelected={plugin.enabled}
        onChange={(next) => void setEnabled(plugin, next)}
      />
    </div>
  );
}

/** Uninstall confirmation for one installed row. */
function PluginConfirmUninstall({
  plugin,
  onCancel,
  onConfirm,
}: {
  plugin: PluginInfo;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      danger
      message={t("plugins.uninstallConfirm", { name: plugin.name })}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
