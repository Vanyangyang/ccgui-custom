import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HostTaskSelection } from "@ccgui/plugin-sdk";
import { CliMenu, type EffortLevel } from "@/components/application/ai-chat/cli-menu";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { ipc, type EngineInfo } from "@/lib/ipc";
import { CLI_CONFIG_CHANGED_EVENT, PSEUDO_LOCAL } from "@/features/settings/providers";
import { useEngineModels } from "./use-engine-models";

const SUPPORTED = new Set(["claude", "codex", "agy"]);
const NO_PIN = async () => {};

export interface ManagedChildTargetPickerProps {
  selection?: HostTaskSelection;
  sourceEngine: string;
  disabled: boolean;
  supported: boolean | undefined;
  onChange(selection?: HostTaskSelection): void;
}

/** Task-local choices: catalog discovery never pins the conversation defaults. */
export function ManagedChildTargetPicker({ selection, sourceEngine, disabled, supported, onChange }: ManagedChildTargetPickerProps) {
  const { t } = useTranslation();
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    const load = () => { setLoading(true); void ipc.listEngines().then(value => { if (live) { setEngines(value); setFailed(false); setLoading(false); } }, () => { if (live) { setFailed(true); setLoading(false); } }); };
    load(); window.addEventListener(CLI_CONFIG_CHANGED_EVENT, load);
    return () => { live = false; window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, load); };
  }, []);
  const available = useMemo(() => engines.filter(item => item.enabled && item.available && SUPPORTED.has(item.id)), [engines]);
  const models = useMemo(() => selection ? { [selection.engine]: selection.model } : {}, [selection]);
  const providers = useMemo(() => selection ? { [selection.engine]: selection.providerId } : {}, [selection]);
  const catalog = useEngineModels(available, models, NO_PIN, providers, undefined, "task");
  const menuModels = Object.fromEntries(available.map(item => [item.id, models[item.id] || catalog.modelsByEngine[item.id]?.[0]?.id || ""]));
  const selectable = available.filter(item => menuModels[item.id]);
  const discovering = loading || catalog.configStatus === "loading" || Object.keys(catalog.pendingEngines).length > 0;
  const selectedChannels = { ...catalog.currentChannels, ...providers };
  const efforts = Object.fromEntries(available.map(item => [item.id, (selection?.engine === item.id ? selection.effort : undefined) ?? "medium"])) as Record<string, EffortLevel>;
  const commit = (engine: string, model: string, providerId?: string, effort?: string) => {
    if (disabled || !supported || !SUPPORTED.has(engine)) return;
    onChange({ engine: engine as HostTaskSelection["engine"], model,
      providerId: providerId ?? selectedChannels[engine] ?? PSEUDO_LOCAL,
      ...(engine === "agy" ? {} : { effort: effort ?? efforts[engine] ?? "medium" }) });
  };
  return <div role="group" aria-label={t("crossSession.managedHandoffTargetLabel")} className="flex min-w-0 flex-col gap-2">
    <span className="font-medium">{t("crossSession.managedHandoffTargetLabel")}</span>
    <label className="flex items-center gap-2"><input type="checkbox" checked={!!selection} disabled={disabled || !supported || (!selection && (loading || failed || selectable.length === 0))}
      onChange={event => {
        if (!event.target.checked) onChange(undefined);
        else { const engine = selectable.find(item => item.id === sourceEngine)?.id ?? selectable[0]?.id; if (engine) commit(engine, menuModels[engine]); }
      }} />{t("crossSession.managedHandoffTargetChoose")}</label>
    {!selection && <p role="status">{t("crossSession.managedHandoffTargetInherit")}</p>}
    {supported !== true && <p role="status">{t(supported === undefined ? "crossSession.managedHandoffTargetLoading" : "crossSession.managedHandoffTargetUnsupported")}</p>}
    {selection && <CliMenu selectionScope="task" disabled={disabled || !supported} value={selection.engine} onChange={() => {}}
      options={available.map(item => ({ id: item.id, label: CLI_DISPLAY_NAMES[item.id] ?? item.id, available: true }))}
      modelsByEngine={catalog.modelsByEngine} models={menuModels} efforts={efforts}
      channelsByEngine={catalog.channelsByEngine} selectedChannels={selectedChannels}
      onModelChange={(engine, model) => commit(engine, model)}
      onEffortChange={(engine, effort) => commit(engine, menuModels[engine] ?? "", undefined, effort)}
      onChannelChange={(engine, providerId) => commit(engine, catalog.channelModelsByEngine[engine]?.[providerId] || menuModels[engine] || "", providerId)}
      loadingEngines={Object.keys(catalog.pendingEngines)} onRefreshModels={catalog.refresh} />}
    {supported && (discovering || failed || selectable.length === 0 || (selection && (catalog.configStatus === "error" || catalog.failedEngines[selection.engine]))) && <p role="status">{t(discovering ? "chat.handoffModelsLoading" : "chat.handoffModelsFailed")}</p>}
  </div>;
}
