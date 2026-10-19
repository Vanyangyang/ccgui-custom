/**
 * Skills hub IPC types — mirror `src-tauri/src/skills_hub/mod.rs` (camelCase).
 *
 * The query/mutate commands are a transport detail: pages consume these
 * discriminated shapes, never `any`.
 */

/** Where a skill comes from. `managed` = the app's own copy (SSOT); the
 *  others are read-only sources the app merely displays. */
export type SkillSourceKind = "managed" | "local" | "builtin" | "system" | "plugin";

/** Sync targets the engine adapters implement: every CLI the app drives,
 *  plus the shared cross-agent root. `agents` stays hidden from the engine
 *  list but is part of the state (`~/.agents/skills` is read by several CLIs). */
export type SkillTargetId =
  | "claude"
  | "codex"
  | "kimi"
  | "grok"
  | "pi"
  | "omp"
  | "dsh"
  | "agy"
  | "gemini"
  | "opencode"
  | "qoder"
  | "qoder-cn"
  | "hermes"
  | "agents";

export type SkillTargetState = "off" | "synced" | "orphan";

export interface SkillTargetInfo {
  id: string;
  label: string;
  path: string;
  readonly: boolean;
  /** The CLI's home exists on this machine. Targets that are not installed are
   *  hidden by the UI unless a copy (or a missing copy) already lives there. */
  available: boolean;
}

export interface SkillRow {
  id: string;
  key: string;
  name: string;
  description: string;
  directory: string;
  sourceDirectory?: string | null;
  readmeUrl: string | null;
  repoOwner: string | null;
  repoName: string | null;
  repoBranch: string | null;
  installedAt: number | null;
  managed: boolean;
  sourceKind: SkillSourceKind;
  readonly: boolean;
  targets: SkillTargetId[];
  targetStates: Record<string, SkillTargetState>;
  targetPaths?: Record<string, string>;
}

export interface SkillsInstalledResult {
  targets: SkillTargetInfo[];
  skills: SkillRow[];
  generatedAt: number;
}

export interface DiscoveredSkill {
  key: string;
  name: string;
  description: string;
  directory: string;
  readmeUrl: string | null;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  installs?: number;
}

export interface SkillDiscoverResult {
  skills: DiscoveredSkill[];
  cached: boolean;
  generatedAt: number;
}

export interface SkillSearchResult {
  query: string;
  totalCount: number;
  skills: DiscoveredSkill[];
}

export interface SkillRepo {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
}

export interface SkillUpdateResult {
  updates: Record<string, boolean>;
  checkedAt: number | null;
  cached: boolean;
}

export type SkillActivityAction =
  | "install"
  | "uninstall"
  | "restore"
  | "set_targets"
  | "import"
  | "delete_local"
  | string;

export interface SkillActivityEntry {
  ts: number;
  action: SkillActivityAction;
  name?: string | null;
  directory?: string | null;
  targets?: string[] | null;
  source?: string | null;
}

export interface SkillUsageTokens {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface SkillUsageEntry {
  skill: string;
  invocations: number;
  lastUsedAt: string | null;
  tokens: SkillUsageTokens | null;
  installed: boolean;
  skillId: string | null;
  directory: string | null;
}

export interface SkillUsageResult {
  /** Statistics scope; currently always Claude Code transcripts. */
  engine: "claude";
  scope: "claude_code_transcripts";
  generatedAt: number | null;
  scannedFiles: number;
  totalInvocations: number;
  cached: boolean;
  skills: SkillUsageEntry[];
  unusedInstalled: { skillId: string | null; directory: string | null; name: string | null }[];
}

/** Per-target outcome of a multi-target operation.
 *  `kept` marks a target whose copy is the user's own source directory: the app
 *  never deletes it, so a "remove" that keeps it is a correct outcome — but the
 *  UI must not report it as "removed". */
export interface SkillTargetResult {
  target: string;
  ok: boolean;
  error: string | null;
  kept?: boolean;
}

export interface SkillMutationResult {
  ok: boolean;
  skill?: SkillRow;
  targetResults?: SkillTargetResult[];
  trashed?: boolean;
  restoreId?: string | null;
  ttlMs?: number;
}

export interface SkillContentResult {
  directory: string;
  path: string;
  markdown: string;
  truncated: boolean;
}

/** skills.sh 条目本身只有 name / repo / installs；详情是回仓库读的 SKILL.md。 */
export interface SkillRemoteContent {
  name: string;
  description: string;
  /** 仓库里的目录（`skills/react-best-practices`）。 */
  directory: string;
  /** 仓库里的文件路径（`skills/react-best-practices/SKILL.md`）。 */
  path: string;
  /** 该文件在 GitHub 上的可读地址。 */
  url: string;
  repoUrl: string;
  markdown: string;
  truncated: boolean;
  branch: string;
}

/** Query modes of `skills_hub_query`. */
export type SkillsQuery =
  | { mode: "installed" }
  | { mode: "discover"; force?: boolean }
  | { mode: "search"; q: string; offset?: number; limit?: number }
  | { mode: "repos" }
  | { mode: "popular"; force?: boolean }
  | { mode: "updates"; force?: boolean }
  | { mode: "activity"; limit?: number }
  | { mode: "skill_usage"; force?: boolean }
  | { mode: "skill_content"; directory: string }
  | {
      mode: "remote_skill_content";
      owner: string;
      name: string;
      branch: string;
      directory: string;
    };

/** Mutation actions of `skills_hub_mutate`: the action plus everything the
 *  backend reads out of the `payload` it receives. `mutate()` in `api.ts`
 *  splits the two. */
export type SkillsMutation =
  | {
      action: "install";
      /** Acknowledges overwriting a locally modified managed copy (updates). */
      force?: boolean;
      skill: {
        name: string;
        description: string;
        directory: string;
        repoOwner: string;
        repoName: string;
        repoBranch: string;
      };
      targets: SkillTargetId[];
    }
  | { action: "uninstall"; id: string }
  | { action: "restore"; id: string }
  | { action: "set_targets"; id: string; targets: SkillTargetId[] }
  | { action: "import_local"; directory: string; targets: SkillTargetId[] }
  | { action: "delete_local"; directory: string; targets?: SkillTargetId[] }
  | { action: "add_repo"; repo: { owner: string; name: string; branch: string } }
  | { action: "remove_repo"; owner: string; name: string };

/** Error codes the hub backend normalizes to. */
export type SkillErrorCode =
  | "rate_limited"
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "readonly"
  | "permission"
  | "network"
  | "http"
  | "internal";
