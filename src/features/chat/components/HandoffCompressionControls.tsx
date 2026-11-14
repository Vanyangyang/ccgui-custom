import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CliMenu, type EffortLevel } from "@/components/application/ai-chat/cli-menu";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { Switch } from "@/components/base/switch/switch";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import type { HandoffCompressionSelection } from "@/lib/ipc";
import { PSEUDO_LOCAL } from "@/features/settings/providers";
import { useHandoffStore, type HandoffCompressionMode } from "../session-cleanup";
import { isHandoffCompressionModel, legacyHandoffSelection } from "../handoff-preferences";
import { COMPRESSION_ENGINES, useHandoffModelCatalog } from "../handoff-model-catalog";
import { cx } from "@/utils/cx";
export function HandoffCompressionControls({ workspacePath, mode, compressionModel, compressionSelection, sending, compressionRunning = false }: {
  workspacePath: string;
  mode: HandoffCompressionMode;
  compressionModel: string;
  compressionSelection?: HandoffCompressionSelection;
  sending: boolean;
  compressionRunning?: boolean;
}) {
  const { t } = useTranslation();
  const setCompressionMode = useHandoffStore(s => s.setCompressionMode);
  const setCompressionSelection = useHandoffStore(s => s.setCompressionSelection);
  const selection = useMemo(() => compressionSelection ?? legacyHandoffSelection(compressionModel), [compressionSelection, compressionModel]);
  const enabled = mode === "grok";
  return <div className="flex min-w-0 flex-col gap-2">
    <HandoffModelPicker workspacePath={workspacePath} selection={selection} disabled={sending || compressionRunning}
      onSelectionChange={next => setCompressionSelection(workspacePath, next)}
      renderLeadingControl={({ loading, unavailable }) => <Switch size="sm" isSelected={enabled}
        isDisabled={sending || (!enabled && (loading || unavailable || compressionRunning))}
        onChange={value => setCompressionMode(workspacePath, value ? "grok" : "local")}>
        {t("chat.handoffUseModelCompression")}
      </Switch>} />
    {!enabled && <div role="group" aria-label={t("chat.handoffCompressionLabel")}
      className="inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-background-tertiary-default p-0.5">
      {(["local", "detailed"] as const).map(value => <button key={value} type="button"
        data-testid={`handoff-mode-${value}`} aria-pressed={mode === value} disabled={sending}
        title={t(sending ? "chat.handoffSendingLock" : value === "local" ? "chat.handoffModeLocalDesc" : "chat.handoffModeDetailedDesc")}
        onClick={() => setCompressionMode(workspacePath, value)}
        className={cx("cursor-pointer rounded-md px-2 py-0.5 text-caption-1-medium transition-colors duration-150 disabled:cursor-wait disabled:opacity-60",
          mode === value ? "bg-background-primary-default text-text-primary shadow-2xs" : "text-text-tertiary hover:text-text-secondary")}>
        {t(value === "local" ? "chat.handoffModeLocal" : "chat.handoffModeDetailed")}
      </button>)}
    </div>}
  </div>;
}

export interface HandoffModelPickerProps {
  workspacePath: string;
  selection: HandoffCompressionSelection;
  onSelectionChange: (selection: HandoffCompressionSelection) => void;
  disabled?: boolean;
  /** Keeps the handoff mode switch beside the picker without sharing store writes. */
  renderLeadingControl?: (state: { loading: boolean; unavailable: boolean }) => ReactNode;
}

/** Local discovery and selection only; callers own persistence and execution. */
export function HandoffModelPicker({ selection, onSelectionChange, disabled: sending = false, renderLeadingControl }: HandoffModelPickerProps) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<Record<string, HandoffCompressionSelection>>({});
  const { engines, status, loadEngines, selected, models, providers, supportedEngines, catalog } = useHandoffModelCatalog(selection, choices);
  const channels: typeof catalog.channelsByEngine = { ...catalog.channelsByEngine, cursor: [] };
  const selectedChannels = { ...catalog.currentChannels, ...providers };
  const menuModels = { ...models };
  const efforts: Record<string, EffortLevel> = {};
  for (const engine of supportedEngines) {
    menuModels[engine.id] ??= catalog.modelsByEngine[engine.id]?.[0]?.id ?? "";
    efforts[engine.id] = (selected[engine.id]?.effort ?? "medium") as EffortLevel;
  }
  const availableModels = catalog.modelsByEngine[selection.engine] ?? [];
  const modelMissing = catalog.catalogs[selection.engine]?.authoritative === true
    && !availableModels.some(model => model.id === selection.model);
  const providerMissing = catalog.configStatus === "loaded" && selection.providerId && selection.providerId !== PSEUDO_LOCAL
    && !channels[selection.engine]?.some(channel => channel.id === selection.providerId);
  const engineMissing = status === "loaded" && !supportedEngines.some(engine => engine.id === selection.engine);
  const unavailable = Boolean(modelMissing || providerMissing || engineMissing);
  const loading = status === "loading" || catalog.configStatus === "loading" || !!catalog.pendingEngines[selection.engine];
  const failed = status === "error" || catalog.configStatus === "error" || !!catalog.failedEngines[selection.engine]
    || (status === "loaded" && !loading && !engineMissing && !catalog.catalogs[selection.engine]);
  const modelsByEngine = { ...catalog.modelsByEngine };
  if (!availableModels.some(model => model.id === selection.model)) {
    modelsByEngine[selection.engine] = [...availableModels, { id: selection.model, label: selection.model }];
  }
  const commit = (engine: string, model: string, providerId?: string, effort?: string) => {
    if (sending || !supportedEngines.some(item => item.id === engine) || !isHandoffCompressionModel(model)) return;
    const next: HandoffCompressionSelection = {
      engine: engine as HandoffCompressionSelection["engine"], model,
      providerId: engine === "cursor" ? PSEUDO_LOCAL : providerId ?? selectedChannels[engine] ?? PSEUDO_LOCAL,
      ...(engine !== "cursor" ? { effort: effort ?? efforts[engine] ?? "medium" } : {}),
    };
    setChoices(current => ({ ...current, [engine]: next }));
    onSelectionChange(next);
  };
  const refresh = useCallback(async () => {
    if (await loadEngines()) await catalog.refresh();
  }, [catalog.refresh, loadEngines]);
  const refreshAction = useActionFeedback({ spin: true });
  const channelLabel = channels[selection.engine]?.find(channel => channel.id === selectedChannels[selection.engine])?.label
    ?? (selection.providerId !== PSEUDO_LOCAL ? selection.providerId : undefined);
  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      {renderLeadingControl?.({ loading: status === "loading", unavailable })}
      <div role="group" aria-label={t("chat.handoffCompressionModel")} className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-caption-1-regular text-text-tertiary">{t("chat.handoffCompressionModel")}</span>
        <CliMenu selectionScope="task" disabled={sending || status === "loading"}
          options={engines.filter(engine => engine.enabled).map(engine => ({
            id: engine.id, label: CLI_DISPLAY_NAMES[engine.id] ?? engine.id, available: engine.available,
            disabled: !engine.available || !COMPRESSION_ENGINES.has(engine.id),
            disabledReason: t(!COMPRESSION_ENGINES.has(engine.id) ? "chat.handoffEngineUnsupported" : "chat.handoffEngineUnavailable"),
          }))}
          value={selection.engine}
          // CliMenu announces engine changes before its model/channel callback.
          // Commit that complete selection once; do not start an intermediate call.
          onChange={() => {}}
          modelsByEngine={modelsByEngine} models={menuModels} efforts={efforts}
          onModelChange={(engine, model) => commit(engine, model)}
          onEffortChange={(engine, effort) => commit(engine, menuModels[engine] ?? "", undefined, effort)}
          channelsByEngine={channels} selectedChannels={selectedChannels}
          onChannelChange={(engine, providerId) => commit(engine,
            catalog.channelModelsByEngine[engine]?.[providerId] || menuModels[engine] || "", providerId)}
          loadingEngines={Object.keys(catalog.pendingEngines)} onRefreshModels={refresh}
        />
        {channelLabel && <span className="text-caption-1-regular text-text-tertiary">{channelLabel}</span>}
      </div>
    </div>
    {(loading || failed || unavailable) && <div className="flex items-center gap-1.5"><p role="status" className="text-caption-1-regular text-text-tertiary">
      {t(loading ? "chat.handoffModelsLoading" : unavailable ? "chat.handoffModelUnavailable" : "chat.handoffModelsFailed")}
    </p>{status === "error" && <button type="button" aria-label={t("common.refresh")}
      disabled={sending || refreshAction.feedback === "running"}
      onClick={() => { void refreshAction.start(refresh).catch(() => {}); }}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-icon-secondary hover:bg-background-secondary-hover disabled:opacity-60">
      <ActionFeedbackIcon icon={RefreshCw} feedback={refreshAction.feedback} spin iconClassName="size-3.5" />
    </button>}</div>}
  </div>;
}
