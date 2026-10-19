"use client";

import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import GitMerge from "lucide-react/dist/esm/icons/git-merge";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { menuPopoverSurface } from "@/components/base/dropdown/menu-styles";
import { cx } from "@/utils/cx";
import { usePopoverState } from "@/utils/use-dismiss-on-outside-press";

/**
 * Prominent branch switcher pill — rendered in both the top-right chat header
 * and the composer status bar; shares the react-aria non-modal popover recipe.
 */

const POPOVER_TOP_START = menuPopoverSurface({ width: "w-[266px]", origin: "origin-bottom-left" });
const POPOVER_BOTTOM_START = menuPopoverSurface({ width: "w-[266px]", origin: "origin-top-left" });
const POPOVER_BOTTOM_END = menuPopoverSurface({ width: "w-[266px]", origin: "origin-top-right" });

export interface BranchMenuItem {
  name: string;
  /** Remote-tracking branch (`origin/x`); rendered with the remote badge. */
  isRemote?: boolean;
  /** Current HEAD branch when listed by `git_branches`. */
  isCurrent?: boolean;
}

/** Prominent branch pill trigger + branch popover. `repoName` labels the
 * repository the branch belongs to when the followed repo is a nested one
 * (file-tree selection inside a subfolder repository), never the workspace
 * default. */
export function BranchMenu({
  branches,
  currentName,
  repoName,
  placement = "top start",
  className,
  onOpen,
  onSelect,
}: {
  /** Local and remote-tracking branches; empty until the first load. */
  branches: BranchMenuItem[];
  currentName?: string;
  /** Repository display name; renders as a prefix when set. */
  repoName?: string;
  /** Popover placement (`"top start"` in status bar, `"bottom end"` in header). */
  placement?: "top start" | "bottom start" | "bottom end";
  className?: string;
  onOpen?: () => void;
  onSelect?: (name: string) => void;
}) {
  const { t } = useTranslation();
  // `isNonModal` popovers don't dismiss on outside press and don't toggle
  // closed on a trigger press — usePopoverState restores both (hook doc).
  const { isOpen, triggerRef, popoverRef, close, setOpen } = usePopoverState();
  const popoverClassName =
    placement === "bottom end"
      ? POPOVER_BOTTOM_END
      : placement === "bottom start"
        ? POPOVER_BOTTOM_START
        : POPOVER_TOP_START;

  return (
    <AriaDialogTrigger
      isOpen={isOpen}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
      <AriaButton
        ref={triggerRef}
        aria-label={t("git.branch")}
        className={cx(
          "flex max-w-[260px] cursor-pointer items-center gap-1.5 rounded-full border border-border-button-default bg-background-secondary-default px-2.5 py-1 outline-none transition-colors duration-150 ease hover:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          className,
        )}
      >
        <GitBranch
          className="size-3.5 shrink-0 text-foreground-icon-secondary"
          aria-hidden
        />
        <span className="flex min-w-0 items-center">
          {repoName && (
            <>
              <span className="truncate text-caption-1-medium whitespace-nowrap text-text-secondary">
                {repoName}
              </span>
              <span
                className="px-1 text-caption-1-regular text-text-tertiary"
                aria-hidden
              >
                ·
              </span>
            </>
          )}
          <span className="truncate text-caption-1-medium whitespace-nowrap text-text-primary">
            {currentName ?? "…"}
          </span>
          <ChevronDown
            className={cx(
              "ml-0.5 size-3.5 shrink-0 text-foreground-icon-secondary transition-transform duration-200 ease",
              isOpen && "rotate-180",
            )}
            aria-hidden
          />
        </span>
      </AriaButton>

      <AriaPopover
        ref={popoverRef}
        isNonModal
        placement={placement}
        offset={8}
        className={popoverClassName}
      >
        <AriaDialog aria-label={t("git.branch")} className="outline-none">
          <div className="flex w-full flex-col gap-1.5 pt-1">
            <span className="pl-2 text-body-medium text-text-secondary">
              {t("git.branch")}
            </span>
            <div className="flex max-h-64 w-full flex-col gap-1 overflow-y-auto">
              {branches.map((branch) => (
                <button
                  key={branch.name}
                  type="button"
                  aria-pressed={branch.name === currentName}
                  onClick={() => {
                    // Compare against the displayed current name, not a cached
                    // isCurrent: the list snapshot lags behind external
                    // checkouts and would no-op the click.
                    if (branch.name !== currentName) onSelect?.(branch.name);
                    close();
                  }}
                  className={cx(
                    "flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 outline-none transition-colors",
                    branch.name === currentName
                      ? "bg-background-primary-hover"
                      : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
                  )}
                >
                  <GitMerge
                    className="size-5 shrink-0 -scale-y-100 text-foreground-icon-secondary"
                    aria-hidden
                  />
                  <span className="truncate text-body-medium whitespace-nowrap text-text-primary">
                    {branch.name}
                  </span>
                  {branch.isRemote && (
                    <span className="ml-auto shrink-0 rounded-md bg-background-secondary-default px-1.5 py-0.5 text-caption-1-regular text-text-tertiary">
                      {t("git.remoteBranch")}
                    </span>
                  )}
                  {branch.name === currentName && (
                    <Check
                      className="ml-auto size-4 shrink-0 text-foreground-icon-secondary"
                      aria-hidden
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
