import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import CircleStop from "lucide-react/dist/esm/icons/circle-stop";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";

/**
 * ComposerToolbar — the composer's bottom row: menu slots (add attachment,
 * CLI + model switcher, permission mode) on the left; the send button on the
 * right, which becomes a stop control while a turn streams. A live-send
 * capability adds explicit guidance and next-turn queue actions.
 */
export function ComposerToolbar({
  addMenu,
  cliMenu,
  permissionMenu,
  streaming = false,
  disabled = false,
  onStop,
  onSend,
  onQueue,
}: {
  /** Slot for the add-attachment menu (template AddMenu). */
  addMenu?: ReactNode;
  /** Slot for the CLI + model switcher (CliMenu). */
  cliMenu?: ReactNode;
  /** Slot for the permission-mode picker (PermissionMenu). */
  permissionMenu?: ReactNode;
  /** A turn is in flight: send becomes stop. */
  streaming?: boolean;
  /** Greys out send. */
  disabled?: boolean;
  /** Fires on the stop button while streaming. */
  onStop?: () => void;
  /** Fires on the send button. */
  onSend: () => void;
  /** Present while streaming to offer current-turn guidance and next-turn queueing. */
  onQueue?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={cx("flex items-center gap-2 select-none", streaming && onQueue && "flex-wrap")}>
      {addMenu}

      {cliMenu}

      {permissionMenu}

      <div aria-hidden className="min-w-0 flex-1" />

      {streaming && onQueue && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button size="small" variant="secondary" disabled={disabled} title={t("chat.queueTooltip")} onClick={onQueue}>
            {t("chat.queue")}
          </Button>
          <Button size="small" disabled={disabled} title={t("chat.steerTooltip")} onClick={onSend}>
            {t("chat.steer")}
          </Button>
        </div>
      )}
      {streaming ? (
        <button
          type="button"
          aria-label={t("chat.stop")}
          title={t("chat.stop")}
          onClick={() => onStop?.()}
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-button-primary p-2 transition-opacity duration-200 ease"
        >
          <CircleStop className="size-5 text-text-white" aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          aria-label={t("chat.send")}
          title={t("chat.send")}
          disabled={disabled}
          onClick={onSend}
          className={cx(
            "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-button-primary p-2 transition-opacity duration-200 ease",
            disabled && "cursor-not-allowed opacity-40",
          )}
        >
          <ArrowUp className="size-5 text-text-white" aria-hidden />
        </button>
      )}
    </div>
  );
}
