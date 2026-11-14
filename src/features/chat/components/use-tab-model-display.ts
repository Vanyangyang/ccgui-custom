import { useMemo } from "react";
import { getEffortLevels, normalizeEffortLevel, type EffortLevel } from "@/components/application/ai-chat/effort-levels";
import { useChatStore, type ActiveSession } from "../store";
import { latestHistoryEffort, latestHistoryModel } from "../store/stream";

/** Session records and history rows carry plain strings; anything that is not
 *  one of the picker's stops (a hand-edited settings file, an engine that
 *  reports its own vocabulary) is ignored instead of shown as a level. */
function asEffortLevel(engine: string, value: string | null | undefined): EffortLevel | undefined {
  const normalized = normalizeEffortLevel(engine, value);
  return normalized && (getEffortLevels(engine) as readonly string[]).includes(normalized)
    ? (normalized as EffortLevel)
    : undefined;
}

/** Model/effort/channel the composer menus show for the active tab.
 *
 * The picker follows the SESSION, not the CLI: an explicit pick for this
 * tab, else the model this session actually ran, else the engine default.
 * Two omp sessions in one project therefore show their own models and do
 * not change under each other when the user switches tabs.
 *
 * Subscribed as two narrow slices (strings, Object.is-compared) instead of
 * the bySession record: stream flushes swap that record every frame, and
 * the composer must not re-render with it (SessionTimeline owns that). */
export function useTabModelDisplay({
  active,
  activeEngine,
  sessionKey,
  models,
  efforts,
  providers,
}: {
  active: ActiveSession | null;
  activeEngine: string;
  sessionKey: string;
  models: Record<string, string>;
  efforts: Record<string, EffortLevel>;
  providers: Record<string, string>;
}) {
  const sessionActiveModel = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.activeModel ?? null) : null,
  );
  const sessionHistoryModel = useChatStore((s) =>
    latestHistoryModel(sessionKey ? s.bySession[sessionKey]?.messages : undefined),
  );
  const tabModel = useMemo(() => {
    if (!active || active.engine !== activeEngine) return undefined;
    // tab pick → what the engine reported running → this session's history
    // → the engine default for a session with nothing recorded yet.
    return (
      active.model ||
      sessionActiveModel ||
      sessionHistoryModel ||
      models[activeEngine]
    );
  }, [active, activeEngine, sessionActiveModel, sessionHistoryModel, models]);
  const sessionActiveEffort = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.activeEffort ?? null) : null,
  );
  const sessionHistoryEffort = useChatStore((s) =>
    latestHistoryEffort(sessionKey ? s.bySession[sessionKey]?.messages : undefined),
  );
  const tabEffort = useMemo(() => {
    if (!active || active.engine !== activeEngine) return undefined;
    return (
      asEffortLevel(activeEngine, active.sessionId === null ? active.effort : undefined) ||
      asEffortLevel(activeEngine, sessionActiveEffort) ||
      asEffortLevel(activeEngine, sessionHistoryEffort) ||
      asEffortLevel(activeEngine, efforts[activeEngine])
    );
  }, [
    active,
    activeEngine,
    sessionActiveEffort,
    sessionHistoryEffort,
    efforts,
  ]);
  const displayModels = useMemo(
    () =>
      tabModel !== undefined ? { ...models, [activeEngine]: tabModel } : models,
    [tabModel, models, activeEngine],
  );
  const displayEfforts = useMemo(
    () =>
      tabEffort !== undefined
        ? { ...efforts, [activeEngine]: tabEffort }
        : efforts,
    [tabEffort, efforts, activeEngine],
  );
  // Channel has no transcript scan: native files never record it. Tab
  // override only on a pending new-chat (same as effort).
  const sessionActiveProvider = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.activeProvider ?? null) : null,
  );
  const tabProvider = useMemo(() => {
    if (!active || active.engine !== activeEngine) return undefined;
    return (
      (active.sessionId === null ? active.provider : undefined) ||
      sessionActiveProvider ||
      providers[activeEngine]
    );
  }, [active, activeEngine, sessionActiveProvider, providers]);
  const displayProviders = useMemo(
    () =>
      tabProvider !== undefined
        ? { ...providers, [activeEngine]: tabProvider }
        : providers,
    [tabProvider, providers, activeEngine],
  );
  return { displayModels, displayEfforts, displayProviders };
}
