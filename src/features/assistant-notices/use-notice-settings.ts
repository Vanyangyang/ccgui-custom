import { useEffect, useRef, useState } from "react";
import { ipc, type AutoTitleModel } from "@/lib/ipc";
import { listen } from "@/lib/transport";
import { assistantNotices, isWeb } from "./api";
import { noticeConfig, noticeConfigError } from "./config";
import type { AssistantNoticeDisplay, AssistantNoticesConfig, AssistantNoticesStatus } from "./types";

export const vertexModel: AutoTitleModel = { engine: "agy_vertex", id: "gemini-4-argon", name: "Gemini 4 Argon", provider: "Vertex", resolvedModel: null, supportsEffort: true, effortLevels: ["medium"] };
export const noticeModelKey = (model: { engine: string; id: string }) => JSON.stringify([model.engine, model.id]);

export function useNoticeSettings() {
  const [status, setStatus] = useState<AssistantNoticesStatus | null>(null);
  const [draft, setDraft] = useState<AssistantNoticesConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<AutoTitleModel[]>([vertexModel]);
  const [displays, setDisplays] = useState<AssistantNoticeDisplay[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const [providers, setProviders] = useState<Record<string, string>>({});
  const edits = useRef<Partial<AssistantNoticesConfig>>({});
  const saving = useRef(false);
  const generation = useRef(0);
  const latest = useRef<AssistantNoticesStatus | null>(null);
  const baseRevision = useRef(0);
  const retry = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (isWeb) return;
    let cleanup = () => {};
    let disposeCatalogSubscriptions = () => {};
    let catalogDisposed = false;
    let catalogEpoch = 0;
    let catalogPending = false;
    let catalogRunning: Promise<void> | null = null;
    let catalogSubscriptionFailed = false;
    function refreshCatalog(): Promise<void> {
      catalogEpoch++;
      catalogPending = true;
      if (catalogRunning) return catalogRunning;
      catalogRunning = (async () => {
        while (catalogPending && !catalogDisposed) {
          catalogPending = false;
          const epoch = catalogEpoch;
          const results = await Promise.allSettled([ipc.autoTitleModels(), assistantNotices.displays(), ipc.getCliConfig()]);
          // An engine/provider change during a read invalidates the entire snapshot.
          if (catalogDisposed || epoch !== catalogEpoch) continue;
          const [modelResult, displayResult, providerResult] = results;
          if (modelResult.status === "fulfilled" && Array.isArray(modelResult.value)) {
            const callable = modelResult.value.filter(item => ["claude", "codex", "pi"].includes(item.engine));
            // Empty IDs are native's explicit "follow this engine's default" route.
            // Only offer it for engines present in the safe callable catalog.
            const defaults = [...new Set(callable.map(item => item.engine))].map(engine => ({
              engine, id: "", name: "", provider: callable.find(item => item.engine === engine)?.provider ?? "",
              resolvedModel: null, supportsEffort: false,
            }));
            setModels([vertexModel, ...defaults, ...callable.filter(item => item.id !== "")]);
          }
          if (displayResult.status === "fulfilled" && Array.isArray(displayResult.value)) setDisplays(displayResult.value);
          // Retain only provider display names, never credentials or raw settings.
          if (providerResult.status === "fulfilled" && providerResult.value) {
            const names: Record<string, string> = {};
            for (const [engine, section] of Object.entries(providerResult.value)) {
              if (!section || typeof section !== "object" || !("current" in section)) continue;
              const id = section.current;
              if (typeof id !== "string") continue;
              const record = section.providers?.[id];
          names[engine] = record && typeof record === "object" && "name" in record && typeof record.name === "string" ? record.name
            : ["", "__local_settings_json__", "__local_config_toml__", "__disabled__"].includes(id) ? "" : id;
            }
            setProviders(names);
          }
          setCatalogError(catalogSubscriptionFailed || results.some(result => result.status === "rejected"));
        }
      })().finally(() => {
        catalogRunning = null;
        if (catalogPending && !catalogDisposed) return refreshCatalog();
      });
      return catalogRunning;
    }
    async function connectCatalog() {
      disposeCatalogSubscriptions();
      catalogEpoch++;
      let disposed = false;
      const stops: Array<() => void> = [];
      catalogSubscriptionFailed = false;
      disposeCatalogSubscriptions = () => { disposed = true; stops.forEach(stop => stop()); };
      await Promise.all(["engine-config://changed", "settings://changed"].map(event =>
        listen(event, () => { if (!disposed) void refreshCatalog(); }).then(stop => {
          if (disposed) stop(); else stops.push(stop);
        }).catch(() => { if (!disposed) { catalogSubscriptionFailed = true; setCatalogError(true); } }),
      ));
      if (!disposed) await refreshCatalog();
    }
    async function connect() {
      cleanup();
      const turn = ++generation.current;
      let disposed = false;
      let stop: (() => void) | undefined;
      let eventVersion = 0;
      cleanup = () => { disposed = true; stop?.(); };
      const accept = (next: AssistantNoticesStatus, reload = false) => {
        if (disposed || turn !== generation.current || (latest.current && next.revision < latest.current.revision)) return;
        latest.current = next; setStatus(next);
        if (!Object.keys(edits.current).length || reload) {
          setDraft({ ...noticeConfig(next), ...edits.current });
          baseRevision.current = next.revision;
        }
      };
      let failed = false;
      try {
        const unsubscribe = await assistantNotices.statusChanged(next => { eventVersion++; accept(next); });
        if (disposed) { unsubscribe(); return; }
        stop = unsubscribe;
      } catch { failed = true; if (!disposed) setError("assistantNotices.settingsError"); }
      const before = eventVersion;
      try {
        const next = await assistantNotices.status();
        if (before === eventVersion) accept(next, true);
        else if (latest.current) accept(latest.current, true);
      }
      catch { failed = true; }
      if (!disposed) setError(failed ? "assistantNotices.settingsError" : "");
      if (disposed) return;
      await connectCatalog();
      if (failed) throw new Error("Assistant notice settings unavailable");
    }
    retry.current = connect;
    void connect().catch(() => {});
    return () => { cleanup(); catalogDisposed = true; catalogEpoch++; disposeCatalogSubscriptions(); generation.current++; retry.current = async () => {}; };
  }, []);
  function change(patch: Partial<AssistantNoticesConfig>) {
    if (!draft || saving.current) return;
    edits.current = { ...edits.current, ...patch };
    setDraft(current => current ? { ...current, ...patch } : current);
  }
  async function save() {
    if (!draft || !status || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    const turn = generation.current;
    try {
      const next = await assistantNotices.configure(noticeConfig(draft), baseRevision.current);
      if (turn === generation.current) {
        const current = latest.current && latest.current.revision > next.revision ? latest.current : next;
        latest.current = current; setStatus(current); setDraft(noticeConfig(current));
        baseRevision.current = current.revision; edits.current = {};
      }
    } catch (cause) { if (turn === generation.current) setError(noticeConfigError(cause)); throw cause; }
    finally { saving.current = false; if (turn === generation.current) setBusy(false); }
  }
  return { status, draft, busy, error, models, displays, providers, catalogError, dirty: Object.keys(edits.current).length > 0, change, save, retry: () => saving.current ? Promise.resolve() : retry.current() };
}
