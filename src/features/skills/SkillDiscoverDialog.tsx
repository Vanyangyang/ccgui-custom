/**
 * 发现页详情：skills.sh 的条目只有 name / repo / installs，「这个技能是干什么的」
 * 要回仓库读 SKILL.md（`remote_skill_content`，按需拉取，列表不预取）。
 * 读到之前不给安装按钮下结论：描述、正文、失败原因都在同一个框里，失败时给
 * GitHub 兜底入口，不假装内容为空。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Download from "lucide-react/dist/esm/icons/download";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import { Button } from "@/components/base/buttons/button";
import { ModalShell } from "@/components/dialogs";
import { MarkdownPreview } from "@/features/files/MarkdownPreview";
import { openExternal } from "@/lib/platform";
import { SkillsHubError, skillsHubApi } from "./api";
import type { DiscoveredSkill, SkillRemoteContent } from "./types";

interface LoadedContent extends SkillRemoteContent {
  /** 后端错误码：not_found 要换成「仓库里没有这个技能」的说明，而不是裸报错。 */
  code?: string;
}

/** SKILL.md body states: loading, loaded (with truncation note), or failed
 *  with retry + repo fallback. */
function DiscoverContent({
  loading,
  content,
  error,
  notFound,
  repoUrl,
  onRetry,
}: {
  loading: boolean;
  content: LoadedContent | null;
  error: { code?: string; message: string } | null;
  notFound: boolean;
  repoUrl: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-body-2-regular text-text-secondary">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("skills.discover.contentLoading")}
      </p>
    );
  }
  if (content) {
    return (
      <div className="text-body-2-regular">
        <MarkdownPreview path={content.path} draft={content.markdown} />
        {content.truncated ? (
          <p className="mt-2 text-caption-1-regular text-text-tertiary">
            {t("skills.detail.contentTruncated")}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <p role="alert" className="text-body-2-regular text-text-error-primary">
        {notFound
          ? t("skills.discover.contentMissing")
          : t("skills.discover.contentFailed")}
      </p>
      {/* 后端原文（含具体目录名 / 限额原因）比本地文案更可诊断；
          not_found 已经由上面的说明覆盖，不再重复英文。 */}
      {error && !notFound ? (
        <p className="break-all font-mono text-caption-1-regular text-text-tertiary">
          {error.message}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button variant="secondary" size="small" onClick={onRetry}>
          {t("skills.discover.retry")}
        </Button>
        <Button
          variant="secondary"
          size="small"
          leadingIcon={ExternalLink}
          onClick={() => void openExternal(repoUrl)}
        >
          {t("skills.discover.openRepo")}
        </Button>
      </div>
    </div>
  );
}

export function SkillDiscoverDialog({
  skill,
  installed,
  busy,
  onInstall,
  onClose,
}: {
  skill: DiscoveredSkill;
  installed: boolean;
  busy: boolean;
  onInstall: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState<LoadedContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  // 关闭后晚到的响应不能再改状态。
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await skillsHubApi.remoteContent(skill);
      if (!alive.current) return;
      setContent(payload);
    } catch (caught) {
      if (!alive.current) return;
      setContent(null);
      setError({
        code: caught instanceof SkillsHubError ? caught.code : undefined,
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [skill]);

  useEffect(() => {
    void load();
  }, [load]);

  const notFound = error?.code === "not_found";
  const repoUrl = `https://github.com/${skill.repoOwner}/${skill.repoName}`;

  return (
    <ModalShell
      onClose={onClose}
      label={t("skills.discover.detailTitle", { name: skill.name })}
      className="flex max-h-[80vh] w-[560px] max-w-[94vw] flex-col"
      dialogClassName="flex min-h-0 flex-col gap-3"
    >
      <div className="flex shrink-0 flex-col gap-1">
        <h3 className="truncate text-title-3-medium text-text-primary" title={skill.name}>
          {skill.name}
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-caption-1-regular text-text-tertiary">
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 text-caption-1-regular text-accent-600 hover:underline"
            onClick={() => void openExternal(repoUrl)}
          >
            {skill.repoOwner}/{skill.repoName}
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
          {typeof skill.installs === "number" ? (
            <span>· {t("skills.discover.installs", { count: skill.installs })}</span>
          ) : null}
          {content?.path ? (
            <span className="max-w-full truncate" title={content.path}>
              · {content.path}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
        {content?.description ? (
          <p className="text-body-2-regular text-text-secondary">{content.description}</p>
        ) : null}

        <div className="min-h-[8rem] rounded-2lg border border-separator-border p-3">
          <DiscoverContent
            loading={loading}
            content={content}
            error={error}
            notFound={notFound}
            repoUrl={repoUrl}
            onRetry={() => void load()}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2">
        <p className="text-caption-1-regular text-text-tertiary">
          {t("skills.discover.installTargets")}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" size="small" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            variant="primary"
            size="small"
            leadingIcon={installed ? undefined : Download}
            disabled={busy || installed}
            onClick={onInstall}
          >
            {installed ? t("skills.discover.installed") : t("skills.discover.install")}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
