import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { Button } from "@/components/base/buttons/button";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { useChatStore } from "@/features/chat/store";
import { ENGINE_IDS, type EngineId } from "@/features/settings/providers";
import { listen } from "@/lib/transport";
import { readCliHooks, setCliHookEnabled } from "./api";
import type { CliHookEntry, CliHooksInventory } from "./types";

export function CliHooksSection() {
  const { t } = useTranslation();
  const workspace = useChatStore(state => state.active?.workspacePath ?? null);
  const activeEngine = useChatStore(state => state.active?.engine ?? "claude");
  const [engine, setEngine] = useState<EngineId>(() =>
    (ENGINE_IDS as readonly string[]).includes(activeEngine) ? activeEngine as EngineId : "claude");
  return <div className="flex w-full flex-col gap-4">
    <p className="text-body text-text-secondary">{t("cliHooks.description")}</p>
    <div role="tablist" aria-label={t("cliHooks.engines")} className="flex flex-wrap gap-1">
      {ENGINE_IDS.map((id, index) => <Button key={id} role="tab" id={`cli-hooks-tab-${id}`}
        aria-controls={`cli-hooks-panel-${id}`} aria-selected={engine === id} tabIndex={engine === id ? 0 : -1}
        variant={engine === id ? "secondary" : "ghost"} size="small" onClick={() => setEngine(id)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % ENGINE_IDS.length
            : event.key === "ArrowLeft" ? (index + ENGINE_IDS.length - 1) % ENGINE_IDS.length
            : event.key === "Home" ? 0 : event.key === "End" ? ENGINE_IDS.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); setEngine(ENGINE_IDS[next]);
          document.getElementById(`cli-hooks-tab-${ENGINE_IDS[next]}`)?.focus();
        }}>{CLI_DISPLAY_NAMES[id] ?? id}</Button>)}
    </div>
    <InventoryPanel key={JSON.stringify([engine, workspace])} engine={engine} workspace={workspace} />
  </div>;
}

function InventoryPanel({ engine, workspace }: { engine: EngineId; workspace: string | null }) {
  const { t } = useTranslation();
  const [inventory, setInventory] = useState<CliHooksInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState(false);
  const alive = useRef(false);
  const sequence = useRef(0);
  const busy = useRef(false);
  const refresh = useActionFeedback({ spin: true });

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError(false);
    try {
      const result = await readCliHooks(engine, workspace);
      if (alive.current && request === sequence.current) setInventory(result);
    } catch {
      if (alive.current && request === sequence.current) setError(true);
      throw new Error("Hook inventory unavailable");
    } finally {
      if (alive.current && request === sequence.current) setLoading(false);
    }
  }, [engine, workspace]);

  useEffect(() => {
    alive.current = true;
    const stops: Array<() => void> = [];
    for (const event of ["cli-plugins://changed", "cli-hooks://changed", "transport://connected"]) {
      void listen(event, () => { if (alive.current) void reload().catch(() => undefined); })
        .then(stop => { if (alive.current) stops.push(stop); else stop(); }).catch(() => undefined);
    }
    void reload().catch(() => undefined);
    return () => { alive.current = false; sequence.current++; stops.forEach(stop => stop()); };
  }, [reload]);

  const toggle = async (entry: CliHookEntry) => {
    if (!entry.toggle || entry.enabled === null || busy.current || loading || error) return;
    busy.current = true; setPending(true); setActionError(false);
    try {
      await setCliHookEnabled({ engine, workspace, ...entry.toggle, enabled: !entry.enabled });
      if (alive.current) await reload();
    } catch {
      if (alive.current) { setActionError(true); void reload().catch(() => undefined); }
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };

  return <section role="tabpanel" id={`cli-hooks-panel-${engine}`} aria-labelledby={`cli-hooks-tab-${engine}`}
    aria-busy={loading || pending} className="flex flex-col gap-3">
    <div className="flex items-center justify-between gap-2">
      <p className="break-all text-body text-text-secondary">{t("cliHooks.workspace")}: {workspace ?? t("cliHooks.noWorkspace")}</p>
      <Button size="small" variant="ghost" disabled={loading || refresh.feedback === "running"}
        onClick={() => { void refresh.start(reload).catch(() => undefined); }}>
        <ActionFeedbackIcon icon={RefreshCw} feedback={refresh.feedback} spin />{t("cliHooks.refresh")}
      </Button>
    </div>
    {loading && <p role="status">{t("cliHooks.loading")}</p>}
    {error && <p role="alert" className="text-notification-error-foreground">{t("cliHooks.error")}</p>}
    {actionError && <p role="alert" className="text-notification-error-foreground">{t("cliHooks.toggleError")}</p>}
    {inventory && <>
      <p className="text-body text-text-secondary">{t(inventory.coverage === "unknown" ? "cliHooks.unknownCoverage" : "cliHooks.partialCoverage")}</p>
      {inventory.warnings.map(warning => <p key={warning} role="status" className="text-body text-text-secondary">
        {t(`cliHooks.warning.${warning}`, { defaultValue: t("cliHooks.warning.generic") })}
      </p>)}
      {inventory.coverage !== "unknown" && inventory.entries.length === 0 && !loading && <p>{t("cliHooks.empty")}</p>}
      <ul className="flex flex-col gap-2">
        {inventory.entries.map(entry => <li key={entry.id} className="flex flex-col gap-1 rounded-lg border border-border-primary p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all text-body-medium">{entry.label ?? entry.event}</h3>
            <span className="rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-regular">
              {t(entry.enabled === null ? "cliHooks.stateUnknown" : entry.enabled ? "cliHooks.enabled" : "cliHooks.disabled")}
            </span>
            {entry.managed && <span className="text-caption-1-regular">{t("cliHooks.managed")}</span>}
            {entry.toggle && <Button size="small" variant="ghost" disabled={loading || pending || error}
              aria-label={t(entry.enabled ? "cliHooks.disableNamed" : "cliHooks.enableNamed", { name: entry.label ?? entry.event })}
              onClick={() => { void toggle(entry); }}>
              {t(entry.enabled ? "cliHooks.disable" : "cliHooks.enable")}
            </Button>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all text-body">
            <dt>{t("cliHooks.event")}</dt><dd>{entry.event}</dd>
            <dt>{t("cliHooks.type")}</dt><dd>{entry.handlerType}</dd>
            {entry.matcher && <><dt>{t("cliHooks.matcher")}</dt><dd>{entry.matcher}</dd></>}
            <dt>{t("cliHooks.source")}</dt><dd>{t(`cliHooks.sourceName.${entry.source}`, { defaultValue: entry.source })}</dd>
            {entry.pluginId && <><dt>{t("cliHooks.plugin")}</dt><dd>{entry.pluginId}</dd></>}
            {entry.pluginScope && <><dt>{t("cliHooks.pluginScope")}</dt><dd>{t(`cliHooks.sourceName.${entry.pluginScope}`, { defaultValue: entry.pluginScope })}</dd></>}
            {entry.sourcePath && <><dt>{t("cliHooks.path")}</dt><dd>{entry.sourcePath}</dd></>}
            {entry.trust && <><dt>{t("cliHooks.trust")}</dt><dd>{t(`cliHooks.trustState.${entry.trust}`, { defaultValue: entry.trust })}</dd></>}
          </dl>
          {entry.pluginId && <p className="text-caption-1-regular text-text-tertiary">{t("cliHooks.pluginControl")}</p>}
          {entry.toggle && <p className="text-caption-1-regular text-text-tertiary">{t(entry.toggle.scope === "codex" ? "cliHooks.codexControl" : "cliHooks.namedControl")}</p>}
        </li>)}
      </ul>
    </>}
  </section>;
}
