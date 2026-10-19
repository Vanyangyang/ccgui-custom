import { useTranslation } from "react-i18next";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import X from "lucide-react/dist/esm/icons/x";
import { IconButton } from "@/components/base/buttons/icon-button";
import { cx } from "@/utils/cx";
import { useWorktreeStore, type PendingCreation } from "./store";

/** errorKind（后端稳定字符串）→ i18n key 的静态映射。 */
const ERROR_KEY_BY_KIND: Record<string, string> = {
  pr_not_found: "worktree.errorPrNotFound",
  fetch_failed: "worktree.errorFetchFailed",
  branch_exists: "worktree.errorBranchExists",
  dir_exists: "worktree.errorDirExists",
  branch_checked_out: "worktree.errorBranchCheckedOut",
  branch_not_found: "worktree.errorBranchNotFound",
  base_not_found: "worktree.errorBaseNotFound",
  not_a_repo: "worktree.errorNotARepo",
  invalid_branch: "worktree.errorInvalidBranch",
  register_failed: "worktree.errorRegisterFailed",
  sparse_checkout_empty: "worktree.errorSparseCheckoutEmpty",
  unknown: "worktree.errorUnknown",
};

const STAGE_KEY: Record<string, string> = {
  validate: "worktree.progressValidate",
  fetch: "worktree.progressFetch",
  add: "worktree.progressAdd",
  register: "worktree.progressRegister",
};

/** 侧栏里的创建进度行：转圈 + 阶段文案 + 取消；失败/取消后切成 role=alert
 *  的重试行。布局高度三态一致（单行），状态切换不推动其他行。 */
export function WorktreeProgressRow({ pending }: { pending: PendingCreation }) {
  const { t } = useTranslation();
  const cancel = useWorktreeStore((s) => s.cancel);
  const retry = useWorktreeStore((s) => s.retry);
  const dismiss = useWorktreeStore((s) => s.dismiss);
  const failed = pending.stage === "failed" || pending.stage === "canceled";

  if (failed) {
    const errorText =
      pending.uncertain
        ? t("worktree.stateUnavailable")
        : pending.stage === "canceled"
        ? t("common.cancel")
        : pending.errorKind
          ? t(ERROR_KEY_BY_KIND[pending.errorKind] ?? "worktree.errorUnknown")
          : (pending.error ?? t("worktree.errorUnknown"));
    return (
      <div
        role="alert"
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-caption-1-regular"
      >
        <span className="min-w-0 flex-1 truncate text-text-error-primary">
          {t("worktree.createFailed", { branch: pending.branch })} · {errorText}
        </span>
        <button
          type="button"
          onClick={() => retry(pending.creationId)}
          className={cx(
            "shrink-0 rounded px-1 py-0.5 text-caption-1-medium text-text-primary",
            "hover:bg-background-secondary-hover",
            "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          )}
        >
          {t("worktree.retryCreate")}
        </button>
        <IconButton
          icon={X}
          size="small"
          aria-label={t("worktree.dismissRow")}
          title={t("worktree.dismissRow")}
          onClick={() => dismiss(pending.creationId)}
        />
      </div>
    );
  }

  return (
    <div className="flex h-8 items-center gap-1.5 rounded-lg px-2">
      <Loader2
        aria-hidden
        className="size-3.5 shrink-0 animate-spin text-foreground-icon-secondary motion-reduce:animate-none"
      />
      <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-secondary">
        {t(STAGE_KEY[pending.stage] ?? "worktree.progressValidate", {
          branch: pending.branch,
          detail: pending.detail ?? "",
        })}
      </span>
      <IconButton
        icon={X}
        size="small"
        aria-label={t("worktree.cancelCreate")}
        title={t("worktree.cancelCreate")}
        onClick={() => cancel(pending.creationId)}
      />
    </div>
  );
}
