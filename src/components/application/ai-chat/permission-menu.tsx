"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { cx } from "@/utils/cx";
import { useDismissOnOutsidePress, useTriggerToggle } from "@/utils/use-dismiss-on-outside-press";
import { COMPOSER_PERMISSIONS } from "./composer-permissions";

/**
 * Ported from Board UI → "new composer with permissions dropdown" (node
 * 4430:12203), the `PermissionMenu` of composer-panel. Only this control was
 * ported — the composer itself stays the single-line pill in
 * ai-chat-composer.tsx.
 *
 * A pill trigger that only paints its surface on hover, press, or while its
 * menu is open, and a 323px panel with the four permission modes that opens
 * upward like the add and model menus. Auto is the default. Text is localized
 * (chat.permission*); selection is component-local until a backend permission
 * concept exists — the host can already observe/control it via the props.
 */

export type ComposerPermission = "auto" | "manual" | "plan" | "bypass";

export interface ComposerPermissionOption {
  id: ComposerPermission;
  /** i18n keys under `chat.` for label and description. */
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  /** Figma draws the branch and route glyphs mirrored on the vertical axis. */
  flip?: boolean;
}

/* Non-modal like every other composer menu: React Aria's popovers lock page
 * scroll by default, and the reflow that causes shunts sticky layout the
 * moment a menu opens. Non-modal also switches off React Aria's outside-press
 * dismissal, so the menu restores it with useDismissOnOutsidePress, the same
 * fix as Select and Dropdown. */
const PERMISSION_POPOVER = cx(
  "w-[323px] max-w-[calc(100vw-32px)]",
  "rounded-[20px] border border-border-button-default bg-background-primary-default p-1.5 shadow-dropdown",
  "transition duration-150 ease-out",
  "data-[entering]:opacity-0 data-[entering]:scale-95 data-[entering]:blur-[2px]",
  "data-[exiting]:opacity-0 data-[exiting]:scale-95 data-[exiting]:blur-[2px]",
  "data-[placement=bottom]:origin-top-left data-[placement=top]:origin-bottom-left",
);

export interface PermissionMenuProps {
  engine?: string;
  /** Controlled mode. Left out, the picker keeps its own selection. */
  value?: ComposerPermission;
  defaultValue?: ComposerPermission;
  onChange?: (permission: ComposerPermission) => void;
  /** Where the header's "Learn more" link goes; the link renders only when a
   *  href or handler is provided (the app has no permission docs target yet). */
  learnMoreHref?: string;
  onLearnMore?: () => void;
  /** Modes the active engine actually honors (from EngineInfo.permissions);
   * omitted = all modes selectable. Unsupported modes render disabled rather
   * than silently sending a different mode to the CLI. */
  supported?: string[];
  supportsAutoReview?: boolean;
  className?: string;
}

export function PermissionMenu({
  engine,
  value,
  defaultValue = "auto",
  onChange,
  learnMoreHref,
  onLearnMore,
  supported,
  supportsAutoReview = false,
  className,
}: PermissionMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  useDismissOnOutsidePress(isOpen, () => setIsOpen(false), [triggerRef, popoverRef]);
  // Pressing the trigger while open closes the menu instead of reopening it.
  const allowOpenChange = useTriggerToggle(isOpen, triggerRef);
  const [internal, setInternal] = useState<ComposerPermission>(defaultValue);
  const selected = value ?? internal;
  const current =
    COMPOSER_PERMISSIONS.find((option) => option.id === selected) ?? COMPOSER_PERMISSIONS[0];
  const CurrentIcon = current.icon;
  const keyFor = (option: typeof current, description = false) => engine === "agy"
    ? `permissionAgy${option.id[0].toUpperCase()}${option.id.slice(1)}${description ? "Desc" : ""}`
    : supportsAutoReview && option.id === "auto" ? `permissionAutoReview${description ? "Desc" : ""}`
    : description ? option.descriptionKey : option.labelKey;
  const label = (option: typeof current) => t(`chat.${keyFor(option)}`);

  const select = (next: ComposerPermission) => {
    setInternal(next);
    onChange?.(next);
    setIsOpen(false);
  };

  return (
    <AriaDialogTrigger
      isOpen={isOpen}
      onOpenChange={(next) => allowOpenChange(next) && setIsOpen(next)}
    >
      <AriaButton
        ref={triggerRef}
        aria-label={t("chat.permissionLabel", { label: label(current) })}
        className={({ isHovered, isPressed, isFocusVisible }) =>
          cx(
            "flex h-[30px] shrink-0 cursor-pointer items-center gap-1 rounded-full py-[5px] pr-2.5 pl-2 outline-none transition-colors duration-150 ease",
            // Same surface as the model picker's hover: a step lighter than the
            // card in dark rather than darker.
            (isHovered || isPressed || isOpen) && "bg-background-primary-hover",
            isFocusVisible && "ring-2 ring-border-focus-ring",
            className,
          )
        }
      >
        <CurrentIcon
          className={cx(
            "size-4 shrink-0 text-foreground-icon-secondary",
            current.flip && "-scale-y-100",
          )}
          aria-hidden
        />
        {/* Icon-only below md (aria-label on the trigger carries the mode);
            keeps the composer toolbar within narrow widths. */}
        <span className="text-body-medium whitespace-nowrap text-text-secondary max-md:hidden">
          {label(current)}
        </span>
      </AriaButton>

      <AriaPopover
        ref={popoverRef}
        isNonModal
        placement="top start"
        offset={8}
        className={PERMISSION_POPOVER}
      >
        <AriaDialog
          aria-label={t("chat.permissions")}
          className="flex flex-col gap-1.5 pt-1 outline-none"
        >
          <div className="flex items-center gap-2.5 px-2 text-body-medium text-text-tertiary">
            <span className="min-w-0 flex-1">{t("chat.permissions")}</span>
            {(learnMoreHref || onLearnMore) &&
              (learnMoreHref ? (
                <a
                  href={learnMoreHref}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-body-medium text-text-tertiary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  {t("chat.permissionLearnMore")}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={onLearnMore}
                  className="shrink-0 cursor-pointer text-body-medium text-text-tertiary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  {t("chat.permissionLearnMore")}
                </button>
              ))}
          </div>
          <div
            role="radiogroup"
            aria-label={t("chat.permissions")}
            className="flex flex-col gap-1"
          >
            {COMPOSER_PERMISSIONS.map((option) => {
              const Icon = option.icon;
              const checked = option.id === selected;
              const disabled = (engine === "agy" && option.id === "manual") || (supported !== undefined && !supported.includes(option.id));
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-disabled={disabled || undefined}
                  title={disabled ? t("chat.permissionUnsupported") : undefined}
                  onClick={() => !disabled && select(option.id)}
                  className={cx(
                    "flex w-full items-center gap-2 rounded-[14px] p-2 text-left outline-none transition-colors",
                    disabled
                      ? "cursor-not-allowed opacity-50"
                      : cx(
                          "cursor-pointer",
                          checked
                            ? "bg-background-primary-hover"
                            : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
                        ),
                  )}
                >
                  <Icon
                    className={cx(
                      "size-5 shrink-0 text-foreground-icon-secondary",
                      option.flip && "-scale-y-100",
                    )}
                    aria-hidden
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body-medium text-text-secondary">
                      {label(option)}
                    </span>
                    <span className="truncate text-body-2-medium text-text-tertiary">
                      {t(`chat.${keyFor(option, true)}`)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
