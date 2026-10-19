import type { PluginAgentCatalogEntry } from "@ccgui/plugin-sdk";
import type { ipc } from "@/lib/ipc";
import { providerEntries, PSEUDO_LOCAL, type EngineId } from "@/features/settings/providers";

type CatalogBackend = Pick<typeof ipc, "listEngines" | "listEngineModels" | "getCliConfig" | "cliVersionStatus" | "cliUpdatePlan">;

export async function buildAgentCatalog(
  backend: CatalogBackend,
  workspacePath: string,
  translate: (key: string) => string,
): Promise<PluginAgentCatalogEntry[]> {
  const [engines, config] = await Promise.all([backend.listEngines(), backend.getCliConfig()]);
  const hasCodex = engines.some((engine) => engine.id === "codex" && engine.enabled && engine.available);
  const [codexVersion, codexPlatform] = hasCodex
    ? await Promise.all([backend.cliVersionStatus("codex"), backend.cliUpdatePlan("codex")])
    : [null, null];
  const codexReadOnly = codexVersion?.installed === true
    && /^(?:codex-cli\s+)?0\.154\.0$/.test(codexVersion.localVersion?.trim() ?? "")
    && codexPlatform?.platform === "macos"
    && workspacePath.startsWith("/") && !workspacePath.startsWith("//");
  return Promise.all(engines.filter((engine) => engine.enabled).map(async (engine) => {
    const catalog = engine.available
      ? await backend.listEngineModels(engine.id, workspacePath).catch(() => null)
      : null;
    return {
      engine: engine.id,
      label: translate(`settings.engines.${engine.id}`),
      available: engine.available,
      readOnly: (engine.id === "pi" && engine.supportsToolConstraints === true)
        || (engine.id === "codex" && codexReadOnly),
      providers: [
        { id: PSEUDO_LOCAL, label: translate("settings.cliOfficial") },
        ...providerEntries(engine.id as EngineId, config[engine.id as EngineId])
          .map((entry) => ({ id: entry.id, label: entry.name })),
      ],
      models: (catalog?.models ?? []).map((model) => ({ id: model.id, label: model.name || model.id })),
    };
  }));
}
