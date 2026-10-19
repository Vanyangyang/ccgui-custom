/**
 * Field groups for the worktree-create dialog: the branch combobox, the
 * PR / new-branch / existing-branch source blocks, and the PR preview card.
 * All state stays in the dialog's form hook; these are presentational.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Search from "lucide-react/dist/esm/icons/search";
import { Input } from "@/components/base/input/input";
import {
  Dropdown,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import type { BranchInfo, PrPreview } from "@/lib/ipc";
import { cx } from "@/utils/cx";

/** Searchable branch picker mirroring the changes panel's branch dropdown
 *  (trigger + sticky search + scrollable rows). `blocked` names render as
 *  disabled plain rows with the reason — not as fake buttons. */
export function BranchCombobox({
  branches,
  value,
  onSelect,
  placeholder,
  blocked,
  blockedReason,
  ariaLabel,
  remoteLabel,
}: {
  branches: BranchInfo[];
  value: string | null;
  onSelect: (name: string) => void;
  placeholder: string;
  blocked?: Set<string>;
  blockedReason?: string;
  ariaLabel: string;
  /** Trailing tag on remote-tracking rows (t("git.remoteBranch")). */
  remoteLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Opening the popup should hand focus to its search field (combobox
  // pattern). Done here instead of `autoFocus` so opening a popover inside an
  // already-focused dialog does not announce as an on-load autofocus.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return branches.filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [branches, query]);
  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <DropdownTrigger
        className={cx(
          "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg border border-border-button-default",
          "px-2 text-body-medium text-text-primary shadow-xs",
          "hover:bg-background-secondary-hover",
        )}
      >
        <GitBranch aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
        <span className={cx("truncate", !value && "text-text-placeholder")}>
          {value ?? placeholder}
        </span>
        <ChevronDown aria-hidden className="ml-auto size-4 shrink-0 text-foreground-icon-tertiary" />
      </DropdownTrigger>
      <DropdownPopover aria-label={ariaLabel} placement="bottom start" className="max-h-80!">
        <div className="sticky -top-2.5 z-10 -mx-2.5 -mt-2.5 bg-background-primary-default px-2.5 pt-2.5 pb-1">
          <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border-button-default px-2">
            <Search aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="min-w-0 flex-1 bg-transparent text-body-medium text-text-primary outline-none placeholder:text-text-placeholder"
            />
          </div>
        </div>
        {filtered.map((b) => {
          const isBlocked = blocked?.has(b.name) ?? false;
          if (isBlocked) {
            return (
              <div
                key={`${b.isRemote ? "r" : "l"}:${b.name}`}
                className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg p-2 text-body-medium text-text-disabled"
                title={blockedReason}
              >
                <span className="truncate">{b.name}</span>
                <span className="ml-auto shrink-0 text-caption-1-regular text-text-tertiary">
                  {blockedReason}
                </span>
              </div>
            );
          }
          return (
            <button
              key={`${b.isRemote ? "r" : "l"}:${b.name}`}
              type="button"
              onClick={() => {
                onSelect(b.name);
                setOpen(false);
                setQuery("");
              }}
              className="flex w-full items-center gap-2 rounded-lg p-2 text-left text-body-medium text-text-primary outline-none hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <span className="truncate">{b.name}</span>
              {b.isRemote && (
                <span className="ml-auto shrink-0 text-caption-1-regular text-text-tertiary">
                  {remoteLabel}
                </span>
              )}
            </button>
          );
        })}
      </DropdownPopover>
    </Dropdown>
  );
}

/** PR fetch result: title/state line, author/stat line, and conflict alerts. */
function PrPreviewCard({
  preview,
  effectiveBranch,
  base,
}: {
  preview: PrPreview;
  effectiveBranch: string;
  base: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border-button-default bg-background-secondary-default p-2.5">
      {preview.degraded ? (
        <div className="text-body-medium text-text-secondary">
          {t("worktree.prPreviewDegraded", {
            number: preview.number,
            repo: preview.repo,
          })}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-body-medium text-text-primary">
            <span className="min-w-0 flex-1 truncate">{preview.title}</span>
            {preview.state === "MERGED" && (
              <span className="shrink-0 rounded-full bg-status-purple-background px-1.5 py-0.5 text-caption-1-regular text-status-purple-text">
                {t("worktree.prStateMerged")}
              </span>
            )}
            {preview.state === "CLOSED" && (
              <span className="shrink-0 rounded-full bg-status-rose-background px-1.5 py-0.5 text-caption-1-regular text-status-rose-text">
                {t("worktree.prStateClosed")}
              </span>
            )}
          </div>
          <div className="text-caption-1-regular text-text-tertiary">
            {[
              preview.author &&
                t("worktree.prPreviewAuthor", { author: preview.author, base: base ?? "main" }),
              typeof preview.additions === "number" &&
                `+${preview.additions} −${preview.deletions ?? 0}`,
              t("worktree.prPreviewBranch", { branch: effectiveBranch }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </>
      )}
      {preview.branchConflict && (
        <div role="alert" className="text-caption-1-regular text-text-error-primary">
          {t("worktree.branchConflict", { branch: effectiveBranch })}
        </div>
      )}
      {preview.dirConflict && (
        <div role="alert" className="text-caption-1-regular text-text-error-primary">
          {t("worktree.dirConflict")}
        </div>
      )}
    </div>
  );
}

/** PR source: input, parse/resolve status, and the resolved preview. */
export function PrSourceFields({
  prInput,
  prNumber,
  preview,
  resolving,
  resolveError,
  effectiveBranch,
  base,
  onPrInputChange,
}: {
  prInput: string;
  prNumber: number | null;
  preview: PrPreview | null;
  resolving: boolean;
  resolveError: "notGitHub" | "invalidPrInput" | null;
  effectiveBranch: string;
  base: string | null;
  onPrInputChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Input
        autoFocus
        size="small"
        label={t("worktree.prInputLabel")}
        placeholder={t("worktree.prInputPlaceholder")}
        hint={t("worktree.prInputHint")}
        value={prInput}
        onChange={onPrInputChange}
        isInvalid={prInput.trim() !== "" && prNumber == null}
      />
      {prInput.trim() !== "" && prNumber == null && (
        <div role="alert" className="text-caption-1-regular text-text-error-primary">
          {t("worktree.invalidPrInput")}
        </div>
      )}
      {resolving && (
        <div className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {t("worktree.resolving")}
        </div>
      )}
      {resolveError && (
        <div role="alert" className="text-caption-1-regular text-text-error-primary">
          {t(`worktree.${resolveError}`)}
        </div>
      )}
      {preview && (
        <PrPreviewCard preview={preview} effectiveBranch={effectiveBranch} base={base} />
      )}
    </>
  );
}

/** New-branch source: branch name + base picker. */
export function NewBranchFields({
  branchName,
  invalid,
  clash,
  base,
  branches,
  onBranchNameChange,
  onBaseSelect,
}: {
  branchName: string;
  invalid: boolean;
  clash: boolean;
  base: string | null;
  branches: BranchInfo[];
  onBranchNameChange: (value: string) => void;
  onBaseSelect: (name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Input
        autoFocus
        size="small"
        label={t("worktree.branchLabel")}
        placeholder={t("worktree.branchPlaceholder")}
        value={branchName}
        onChange={onBranchNameChange}
        isInvalid={invalid || clash}
        hint={
          invalid
            ? t("worktree.invalidBranchName")
            : clash
              ? t("worktree.branchConflict", { branch: branchName.trim() })
              : undefined
        }
      />
      <div className="flex flex-col gap-1">
        <span className="text-caption-1-medium text-text-secondary">
          {t("worktree.baseLabel")}
        </span>
        <BranchCombobox
          branches={branches}
          value={base}
          onSelect={onBaseSelect}
          placeholder={t("git.searchBranches")}
          ariaLabel={t("worktree.baseLabel")}
          remoteLabel={t("git.remoteBranch")}
        />
        <span className="text-caption-1-regular text-text-tertiary">
          {t("worktree.baseHint")}
        </span>
      </div>
    </>
  );
}

/** Existing-branch source: picker with checked-out names disabled. */
export function ExistingBranchFields({
  existing,
  branches,
  occupied,
  onExistingSelect,
}: {
  existing: string | null;
  branches: BranchInfo[];
  occupied: Set<string>;
  onExistingSelect: (name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption-1-medium text-text-secondary">
        {t("worktree.existingBranchLabel")}
      </span>
      <BranchCombobox
        branches={branches}
        value={existing}
        onSelect={onExistingSelect}
        placeholder={t("worktree.existingBranchPlaceholder")}
        blocked={occupied}
        blockedReason={t("worktree.existingBranchOccupied")}
        ariaLabel={t("worktree.existingBranchLabel")}
        remoteLabel={t("git.remoteBranch")}
      />
    </div>
  );
}
