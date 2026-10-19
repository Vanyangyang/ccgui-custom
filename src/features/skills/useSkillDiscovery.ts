/**
 * Discovery pane data source: repos, repo-hosted discovery, skills.sh search
 * and popular. Online requests fire only while the pane is active and the
 * user asks for them (enter/refresh) — never on settings open.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { skillsHubApi } from "./api";
import { useSkillSync } from "./use-skill-sync";
import type { DiscoveredSkill, SkillRepo, SkillTargetId } from "./types";

export interface SkillDiscoveryStore {
  repos: SkillRepo[];
  reposLoading: boolean;
  discover: DiscoveredSkill[];
  discoverLoading: boolean;
  discoverError: string | null;
  discoverCached: boolean;
  generatedAt: number | null;
  query: string;
  setQuery: (value: string) => void;
  searchResults: DiscoveredSkill[] | null;
  searchLoading: boolean;
  searchError: string | null;
  totalCount: number;
  runSearch: (query: string) => Promise<void>;
  loadPopular: (force?: boolean) => Promise<void>;
  loadDiscover: (force?: boolean) => Promise<void>;
  addRepo: (repo: { owner: string; name: string; branch: string }) => Promise<void>;
  removeRepo: (owner: string, name: string) => Promise<void>;
  install: (skill: DiscoveredSkill, targets: SkillTargetId[]) => Promise<void>;
  installingKey: string | null;
}

export function useSkillDiscovery(active: boolean): SkillDiscoveryStore {
  const [repos, setRepos] = useState<SkillRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [discover, setDiscover] = useState<DiscoveredSkill[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverCached, setDiscoverCached] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DiscoveredSkill[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [installingKey, setInstallingKey] = useState<string | null>(null);

  const sequence = useRef(0);
  const reposSequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
      reposSequence.current += 1;
    };
  }, []);

  const loadRepos = useCallback(async () => {
    const current = ++reposSequence.current;
    const canCommit = () => mounted.current && reposSequence.current === current;
    setReposLoading(true);
    try {
      const payload = await skillsHubApi.repos();
      if (!canCommit()) return;
      setRepos(payload.repos ?? []);
    } finally {
      if (canCommit()) setReposLoading(false);
    }
  }, []);

  const loadPopular = useCallback(async (force?: boolean) => {
    const current = sequence.current + 1;
    sequence.current = current;
    const canCommit = () => mounted.current && sequence.current === current;
    setDiscoverLoading(true);
    setDiscoverError(null);
    try {
      const payload = await skillsHubApi.popular(force);
      if (!canCommit()) return;
      setDiscover(payload.skills ?? []);
      setDiscoverCached(payload.cached);
      setGeneratedAt(payload.generatedAt);
    } catch (error) {
      if (!canCommit()) return;
      setDiscoverError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiscoverLoading((value) => (canCommit() ? false : value));
    }
  }, []);

  const loadDiscover = useCallback(async (force?: boolean) => {
    const current = sequence.current + 1;
    sequence.current = current;
    const canCommit = () => mounted.current && sequence.current === current;
    setDiscoverLoading(true);
    setDiscoverError(null);
    try {
      const payload = await skillsHubApi.discover(force);
      if (!canCommit()) return;
      setDiscover(payload.skills ?? []);
      setDiscoverCached(payload.cached);
      setGeneratedAt(payload.generatedAt);
    } catch (error) {
      if (!canCommit()) return;
      setDiscoverError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiscoverLoading((value) => (canCommit() ? false : value));
    }
  }, []);

  const runSearch = useCallback(async (needle: string) => {
    const current = sequence.current + 1;
    sequence.current = current;
    const canCommit = () => mounted.current && sequence.current === current;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const payload = await skillsHubApi.search(needle);
      if (!canCommit()) return;
      setSearchResults(payload.skills ?? []);
      setTotalCount(payload.totalCount ?? 0);
    } catch (error) {
      if (!canCommit()) return;
      setSearchError(error instanceof Error ? error.message : String(error));
      setSearchResults([]);
    } finally {
      setSearchLoading((value) => (canCommit() ? false : value));
    }
  }, []);

  const syncRepos = useCallback(async () => {
    setDiscoverError(null);
    await loadRepos();
  }, [loadRepos]);
  useSkillSync(active, syncRepos, setDiscoverError);

  // Repo list + the first popular load happen when the pane opens; the
  // discover tree scan stays explicit ("检查仓库" button) because it hits
  // every configured repo.
  useEffect(() => {
    if (!active) return;
    void loadRepos();
    void loadPopular(false);
  }, [active, loadRepos, loadPopular]);

  const addRepo = useCallback(
    async (repo: { owner: string; name: string; branch: string }) => {
      await skillsHubApi.addRepo(repo);
      await loadRepos();
      setSearchResults(null);
    },
    [loadRepos],
  );

  const removeRepo = useCallback(
    async (owner: string, name: string) => {
      await skillsHubApi.removeRepo(owner, name);
      await loadRepos();
    },
    [loadRepos],
  );

  const install = useCallback(async (skill: DiscoveredSkill, targets: SkillTargetId[]) => {
    setInstallingKey(skill.key);
    try {
      await skillsHubApi.install(skill, targets);
    } finally {
      if (mounted.current) setInstallingKey(null);
    }
  }, []);

  return {
    repos,
    reposLoading,
    discover,
    discoverLoading,
    discoverError,
    discoverCached,
    generatedAt,
    query,
    setQuery,
    searchResults,
    searchLoading,
    searchError,
    totalCount,
    runSearch,
    loadPopular,
    loadDiscover,
    addRepo,
    removeRepo,
    install,
    installingKey,
  };
}
