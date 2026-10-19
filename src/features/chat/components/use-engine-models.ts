import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelOption } from "@/components/application/ai-chat/cli-menu";
import type { ChannelOption } from "@/components/application/ai-chat/engine-model-panel";
import {
  collapseCursorModels,
  matchCursorBase,
  publishCursorCatalog,
  seedCursorParamsFromSlug,
  type CursorModel,
} from "@/components/application/ai-chat/cursor-models";
import { ipc, type CliConfig, type CursorCatalogModel, type EngineCatalog, type EngineInfo } from "@/lib/ipc";
import {
  CLI_CONFIG_CHANGED_EVENT,
  isPseudoProvider,
  providerEntries,
  providerFamilyModels,
  providerModel,
  PSEUDO_LOCAL,
  type EngineId,
} from "@/features/settings/providers";

// Stable fallbacks: a fresh `{}` per render would re-run every effect and
// memo keyed on `catalogs`/`pending` below.
const EMPTY_CATALOGS: Record<string, EngineCatalog> = {};
const EMPTY_PENDING: Record<string, true> = {};
const AGY_SYNC_INTERVAL_MS = 60_000;
const AGY_FOCUS_SYNC_MIN_MS = 30_000;

/** Probe identity: an engine whose availability flips (CLI installed or
 *  removed) is worth one fresh probe even in the same workspace. */
const probeKey = (engine: EngineInfo) => `${engine.id}:${engine.available ? 1 : 0}`;

/** What the composer's model picker consumes from [`useEngineModels`]. */
export interface EngineModelsState {
  catalogs: Record<string, EngineCatalog>;
  modelsByEngine: Record<string, ModelOption[]>;
  channelsByEngine: Record<string, ChannelOption[]>;
  /** 本地 Cursor 的基础模型。远程工作区为空，选择器退回该环境自己的目录。 */
  cursorPickerModels: CursorModel[];
  refresh: () => Promise<void>;
  pendingEngines: Record<string, true>;
}

function adoptCursorCatalog(models: CursorCatalogModel[]): CursorModel[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    parameters: model.parameters.map((parameter) => ({
      id: parameter.id,
      name: parameter.name,
      ...(parameter.current ? { current: parameter.current } : {}),
      options: parameter.options,
    })),
  }));
}

/** Provider configs and per-engine model catalogs feeding the CLI menu's
 * per-engine model flyouts, plus the pin effect that repairs unset or stale
 * stored model picks. */

/** Raw record of a channel. `channelId` empty → engine `section.current`. */
function channelRaw(
  engineId: string,
  cliConfig: CliConfig | null,
  channelId?: string,
): unknown {
  const section = cliConfig?.[engineId as EngineId];
  const id = (channelId || section?.current || "").trim();
  if (!id || isPseudoProvider(id)) return undefined;
  return section?.providers?.[id];
}

function configuredModel(
  engineId: string,
  cliConfig: CliConfig | null,
  channelId?: string,
): string {
  const raw = channelRaw(engineId, cliConfig, channelId);
  return raw ? providerModel(engineId as EngineId, raw).trim() : "";
}

export function useEngineModels(
  engines: EngineInfo[],
  models: Record<string, string>,
  pinModels: (updates: Record<string, string>, persist?: boolean) => Promise<void>,
  /** Session-resolved channel per engine; falls back to `section.current`. */
  providers: Record<string, string> = {},
  workspacePath?: string,
): EngineModelsState {
  const { t } = useTranslation();
  const [cliConfig, setCliConfig] = useState<CliConfig | null>(null);
  // A catalog is a property of the *context*, not of every workspace: the
  // backend answers from the local CLIs unless the workspace is a remote one
  // (a WSL distro's CLIs answer differently), so all local workspaces share
  // one catalog while each remote workspace carries its own. Caching per
  // workspace instead made refresh act on the active workspace alone — every
  // other (already cached) workspace kept serving its stale list until the
  // user refreshed it there too.
  const [localCatalogs, setLocalCatalogs] = useState<Record<string, EngineCatalog>>(
    {},
  );
  // 【cursor模型】ACP 目录带上下文等参数；失败时留空，改由文本目录折叠。
  const [cursorCatalog, setCursorCatalog] = useState<CursorModel[] | null>(null);
  const [remoteCatalogsByWs, setRemoteCatalogsByWs] = useState<
    Record<string, Record<string, EngineCatalog>>
  >({});
  // Which context a workspace's probes answered from. Until a workspace has
  // answered once it stays unresolved and gets probed (its context cannot be
  // guessed from the shared local bucket).
  const [contextByWs, setContextByWs] = useState<Record<string, "local" | "remote">>(
    {},
  );
  const wsKey = workspacePath ?? "";
  // Engine-level custom models (设置 → CLI → 自定义模型): user-added ids
  // merged into the picker next to the CLI's catalog.
  const [customModels, setCustomModels] = useState<Record<string, string[]>>({});
  const [customModelLabels, setCustomModelLabels] = useState<
    Record<string, Record<string, string>>
  >({});
  // Engines whose catalog probe is still in flight: the picker shows whatever
  // it already knows (usually just the configured model) until it lands, so
  // the panel needs to say "still loading" instead of looking truncated.
  const [pendingByWs, setPendingByWs] = useState<Record<string, Record<string, true>>>({});
  // Probes already dispatched, keyed by workspace — see the probe effect.
  const probedByWs = useRef<Record<string, Set<string>>>({});
  const catalogRequests = useRef(new Map<string, { token: object; promise: Promise<void> }>());
  const catalogRevision = useRef(0);
  const appliedCatalogRevisions = useRef(new Map<string, number>());
  const lastAgyProbeAt = useRef(0);
  useEffect(() => () => {
    catalogRequests.current.clear();
    // StrictMode replays mount effects with the same refs. Invalidating a
    // request must also permit its replacement probe in the replayed mount.
    probedByWs.current = {};
    lastAgyProbeAt.current = 0;
  }, []);

  // Provider configs feed the model picker's per-engine model lists.
  useEffect(() => {
    ipc.getCliConfig().then(setCliConfig).catch(() => {});
  }, []);
  // The settings CLI page mutates provider config and custom models outside
  // this tree; refetch so the picker tracks both immediately.
  useEffect(() => {
    const reload = () => {
      ipc.getCliConfig().then(setCliConfig).catch(() => {});
      ipc
        .getAppSettings()
        .then((s) => {
          setCustomModels(s.customModels ?? {});
          setCustomModelLabels(s.customModelLabels ?? {});
        })
        .catch(() => {});
    };
    reload();
    window.addEventListener(CLI_CONFIG_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, reload);
  }, []);
  // Catalog for the active workspace. Until the workspace's context is known
  // the shared local catalog proves nothing about it (it may be a remote one),
  // so the picker starts empty there and fills as the workspace's probes land.
  const context = wsKey === "" ? "local" : contextByWs[wsKey];
  const catalogs =
    context === "remote"
      ? (remoteCatalogsByWs[wsKey] ?? EMPTY_CATALOGS)
      : context === "local"
        ? localCatalogs
        : EMPTY_CATALOGS;
  const pending = pendingByWs[wsKey] ?? EMPTY_PENDING;
  const cursorRemote = catalogs.cursor?.remote === true;
  const cursorPickerModels = useMemo(() => {
    if (cursorRemote) return [];
    const base = cursorCatalog && cursorCatalog.length > 0
      ? cursorCatalog
      : collapseCursorModels(
        (catalogs.cursor?.models ?? []).map((model) => ({ id: model.id, label: model.name || model.id })),
      );
    // 【cursor模型】用户手写的自定义 id 不在 CLI 目录里，仍然留在列表末尾。
    const extras = (customModels.cursor ?? [])
      .filter((id) => !matchCursorBase(id, base))
      .map((id) => ({ id, name: customModelLabels.cursor?.[id]?.trim() || id, parameters: [] }));
    return extras.length > 0 ? [...base, ...extras] : base;
  }, [cursorRemote, cursorCatalog, catalogs.cursor, customModels.cursor, customModelLabels.cursor]);
  useEffect(() => {
    if (cursorRemote) return;
    publishCursorCatalog(cursorPickerModels);
  }, [cursorRemote, cursorPickerModels]);
  const loadCursorCatalog = useCallback(async () => {
    if (!engines.some((engine) => engine.id === "cursor" && engine.available)) return;
    try {
      setCursorCatalog(adoptCursorCatalog(await ipc.cursorModelCatalog()));
    } catch {
      setCursorCatalog([]);
    }
  }, [engines]);
  useEffect(() => {
    // 【cursor模型】只读本机 CLI。工作区还没确认、或已确认是远程时不套用这份目录。
    if (context !== "local") return;
    void loadCursorCatalog();
  }, [context, loadCursorCatalog]);
  // File one probe answer. A `remote` flag means the answer came from a distro
  // CLI: that workspace is a remote context and keeps its own bucket — which is
  // exactly what stops a distro list from leaking into the shared local one.
  // Everything else is local data for the one catalog every local workspace
  // shares, flag cleared (an engine-derived catalog is blank for a remote
  // workspace by contract, so its flag is local information).
  const applyCatalog = useCallback(
    (engineId: string, ws: string, list: EngineCatalog, revision: number) => {
      const bucket = JSON.stringify([engineId, list.remote && ws !== "" ? ws : ""]);
      const isLatest = revision >= (appliedCatalogRevisions.current.get(bucket) ?? 0);
      if (isLatest) appliedCatalogRevisions.current.set(bucket, revision);
      if (list.remote === true && ws !== "") {
        setContextByWs((prev) => (prev[ws] === "remote" ? prev : { ...prev, [ws]: "remote" }));
        if (!isLatest) return;
        setRemoteCatalogsByWs((prev) => ({
          ...prev,
          [ws]: { ...(prev[ws] ?? {}), [engineId]: list },
        }));
        return;
      }
      if (ws !== "") {
        setContextByWs((prev) => (prev[ws] === "local" ? prev : { ...prev, [ws]: "local" }));
      }
      if (!isLatest) return;
      setLocalCatalogs((prev) => ({
        ...prev,
        [engineId]: list.remote ? { ...list, remote: false } : list,
      }));
    },
    [],
  );
  // Live pending flags, keyed by workspace: the picker shows what it already
  // knows (usually just the configured model) until a probe lands, so the panel
  // says "still loading" instead of looking truncated. Both directions go
  // through here so a probe's start and settle can never disagree (a set flag
  // replaced rather than merged would outlive its probe).
  const markPending = useCallback(
    (ws: string, engineId: string, running: boolean) =>
      setPendingByWs((prev) => {
        const bucket = prev[ws] ?? {};
        if (running === (engineId in bucket)) return prev;
        const next = { ...bucket };
        if (running) next[engineId] = true;
        else delete next[engineId];
        return { ...prev, [ws]: next };
      }),
    [],
  );
  // Model catalogs for every engine (pi/omp probe their CLI; others return
  // empty and fall back to provider-config models below). The CLI menu's
  // per-engine model flyouts all read from this map.
  const requestCatalog = useCallback(
    (engineId: string, ws: string, force = false) => {
      const key = JSON.stringify([engineId, ws]);
      const current = catalogRequests.current.get(key);
      if (current && !force) return current.promise;
      const token = {};
      const revision = ++catalogRevision.current;
      markPending(ws, engineId, true);
      if (engineId === "agy") lastAgyProbeAt.current = Date.now();
      const promise = ipc
        .listEngineModels(engineId, ws || undefined)
        .then((list) => {
          // A settings/manual refresh can overtake an older probe. Only the
          // latest request may replace its catalog or clear its spinner.
          if (catalogRequests.current.get(key)?.token === token) applyCatalog(engineId, ws, list, revision);
        })
        .catch(() => {})
        .finally(() => {
          if (catalogRequests.current.get(key)?.token === token) {
            catalogRequests.current.delete(key);
            markPending(ws, engineId, false);
          }
        });
      catalogRequests.current.set(key, { token, promise });
      return promise;
    },
    [applyCatalog, markPending],
  );
  const probeCatalog = useCallback(
    (engineId: string) => requestCatalog(engineId, wsKey),
    [wsKey, requestCatalog],
  );
  useEffect(() => {
    // One probe per engine (per workspace, per availability state). A probe
    // that resolves without a catalog — a down DSH host, for instance —
    // must not be re-dispatched by a re-render: with `pending` in the deps
    // the flag leaving the map re-ran this effect and refired the probe, so
    // a dead host got one `session/modelCatalog` call per render (~200/s).
    // Retrying is explicit (`refresh`) or follows an availability flip.
    const probed = (probedByWs.current[wsKey] ??= new Set<string>());
    engines
      .filter((engine) => !(engine.id in catalogs) && !probed.has(probeKey(engine)))
      .forEach((engine) => {
        probed.add(probeKey(engine));
        probeCatalog(engine.id);
      });
  }, [engines, catalogs, wsKey, probeCatalog]);

  // Per-engine model lists for the CLI menu flyouts: the backend catalog
  // plus the session (or engine-default) channel's configured model — spawn
  // injects that channel's env, including claude; native files stay official.
  const modelsByEngine = useMemo(() => {
    const result: Record<string, ModelOption[]> = {};
    for (const engine of engines) {
      // 【cursor模型】选择器只列出基础模型。参数在浮层里单独选，不铺开文本目录。
      if (engine.id === "cursor" && cursorPickerModels.length > 0) {
        result[engine.id] = cursorPickerModels.map((model) => ({
          id: model.id,
          label: model.name,
          provider: "Cursor",
        }));
        continue;
      }
      const configured = configuredModel(engine.id, cliConfig, providers[engine.id]);
      const families = providerFamilyModels(
        engine.id,
        channelRaw(engine.id, cliConfig, providers[engine.id]),
      );
      const providerModels = configured ? [configured] : [];
      const current = models[engine.id]?.trim();
      const catalog = catalogs[engine.id]?.models ?? [];
      // Remote workspace (WSL distro): local channel/custom models cannot
      // run there — the distro CLI's own list is the entire menu.
      if (catalogs[engine.id]?.remote) {
        result[engine.id] = catalog.map((m) => ({
          id: m.id,
          label: m.name || m.id,
          description: m.description ?? undefined,
          provider: m.provider,
        }));
        continue;
      }
      // Channel model leads (it is what the CLI would run unprompted), the
      // backend catalog follows, then engine-level custom models, and the
      // current-override append last so the selection never vanishes.
      const known = [
        ...new Set([
          ...providerModels,
          ...catalog.map((m) => m.id),
          ...(customModels[engine.id] ?? []),
          ...(current ? [current] : []),
        ]),
      ];
      const byId = new Map(catalog.map((m) => [m.id, m]));
      result[engine.id] = known.map((m) => {
        const entry = byId.get(m);
        // The CLI's alias rows (Default/Opus/…) describe the CLI's OWN
        // settings — the official channel's. Under another channel the alias
        // runs that channel's mapped id (spawn injects its env), so the row
        // has to name it; without this the list kept showing the official
        // mapping after a channel switch.
        const mapped = families[m];
        const customLabel = customModelLabels[engine.id]?.[m]?.trim();
        return {
          id: m,
          label: mapped ?? (customLabel || entry?.name || m),
          description: mapped
            ? // The CLI menu's own row shape ("Custom Opus model"): family is
              // the alias id, capitalized the way the CLI displays it.
              t("chat.customFamilyModel", {
                family: m.charAt(0).toUpperCase() + m.slice(1),
              })
            : customLabel && customLabel !== m
              ? entry?.description
                ? `${m} · ${entry.description}`
                : m
              : entry?.description ?? undefined,
          // Channel/override ids keep the "provider/model" shape, so the
          // prefix stands in when the catalog doesn't name the provider.
          provider: entry?.provider ?? (m.includes("/") ? m.slice(0, m.indexOf("/")) : undefined),
        };
      });
    }
    return result;
  }, [engines, cliConfig, catalogs, wsKey, models, customModels, customModelLabels, providers, t, cursorPickerModels]);
  // Selectable ids WITHOUT the current-override append: what the channel,
  // the backend catalog, and the custom model list can actually serve.
  const knownIdsByEngine = useMemo(() => {
    const result: Record<string, Set<string>> = {};
    for (const engine of engines) {
      // Pin/invalidation follows the engine default, not the session channel —
      // opening a session on another channel must not rewrite defaultModels.
      const configured = configuredModel(engine.id, cliConfig);
      const ids = new Set((catalogs[engine.id]?.models ?? []).map((m) => m.id));
      // Remote workspace: only the distro CLI's list is selectable — no
      // local channel/custom ids. Custom ids stay selectable past the
      // authoritative-catalog reset on local workspaces only.
      if (!catalogs[engine.id]?.remote) {
        if (configured) ids.add(configured);
        for (const id of customModels[engine.id] ?? []) ids.add(id);
      }
      result[engine.id] = ids;
    }
    return result;
  }, [engines, cliConfig, catalogs, wsKey, customModels]);
  // Official + custom channels for the flyout. Skip the list when the engine
  // has no in-app channels — a lone 官方配置 row is noise.
  const channelsByEngine = useMemo(() => {
    const result: Record<string, ChannelOption[]> = {};
    const official: ChannelOption = {
      id: PSEUDO_LOCAL,
      label: t("settings.cliOfficial"),
    };
    for (const engine of engines) {
      const customs = providerEntries(
        engine.id as EngineId,
        cliConfig?.[engine.id as EngineId],
      ).map((entry) => ({ id: entry.id, label: entry.name }));
      result[engine.id] = customs.length > 0 ? [official, ...customs] : [];
    }
    return result;
  }, [engines, cliConfig, t]);
  // No "default" pseudo entry: an unset selection would hide which model
  // actually runs. Pin it to the first entry — the CLI's effective default.
  // An authoritative catalog also invalidates stale stored picks (leftovers
  // from older, broader catalogs) that the CLI's model flag cannot resolve.
  // All engines' pins are computed first and written in ONE store action:
  useEffect(() => {
    const updates: Record<string, string> = {};
    for (const engine of engines) {
      // Remote catalogs (WSL 发行版) are display-only: `models` is a single
      // global record, so a pin from a distro catalog would (a) put a
      // distro-only id into every local tab's picker and (b) on returning
      // to a local workspace, trip the authoritative-catalog reset below
      // and persist that id over the user's saved default. 远端 catalog
      // 永不触发 pin;用户在远端的模型选择走引擎端 resume,不落地。
      if (catalogs[engine.id]?.remote === true) continue;
      const stored = models[engine.id]?.trim();
      const fallback =
        configuredModel(engine.id, cliConfig) ||
        catalogs[engine.id]?.models[0]?.id ||
        customModels[engine.id]?.[0];
      if (!fallback) continue;
      if (!stored) {
        updates[engine.id] = fallback;
        continue;
      }
      if (engine.id === "cursor" && cursorPickerModels.length > 0) {
        const base = matchCursorBase(stored, cursorPickerModels);
        if (base) {
          if (base.id !== stored) {
            seedCursorParamsFromSlug(stored, base);
            updates[engine.id] = base.id;
          }
          continue;
        }
      }
      const catalog = catalogs[engine.id];
      if (
        catalog?.authoritative &&
        catalog.models.length > 0 &&
        !knownIdsByEngine[engine.id]?.has(stored)
      ) {
        updates[engine.id] = fallback;
      }
    }
    if (Object.keys(updates).length > 0) void pinModels(updates);
  }, [engines, models, cliConfig, catalogs, wsKey, customModels, knownIdsByEngine, pinModels, cursorPickerModels]);

  // Manual refresh from the flyout: re-read provider configs and re-probe the
  // catalogs. The probe effect skips engines already probed, so settings edits
  // otherwise only land after an app restart. Scope = the active workspace's
  // context plus every remote context already cached: all local workspaces
  // share one catalog, so refreshing any of them covers the rest, while each
  // remote (distro) workspace keeps its own and would otherwise stay stale.
  const refresh = useCallback(async () => {
    await ipc.getCliConfig().then(setCliConfig).catch(() => {});
    // Local context first — probed with the active workspace when that one is
    // local, so the spinner lands in the bucket the picker reads — then every
    // cached remote context, each of which owns its own catalog.
    const targets = [
      context === "remote" ? "" : wsKey,
      ...Object.keys(contextByWs).filter((ws) => contextByWs[ws] === "remote"),
    ];
    // Collect every probe before awaiting: the requests must all be in flight
    // at once. (An await inside the building loops would serialize them.)
    const probes: Promise<void>[] = [];
    for (const ws of targets) {
      for (const engine of engines) {
        probes.push(requestCatalog(engine.id, ws, true));
      }
    }
    await Promise.all(probes);
    if (context === "local") await loadCursorCatalog();
  }, [engines, wsKey, context, requestCatalog, contextByWs, loadCursorCatalog]);

  // AGY's account catalog changes independently of the application. Keep the
  // local picker current without polling hidden windows or restarting the app.
  const agyAvailable = engines.some((engine) => engine.id === "agy" && engine.available && engine.enabled);
  useEffect(() => {
    if (!agyAvailable) return;
    const sync = (force = false) => {
      if (!force && (document.visibilityState === "hidden" || context === "remote")) return;
      if (!force && Date.now() - lastAgyProbeAt.current < AGY_FOCUS_SYNC_MIN_MS) return;
      void requestCatalog("agy", context === "remote" ? "" : wsKey, force);
    };
    const onFocus = () => sync();
    const onConfigChanged = () => sync(true);
    const timer = window.setInterval(onFocus, AGY_SYNC_INTERVAL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener(CLI_CONFIG_CHANGED_EVENT, onConfigChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, onConfigChanged);
    };
  }, [agyAvailable, context, wsKey, requestCatalog]);

  return {
    catalogs,
    modelsByEngine,
    channelsByEngine,
    cursorPickerModels,
    refresh,
    pendingEngines: pending,
  };
}
