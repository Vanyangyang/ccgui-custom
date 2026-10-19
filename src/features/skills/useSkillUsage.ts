/**
 * Usage & activity pane: skill invocation statistics (Claude Code transcripts
 * only — scope is stated in the UI) and the management action log, kept as two
 * separate lists. Missing data renders as "no data", never as a fabricated
 * zero-activity list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { skillsHubApi } from "./api";
import { useSkillSync } from "./use-skill-sync";
import type { SkillActivityEntry, SkillUsageResult } from "./types";

export interface SkillUsageStore {
  usage: SkillUsageResult | null;
  usageLoading: boolean;
  usageError: string | null;
  activity: SkillActivityEntry[];
  activityLoading: boolean;
  activityError: string | null;
  refresh: (force?: boolean) => Promise<void>;
}

export function useSkillUsage(active: boolean): SkillUsageStore {
  const [usage, setUsage] = useState<SkillUsageResult | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [activity, setActivity] = useState<SkillActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);

  const refresh = useCallback(async (force?: boolean) => {
    const current = sequence.current + 1;
    sequence.current = current;
    const canCommit = () => mounted.current && sequence.current === current;
    setUsageLoading(true);
    setActivityLoading(true);
    setUsageError(null);
    setActivityError(null);
    try {
      const payload = await skillsHubApi.usage(force);
      if (!canCommit()) return;
      setUsage(payload);
    } catch (error) {
      if (!canCommit()) return;
      setUsageError(error instanceof Error ? error.message : String(error));
    } finally {
      setUsageLoading((value) => (canCommit() ? false : value));
    }
    try {
      const payload = await skillsHubApi.activity(50);
      if (!canCommit()) return;
      setActivity(payload.activity ?? []);
    } catch (error) {
      if (!canCommit()) return;
      setActivityError(error instanceof Error ? error.message : String(error));
    } finally {
      setActivityLoading((value) => (canCommit() ? false : value));
    }
  }, []);

  useSkillSync(active, refresh, setUsageError);
  useEffect(() => {
    if (active) void refresh(false);
  }, [active, refresh]);

  return {
    usage,
    usageLoading,
    usageError,
    activity,
    activityLoading,
    activityError,
    refresh,
  };
}
