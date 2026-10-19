/**
 * 发现: repo discovery (explicit scan), skills.sh search, popular list and
 * repo management. Online calls only happen from user actions on this pane.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Download from "lucide-react/dist/esm/icons/download";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Search from "lucide-react/dist/esm/icons/search";
import Settings2 from "lucide-react/dist/esm/icons/settings-2";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { CenteredSpinner, EmptyState } from "@/components/base/empty-state";
import { ModalShell } from "@/components/dialogs";
import { ActionFeedbackIcon, useActionFeedback, type ActionFeedback } from "@/components/base/action-feedback";
import { FeedbackLine, type Feedback } from "./components";
import { SkillDiscoverDialog } from "./SkillDiscoverDialog";
import { useSkillDiscovery } from "./useSkillDiscovery";
import type { DiscoveredSkill } from "./types";

type BrowseMode = "popular" | "repos";

function DiscoverRow({
  skill,
  busy,
  installed,
  onOpen,
  onInstall,
}: {
  skill: DiscoveredSkill;
  busy: boolean;
  installed: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-2 rounded-2lg border border-separator-border px-3 py-2">
      {/* 行主体点开详情：skills.sh 只有 name / repo / installs，描述与正文
          都在仓库的 SKILL.md 里，不点进去就只能猜。安装按钮是兄弟节点。 */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("skills.discover.open", { name: skill.name })}
        className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <span className="w-full truncate text-body-regular text-text-primary" title={skill.name}>
          {skill.name}
        </span>
        {skill.description ? (
          <span className="w-full truncate text-caption-1-regular text-text-secondary">
            {skill.description}
          </span>
        ) : null}
        <span className="w-full truncate text-caption-1-regular text-text-tertiary">
          {skill.repoOwner}/{skill.repoName}
          {typeof skill.installs === "number"
            ? ` · ${t("skills.discover.installs", { count: skill.installs })}`
            : ""}
        </span>
      </button>
      <Button
        variant="secondary"
        size="xs"
        disabled={busy || installed}
        onClick={onInstall}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Download className="size-4" aria-hidden />
        )}
        {installed ? t("skills.discover.installed") : t("skills.discover.install")}
      </Button>
    </li>
  );
}

/** Search input plus the search / refresh actions. */
function DiscoverSearchBar({
  query,
  onQueryChange,
  busy,
  onSearch,
  refreshFeedback,
  onRefresh,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  busy: boolean;
  onSearch: () => void;
  refreshFeedback: ActionFeedback;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={t("skills.discover.searchPlaceholder")}
        placeholder={t("skills.discover.searchPlaceholder")}
        value={query}
        onChange={onQueryChange}
        onKeyDown={(event) => {
          // IME 组合中的 Enter 是在确认候选词，不能当成提交搜索。
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") onSearch();
        }}
        leadingIcon={Search}
        size="small"
        className="flex-1"
      />
      <Button variant="secondary" size="small" disabled={busy} onClick={onSearch}>
        {t("skills.discover.search")}
      </Button>
      <Button variant="secondary" size="small" disabled={busy} onClick={onRefresh}>
        <ActionFeedbackIcon icon={RefreshCw} feedback={refreshFeedback} spin />
        {t("common.refresh")}
      </Button>
    </div>
  );
}

/** Popular / repos switch, repo management and the explicit repo scan. */
function BrowseModeBar({
  mode,
  onModeChange,
  onManageRepos,
  onScan,
  scanBusy,
  scanFeedback,
}: {
  mode: BrowseMode;
  onModeChange: (mode: BrowseMode) => void;
  onManageRepos: () => void;
  onScan: () => void;
  scanBusy: boolean;
  scanFeedback: ActionFeedback;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant={mode === "popular" ? "primary" : "secondary"}
        size="xs"
        onClick={() => onModeChange("popular")}
      >
        {t("skills.discover.popular")}
      </Button>
      <Button
        variant={mode === "repos" ? "primary" : "secondary"}
        size="xs"
        onClick={() => onModeChange("repos")}
      >
        {t("skills.discover.repos")}
      </Button>
      <span className="flex-1" />
      <Button variant="secondary" size="xs" onClick={onManageRepos}>
        {t("skills.discover.manageRepos")}
      </Button>
      {mode === "repos" ? (
        <Button
          variant="secondary"
          size="xs"
          disabled={scanBusy}
          onClick={onScan}
        >
          <ActionFeedbackIcon icon={RefreshCw} feedback={scanFeedback} spin />
          {t("skills.discover.scan")}
        </Button>
      ) : null}
    </div>
  );
}

/** Search result count + "back to popular". */
function SearchSummaryBar({
  totalCount,
  onClear,
}: {
  totalCount: number;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-caption-1-regular text-text-tertiary">
        {t("skills.discover.resultCount", { count: totalCount })}
      </p>
      <Button variant="secondary" size="xs" onClick={onClear}>
        {t("skills.discover.clearSearch")}
      </Button>
    </div>
  );
}

/** Scope hint under the browse bar (popular ranking / configured repos). */
function DiscoverHint({
  mode,
  repoCount,
  cached,
}: {
  mode: BrowseMode;
  repoCount: number;
  cached: boolean;
}) {
  const { t } = useTranslation();
  return (
    <p className="text-caption-1-regular text-text-tertiary">
      {mode === "popular"
        ? t("skills.discover.popularHint")
        : t("skills.discover.reposHint", { count: repoCount })}
      {cached ? ` · ${t("skills.discover.cached")}` : ""}
    </p>
  );
}

/** List / first-load spinner / empty state for the current browse mode. */
function DiscoverResults({
  listed,
  busy,
  isSearch,
  installingKey,
  installedKeys,
  onOpen,
  onInstall,
}: {
  listed: DiscoveredSkill[];
  busy: boolean;
  isSearch: boolean;
  installingKey: string | null;
  installedKeys: ReadonlySet<string>;
  onOpen: (skill: DiscoveredSkill) => void;
  onInstall: (skill: DiscoveredSkill) => void;
}) {
  const { t } = useTranslation();
  if (busy && listed.length === 0) {
    return <CenteredSpinner className="py-10" />;
  }
  if (listed.length === 0) {
    return (
      <EmptyState className="py-10">
        <p className="text-body-2-regular">
          {isSearch ? t("skills.discover.noResults") : t("skills.discover.none")}
        </p>
      </EmptyState>
    );
  }
  return (
    <ul className="flex w-full flex-col gap-1">
      {listed.map((skill) => (
        <DiscoverRow
          key={skill.key}
          skill={skill}
          busy={installingKey === skill.key}
          installed={installedKeys.has(skill.key)}
          onOpen={() => onOpen(skill)}
          onInstall={() => onInstall(skill)}
        />
      ))}
    </ul>
  );
}

export function DiscoverPane() {
  const { t } = useTranslation();
  const discovery = useSkillDiscovery(true);
  const [mode, setMode] = useState<BrowseMode>("popular");
  /** Keys installed from this pane (session-local): the row flips to 已安装
   *  instead of inviting a second install. A full list refresh happens in
   *  the 我的 Skills tab. */
  const [installedKeys, setInstalledKeys] = useState<ReadonlySet<string>>(new Set());
  /** 详情弹窗选中的条目：从当前列表派生，列表换了（搜索 / 切模式）自动关。 */
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [reposOpen, setReposOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const repoRefresh = useActionFeedback({ spin: true });
  const discoverRefresh = useActionFeedback({ spin: true });

  const flash = (next: Feedback, ttlMs = 4000) => {
    setFeedback(next);
    if (ttlMs > 0) {
      window.setTimeout(() => {
        setFeedback((current) => (current === next ? null : current));
      }, ttlMs);
    }
  };

  const install = async (skill: DiscoveredSkill) => {
    try {
      await discovery.install(skill, ["claude", "codex"]);
      setInstalledKeys((previous) => new Set(previous).add(skill.key));
      flash({ tone: "success", text: t("skills.feedback.installed", { name: skill.name }) });
    } catch (error) {
      flash({ tone: "error", text: error instanceof Error ? error.message : String(error) }, 0);
    }
  };

  const listed = discovery.searchResults ?? discovery.discover;
  const isSearch = discovery.searchResults !== null;
  const busy = discovery.searchLoading || discovery.discoverLoading;
  const error = isSearch ? discovery.searchError : discovery.discoverError;
  const detailSkill = useMemo(
    () => listed.find((skill) => skill.key === detailKey) ?? null,
    [listed, detailKey],
  );

  const runSearch = () => {
    const trimmed = discovery.query.trim();
    if (trimmed.length < 2) {
      flash({ tone: "error", text: t("skills.discover.searchHint") });
      return;
    }
    void discovery.runSearch(trimmed);
  };

  const refresh = () => {
    if (repoRefresh.feedback === "running") return;
    void repoRefresh
      .start(() =>
        isSearch
          ? discovery.runSearch(discovery.query.trim())
          : mode === "popular"
            ? discovery.loadPopular(true)
            : discovery.loadDiscover(true),
      )
      .catch((err: unknown) =>
        flash({ tone: "error", text: err instanceof Error ? err.message : String(err) }, 0),
      );
  };

  const scan = () => {
    if (discoverRefresh.feedback === "running") return;
    void discoverRefresh
      .start(() => discovery.loadDiscover(true))
      .catch((err: unknown) =>
        flash({ tone: "error", text: err instanceof Error ? err.message : String(err) }, 0),
      );
  };

  const clearSearch = () => {
    discovery.setQuery("");
    void discovery.loadPopular(false);
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <DiscoverSearchBar
        query={discovery.query}
        onQueryChange={discovery.setQuery}
        busy={busy}
        onSearch={runSearch}
        refreshFeedback={repoRefresh.feedback}
        onRefresh={refresh}
      />

      {isSearch ? (
        <SearchSummaryBar totalCount={discovery.totalCount} onClear={clearSearch} />
      ) : (
        <BrowseModeBar
          mode={mode}
          onModeChange={setMode}
          onManageRepos={() => setReposOpen(true)}
          onScan={scan}
          scanBusy={discovery.discoverLoading}
          scanFeedback={discoverRefresh.feedback}
        />
      )}

      {isSearch ? null : (
        <DiscoverHint
          mode={mode}
          repoCount={discovery.repos.length}
          cached={discovery.discoverCached}
        />
      )}

      <FeedbackLine feedback={feedback} />
      {error ? (
        <p role="alert" className="text-body-2-regular text-text-error-primary">
          {error}
        </p>
      ) : null}

      <DiscoverResults
        listed={listed}
        busy={busy}
        isSearch={isSearch}
        installingKey={discovery.installingKey}
        installedKeys={installedKeys}
        onOpen={(skill) => setDetailKey(skill.key)}
        onInstall={(skill) => void install(skill)}
      />

      {detailSkill ? (
        <SkillDiscoverDialog
          skill={detailSkill}
          installed={installedKeys.has(detailSkill.key)}
          busy={discovery.installingKey === detailSkill.key}
          onInstall={() => void install(detailSkill)}
          onClose={() => setDetailKey(null)}
        />
      ) : null}

      {reposOpen ? (
        <RepoDialog
          repos={discovery.repos}
          loading={discovery.reposLoading}
          onClose={() => setReposOpen(false)}
          onAdd={async (repo) => {
            await discovery.addRepo(repo);
          }}
          onRemove={async (owner, name) => {
            await discovery.removeRepo(owner, name);
          }}
        />
      ) : null}
    </div>
  );
}

function RepoDialog({
  repos,
  loading,
  onClose,
  onAdd,
  onRemove,
}: {
  repos: { owner: string; name: string; branch: string; enabled: boolean }[];
  loading: boolean;
  onClose: () => void;
  onAdd: (repo: { owner: string; name: string; branch: string }) => Promise<void>;
  onRemove: (owner: string, name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAdd({ owner: owner.trim(), name: name.trim(), branch: branch.trim() || "main" });
      setOwner("");
      setName("");
      setBranch("main");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      label={t("skills.repos.title")}
      className="w-[460px] max-w-[94vw]"
      dialogClassName="flex flex-col gap-3"
    >
      <h3 className="text-title-3-medium text-text-primary">{t("skills.repos.title")}</h3>
      <p className="text-body-2-regular text-text-secondary">{t("skills.repos.desc")}</p>
      {loading ? (
        <CenteredSpinner className="py-4" />
      ) : (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {repos.map((repo) => (
            <li
              key={`${repo.owner}/${repo.name}`}
              className="flex items-center justify-between gap-2 rounded-2lg border border-separator-border px-2 py-1.5"
            >
              <span className="truncate text-body-2-regular text-text-primary">
                {repo.owner}/{repo.name}
                <span className="ml-1 text-text-tertiary">@{repo.branch}</span>
              </span>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => void onRemove(repo.owner, repo.name)}
              >
                {t("common.delete")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <Input
          aria-label={t("skills.repos.owner")}
          label={t("skills.repos.owner")}
          value={owner}
          onChange={setOwner}
          size="small"
          className="flex-1"
        />
        <Input
          aria-label={t("skills.repos.name")}
          label={t("skills.repos.name")}
          value={name}
          onChange={setName}
          size="small"
          className="flex-1"
        />
        <Input
          aria-label={t("skills.repos.branch")}
          label={t("skills.repos.branch")}
          value={branch}
          onChange={setBranch}
          size="small"
          className="w-24"
        />
      </div>
      {error ? (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="small" onClick={onClose}>
          {t("common.close")}
        </Button>
        <Button
          variant="primary"
          size="small"
          disabled={busy || !owner.trim() || !name.trim()}
          onClick={() => void add()}
        >
          <Settings2 className="size-4" aria-hidden />
          {t("skills.repos.add")}
        </Button>
      </div>
    </ModalShell>
  );
}
