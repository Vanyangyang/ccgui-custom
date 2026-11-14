import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { HostHandoffCatalog } from "@ccgui/plugin-sdk";
import { useTranslation } from "react-i18next";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { EFFORT_LABEL_KEYS, getEffortLevels } from "@/components/application/ai-chat/effort-levels";
import { ipc, type EngineInfo, type HandoffCompressionSelection } from "@/lib/ipc";
import { CLI_CONFIG_CHANGED_EVENT, PSEUDO_LOCAL } from "@/features/settings/providers";
import { useEngineModels } from "./components/use-engine-models";

export const COMPRESSION_ENGINES = new Set(["claude", "codex", "pi", "cursor"]);
const NO_PIN = async () => {};
const EMPTY_ENGINES: EngineInfo[] = [];
const EMPTY_CHOICES: Record<string, HandoffCompressionSelection> = {};

/** Shared discovery for the visible picker and bounded, headless catalog reads. */
export function useHandoffModelCatalog(selection: HandoffCompressionSelection, choices = EMPTY_CHOICES) {
  const [engines, setEngines] = useState(EMPTY_ENGINES);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const discovery = useRef({ generation: 0, mounted: false });
  const loadEngines = useCallback(async () => {
    if (!discovery.current.mounted) return false;
    const generation = ++discovery.current.generation;
    const isCurrent = () => discovery.current.mounted && discovery.current.generation === generation;
    try {
      const result = await ipc.listEngines();
      if (!isCurrent()) return false;
      setEngines(result);
      setStatus("loaded");
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      setStatus("error");
      throw error;
    }
  }, []);
  useEffect(() => {
    discovery.current.mounted = true;
    const load = () => { void loadEngines().catch(() => {}); };
    load();
    window.addEventListener(CLI_CONFIG_CHANGED_EVENT, load);
    return () => {
      discovery.current.mounted = false;
      discovery.current.generation += 1;
      window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, load);
    };
  }, [loadEngines]);
  const selected = useMemo(() => ({ ...choices, [selection.engine]: selection }), [choices, selection]);
  const models = useMemo(() => Object.fromEntries(Object.entries(selected).map(([id, choice]) => [id, choice.model])), [selected]);
  const providers = useMemo(() => Object.fromEntries(Object.entries(selected).map(([id, choice]) => [id, choice.providerId ?? PSEUDO_LOCAL])), [selected]);
  const supportedEngines = useMemo(() => engines.filter(engine => engine.enabled && engine.available && COMPRESSION_ENGINES.has(engine.id)), [engines]);
  // Compression uses local isolated transports, never the destination's model
  // defaults or the shared Cursor parameter preferences.
  const catalog = useEngineModels(supportedEngines, models, NO_PIN, providers, undefined, "task");
  return { engines, status, loadEngines, selected, models, providers, supportedEngines, catalog };
}

function CatalogProbe({ selection, finish }: {
  selection: HandoffCompressionSelection;
  finish: (error: Error | null, value?: HostHandoffCatalog) => void;
}) {
  const { t } = useTranslation();
  const { status, supportedEngines, providers, catalog } = useHandoffModelCatalog(selection);
  useEffect(() => {
    if (status === "error" || catalog.configStatus === "error" || catalog.settingsStatus === "error") {
      finish(new Error("HANDOFF_MODEL_CATALOG_DISCOVERY_FAILED"));
      return;
    }
    // Pending flags are populated by effects. Also require an actual outcome
    // for every discovered engine, closing the first-render readiness gap.
    if (status !== "loaded" || catalog.configStatus !== "loaded" || catalog.settingsStatus !== "loaded"
      || supportedEngines.some(engine => catalog.pendingEngines[engine.id]
        || (!catalog.catalogs[engine.id] && !catalog.failedEngines[engine.id]))) return;
    const engines: HostHandoffCatalog["engines"] = supportedEngines.map(engine => {
      const id = engine.id as HandoffCompressionSelection["engine"];
      const channels = id === "cursor" ? [] : catalog.channelsByEngine[id] ?? [];
      const requestedProvider = id === "cursor" ? PSEUDO_LOCAL : providers[id] ?? catalog.currentChannels[id] ?? PSEUDO_LOCAL;
      const providerId = requestedProvider === PSEUDO_LOCAL || channels.some(channel => channel.id === requestedProvider)
        ? requestedProvider : PSEUDO_LOCAL;
      const models = (catalog.modelsByEngine[id] ?? []).map(model => ({ id: model.id, label: model.label }));
      const available = !catalog.failedEngines[id] && models.length > 0;
      return {
        id, label: CLI_DISPLAY_NAMES[id] ?? id, available,
        models: available ? models : [],
        providers: channels.map(channel => ({ id: channel.id, label: channel.label })),
        efforts: id === "cursor" ? [] : getEffortLevels(id).map(effort => ({ id: effort, label: t(EFFORT_LABEL_KEYS[effort]) })),
        defaultSelection: { engine: id, model: models[0]?.id ?? "", providerId, ...(id === "cursor" ? {} : { effort: "medium" }) },
      };
    });
    finish(null, { selection: {
      engine: selection.engine, model: selection.model,
      providerId: selection.engine === "cursor" ? PSEUDO_LOCAL : selection.providerId ?? PSEUDO_LOCAL,
      ...(selection.engine === "cursor" ? {} : { effort: selection.effort ?? "medium" }),
    }, engines });
  }, [status, supportedEngines, providers, catalog, selection, finish, t]);
  return null;
}

class CatalogErrorBoundary extends Component<{ children: ReactNode; fail: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.fail(new Error("HANDOFF_MODEL_CATALOG_RENDER_FAILED")); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Reads the same local catalogs as /handoff in an unattached root. Never opens
 * a picker, pins chat defaults, changes Cursor parameters, or starts inference. */
export function readHandoffModelCatalog(selection: HandoffCompressionSelection): Promise<HostHandoffCatalog> {
  const container = document.createElement("div");
  const root = createRoot(container);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: HostHandoffCatalog) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      queueMicrotask(() => {
        try { root.unmount(); } catch { error ??= new Error("HANDOFF_MODEL_CATALOG_CLEANUP_FAILED"); }
        finally { container.remove(); }
        if (error) reject(error); else resolve(value!);
      });
    };
    const timer = setTimeout(() => finish(new Error("HANDOFF_MODEL_CATALOG_TIMEOUT")), 15_000);
    try {
      root.render(<CatalogErrorBoundary fail={finish}><CatalogProbe selection={{ ...selection }} finish={finish} /></CatalogErrorBoundary>);
    } catch {
      finish(new Error("HANDOFF_MODEL_CATALOG_RENDER_FAILED"));
    }
  });
}
