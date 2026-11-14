import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { ConfirmDialog } from "@/components/dialogs";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { useChatStore } from "@/features/chat/store";
import { ENGINE_IDS, type EngineId } from "@/features/settings/providers";
import { listen } from "@/lib/transport";
import { readCliPlugins, runCliPluginAction } from "./api";
import type { CliPluginAction, CliPluginEntry, CliPluginsInventory } from "./types";

const entryKey = (entry: Pick<CliPluginEntry, "id" | "scope"> & { recordKey?: string }) => entry.recordKey ?? JSON.stringify([entry.scope, entry.id]);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CliPluginsSection() {
  const { t } = useTranslation();
  const workspace = useChatStore((state) => state.active?.workspacePath ?? null);
  const activeEngine = useChatStore((state) => state.active?.engine ?? "claude");
  const [engine, setEngine] = useState<EngineId>(() =>
    (ENGINE_IDS as readonly string[]).includes(activeEngine) ? activeEngine as EngineId : "claude",
  );
  return (
    <div className="flex w-full flex-col gap-4">
      <p className="text-body text-text-secondary">{t("cliPlugins.description")}</p>
      <div role="tablist" aria-label={t("cliPlugins.engines")} className="flex flex-wrap gap-1">
        {ENGINE_IDS.map((id) => (
          <Button key={id} role="tab" id={`cli-plugins-tab-${id}`} aria-controls={`cli-plugins-panel-${id}`}
            tabIndex={engine === id ? 0 : -1}
            onKeyDown={(event) => {
              const index = ENGINE_IDS.indexOf(id);
              const next = event.key === "ArrowRight" ? (index + 1) % ENGINE_IDS.length
                : event.key === "ArrowLeft" ? (index + ENGINE_IDS.length - 1) % ENGINE_IDS.length
                : event.key === "Home" ? 0 : event.key === "End" ? ENGINE_IDS.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              setEngine(ENGINE_IDS[next]);
              document.getElementById(`cli-plugins-tab-${ENGINE_IDS[next]}`)?.focus();
            }}
            aria-selected={engine === id} variant={engine === id ? "secondary" : "ghost"}
            size="small" onClick={() => setEngine(id)}>{CLI_DISPLAY_NAMES[id] ?? id}</Button>
        ))}
      </div>
      <InventoryPanel key={JSON.stringify([engine, workspace])} engine={engine} workspace={workspace} />
    </div>
  );
}

function InventoryPanel({ engine, workspace }: { engine: EngineId; workspace: string | null }) {
  const { t } = useTranslation();
  const [inventory, setInventory] = useState<CliPluginsInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState(false);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<CliPluginEntry | null>(null);
  const [pluginId, setPluginId] = useState("");
  const [scope, setScope] = useState("");
  const alive = useRef(false);
  const sequence = useRef(0);
  const busy = useRef(false);
  const refresh = useActionFeedback({ spin: true });
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; };
  }, []);

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    setSuccess(false);
    try {
      const result = await readCliPlugins(engine, workspace);
      if (!alive.current || request !== sequence.current) return;
      setInventory(result);
    } catch (cause) {
      if (alive.current && request === sequence.current) {
        setError(errorText(cause));
      }
      throw cause;
    } finally {
      if (alive.current && request === sequence.current) setLoading(false);
    }
  }, [engine, workspace]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    for (const event of ["cli-plugins://changed", "transport://connected"]) {
      void listen(event, () => { if (!disposed) void reload().catch(() => undefined); })
        .then((off) => { if (disposed) off(); else unlisteners.push(off); })
        .catch(() => { if (!disposed) setLiveError(true); });
    }
    void reload().catch(() => undefined);
    return () => { disposed = true; unlisteners.forEach((off) => off()); };
  }, [reload]);

  const act = async (action: CliPluginAction, id: string, actionScope: string, rowKey?: string) => {
    if (busy.current || loading || !inventory?.available) return;
    busy.current = true;
    setPending(rowKey ?? entryKey({ id, scope: actionScope }));
    setError(null);
    setSuccess(false);
    try {
      await runCliPluginAction({ engine, workspace, action, pluginId: id, scope: actionScope });
      if (!alive.current) return;
      await reload();
      if (alive.current) {
        setSuccess(true);
        if (action === "install") setPluginId("");
      }
    } catch (cause) {
      if (alive.current) setError(errorText(cause));
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  };

  const disabled = loading || pending !== null;
  // A failed re-read leaves a useful snapshot, but its controls cannot make
  // another change until the user refreshes successfully.
  const mutationDisabled = disabled || error !== null;
  const installScope = inventory?.installScopes.includes(scope) ? scope : inventory?.installScopes[0] ?? "";
  const scopeLabel = (value: string) => value.startsWith("profile:")
    ? t("cliPlugins.scopes.profile", { name: value.slice("profile:".length) })
    : t(`cliPlugins.scopes.${value}`, { defaultValue: value });
  return (
    <section role="tabpanel" id={`cli-plugins-panel-${engine}`} aria-labelledby={`cli-plugins-tab-${engine}`}
      aria-busy={disabled} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="break-all text-body text-text-secondary">{t("cliPlugins.workspace")}: {workspace ?? t("cliPlugins.noWorkspace")}</p>
        <Button size="small" variant="ghost" disabled={disabled || refresh.feedback === "running"}
          onClick={() => { void refresh.start(reload).catch(() => undefined); }}>
          <ActionFeedbackIcon icon={RefreshCw} feedback={refresh.feedback} spin />{t("cliPlugins.refresh")}
        </Button>
      </div>
      {loading && <p role="status">{t("cliPlugins.loading")}</p>}
      {error && <p role="alert" className="text-notification-error-foreground">{t("cliPlugins.error", {
        message: error === "agy_plugins_disabled_by_org" ? t("cliPlugins.agyDisabledByOrg") : error,
      })}</p>}
      {liveError && <p role="status" className="text-text-secondary">{t("cliPlugins.liveUpdatesUnavailable")}</p>}
      {success && <p role="status">{t("cliPlugins.success")}</p>}
      {pending && <p role="status">{t("cliPlugins.operating")}</p>}
      {inventory && <>
        <div className="rounded-lg border border-border-primary p-3 text-body">
          <p>{t(`cliPlugins.support.${inventory.support}`)}</p>
          {!inventory.available && <p>{t("cliPlugins.unavailable")}</p>}
          {inventory.message ? <p className="whitespace-pre-wrap">{t(inventory.message)}</p>
            : inventory.support === "unsupported" && <p>{t("cliPlugins.unsupportedReasonMissing")}</p>}
        </div>
        <p className="text-body text-text-secondary">{t("cliPlugins.mcpDeclarationOnly")}</p>
        {inventory.available && inventory.installScopes.length > 0 && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
            event.preventDefault();
            if (pluginId.trim() && installScope) void act("install", pluginId.trim(), installScope);
          }}>
            <Input label={t("cliPlugins.pluginId")} value={pluginId} onChange={setPluginId} isDisabled={mutationDisabled} />
            <label className="flex flex-col gap-1 text-body">{t("cliPlugins.scope")}
              <select className="rounded-lg border border-border-primary bg-background-primary-default p-2"
                value={installScope} disabled={mutationDisabled} onChange={(event) => setScope(event.target.value)}>
                {inventory.installScopes.map((value) => <option key={value} value={value}>{scopeLabel(value)}</option>)}
              </select>
            </label>
            <Button type="submit" disabled={mutationDisabled || !pluginId.trim() || !installScope}>{t("cliPlugins.install")}</Button>
          </form>
        )}
        {inventory.entries.length === 0 && inventory.available && (inventory.support === "managed" || inventory.support === "read_only") &&
          <p role="status">{t("cliPlugins.empty")}</p>}
        <ul className="flex flex-col gap-2">
          {inventory.entries.map((entry) => (
            <li key={entryKey(entry)} className="flex flex-col gap-2 rounded-lg border border-border-primary p-3"
              aria-busy={pending === entryKey(entry)}>
              <h3 className="break-all text-body-medium">{entry.name || entry.id}</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all text-body">
                <dt>{t("cliPlugins.pluginId")}</dt><dd>{entry.id}</dd>
                <dt>{t("cliPlugins.version")}</dt><dd>{entry.version ?? t("cliPlugins.unknown")}</dd>
                <dt>{t("cliPlugins.scope")}</dt><dd>{scopeLabel(entry.scope)}</dd>
                <dt>{t("cliPlugins.status")}</dt><dd>{t(entry.enabled === null ? "cliPlugins.unknown" : entry.enabled ? "cliPlugins.enabled" : "cliPlugins.disabled")}</dd>
                {entry.projectPath && <><dt>{t("cliPlugins.projectPath")}</dt><dd>{entry.projectPath}</dd></>}
                <dt>{t("cliPlugins.mcpServers")}</dt><dd>{entry.mcpServers.length ? entry.mcpServers.join(", ") : t(entry.mcpServersKnown === false ? "cliPlugins.unknown" : "cliPlugins.noMcpServers")}{entry.mcpServers.length > 0 && entry.mcpServersKnown === false ? ` · ${t("cliPlugins.unknown")}` : ""}</dd>
              </dl>
              {inventory.available && <div className="flex flex-wrap gap-2">
                {entry.canToggle && entry.enabled !== null && <Button size="small" disabled={mutationDisabled}
                  onClick={() => { void act(entry.enabled ? "disable" : "enable", entry.recordKey ?? entry.id, entry.scope, entryKey(entry)); }}>
                  {t(entry.enabled ? "cliPlugins.disable" : "cliPlugins.enable")}</Button>}
                {entry.canToggle && entry.enabled === null && <>
                  <Button size="small" disabled={mutationDisabled} onClick={() => { void act("enable", entry.recordKey ?? entry.id, entry.scope, entryKey(entry)); }}>{t("cliPlugins.enable")}</Button>
                  <Button size="small" disabled={mutationDisabled} onClick={() => { void act("disable", entry.recordKey ?? entry.id, entry.scope, entryKey(entry)); }}>{t("cliPlugins.disable")}</Button>
                </>}
                {entry.canUpdate && <Button size="small" disabled={mutationDisabled}
                  onClick={() => { void act("update", entry.recordKey ?? entry.id, entry.scope, entryKey(entry)); }}>{t("cliPlugins.update")}</Button>}
                {entry.canUninstall && <Button size="small" variant="danger" disabled={mutationDisabled}
                  onClick={() => setConfirming(entry)}>{t("cliPlugins.uninstall")}</Button>}
              </div>}
            </li>
          ))}
        </ul>
      </>}
      {confirming && <ConfirmDialog danger
        message={t("cliPlugins.uninstallConfirm", { id: confirming.id, scope: scopeLabel(confirming.scope) })}
        onCancel={() => setConfirming(null)} onConfirm={() => {
          const entry = confirming;
          setConfirming(null);
          void act("uninstall", entry.recordKey ?? entry.id, entry.scope, entryKey(entry));
        }} />}
    </section>
  );
}
