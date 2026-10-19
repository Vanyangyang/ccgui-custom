/**
 * Installed-skills data source: list + targets + per-entry mutations.
 *
 * Race safety: every load carries a sequence number; a late response from a
 * previous workspace/page/refresh can never overwrite newer state. Mutations
 * disable only their own row (`pendingIds`), leaving other rows operable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { skillsHubApi } from "./api";
import type {
  SkillMutationResult,
  SkillRow,
  SkillTargetId,
  SkillTargetInfo,
} from "./types";
import { sortSkills } from "./utils";
import { useSkillSync } from "./use-skill-sync";

export interface InstalledSkillsStore {
  loading: boolean;
  error: string | null;
  targets: SkillTargetInfo[];
  skills: SkillRow[];
  pendingIds: ReadonlySet<string>;
  refresh: () => Promise<void>;
  runMutation: (
    key: string,
    operation: () => Promise<SkillMutationResult>,
  ) => Promise<SkillMutationResult>;
  setTargets: (id: string, targets: SkillTargetId[]) => Promise<SkillMutationResult>;
  uninstall: (id: string) => Promise<SkillMutationResult>;
  restore: (id: string) => Promise<SkillMutationResult>;
  deleteLocal: (directory: string, targets?: SkillTargetId[]) => Promise<SkillMutationResult>;
  importLocal: (directory: string, targets: SkillTargetId[]) => Promise<SkillMutationResult>;
}

export function useInstalledSkills(active: boolean): InstalledSkillsStore {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargetList] = useState<SkillTargetInfo[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const current = sequence.current + 1;
    sequence.current = current;
    const canCommit = () => mounted.current && sequence.current === current;
    setLoading(true);
    setError(null);
    try {
      const payload = await skillsHubApi.installed();
      if (!canCommit()) return;
      setTargetList(payload.targets ?? []);
      setSkills(sortSkills(payload.skills ?? []));
    } catch (loadError) {
      if (!canCommit()) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      // 只清自己这一次的加载态；功能函数可看到最新序号，避免旧请求提前收尾。
      setLoading((value) => (canCommit() ? false : value));
    }
  }, []);

  // Lazy page: only the visible Installed pane loads; other panes never scan.
  useSkillSync(active, refresh, setError);
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const runMutation = useCallback(
    async (key: string, operation: () => Promise<SkillMutationResult>) => {
      setPendingIds((previous) => new Set(previous).add(key));
      try {
        const result = await operation();
        // Re-read instead of trusting the mutation payload: the disk is the
        // source of truth for target states after a partial failure.
        await refresh();
        return result;
      } finally {
        setPendingIds((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      }
    },
    [refresh],
  );

  const setTargets = useCallback(
    (id: string, next: SkillTargetId[]) =>
      runMutation(id, () => skillsHubApi.setTargets(id, next)),
    [runMutation],
  );
  const uninstall = useCallback(
    (id: string) => runMutation(id, () => skillsHubApi.uninstall(id)),
    [runMutation],
  );
  const restore = useCallback(
    (id: string) => runMutation(id, () => skillsHubApi.restore(id)),
    [runMutation],
  );
  const deleteLocal = useCallback(
    (directory: string, next?: SkillTargetId[]) =>
      runMutation(directory, () => skillsHubApi.deleteLocal(directory, next)),
    [runMutation],
  );
  const importLocal = useCallback(
    (directory: string, next: SkillTargetId[]) =>
      runMutation(directory, () => skillsHubApi.importLocal(directory, next)),
    [runMutation],
  );

  return {
    loading,
    error,
    targets,
    skills,
    pendingIds,
    refresh,
    runMutation,
    setTargets,
    uninstall,
    restore,
    deleteLocal,
    importLocal,
  };
}
