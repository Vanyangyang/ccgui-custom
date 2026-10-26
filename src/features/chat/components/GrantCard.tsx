import { useTranslation } from "react-i18next";
import FolderLock from "lucide-react/dist/esm/icons/folder-lock";
import Check from "lucide-react/dist/esm/icons/check";
import X from "lucide-react/dist/esm/icons/x";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import type { Message } from "@/lib/ipc";
import { useChatStore } from "../store";
import { useScopedSessionKey } from "../split/session-scope";

const ACTION_BUTTON =
  "inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-caption-1-medium transition-colors";

type GrantState = NonNullable<Message["grant"]>;

/**
 * Permission-denial card: the CLI (headless) refused a tool call on an
 * out-of-workspace path and the model cannot unblock itself — its "type y in
 * the terminal" narration refers to a prompt that does not exist here. This
 * card is the real answer: grant the directory (persisted; the next claude
 * launch gets --add-dir) or decline.
 */
export function GrantCard({ message, onAnswer, readOnly = false }: { message: Message; onAnswer?: (accept: boolean) => void; readOnly?: boolean }) {
  const { t } = useTranslation();
  const respondToGrant = useChatStore((s) => s.respondToGrant);
  const resendLastUser = useChatStore((s) => s.resendLastUser);
  // 卡片渲染在所属栏位的对话里，会话 key 也跟着那一栏（分屏后不能再用全局
  // active，否则非聚焦格子里的授权卡会授到别的会话上）。
  const key = useScopedSessionKey();
  const streaming = useChatStore((s) => Boolean(key && s.streamingByKey[key]));
  const grant = message.grant ?? { status: "pending" as const };
  const path = message.path ?? "";

  const answer = (accept: boolean) => {
    if (readOnly) return;
    if (onAnswer) onAnswer(accept);
    else if (key) void respondToGrant(key, message.seq, accept);
  };

  return (
    <div className="flex max-w-[85%] flex-col gap-2 rounded-xl border border-border-secondary bg-background-secondary-default px-3.5 py-2.5 text-left">
      <div className="flex items-center gap-1.5 text-caption-1-medium text-text-primary">
        <FolderLock className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
        {t(path ? "chat.grantTitle" : "chat.grantTitleAction")}
      </div>
      {message.text && (
        <div className="break-words text-caption-1-regular text-text-secondary">
          {message.text}
        </div>
      )}
      {path && (
        <div className="break-all rounded-md bg-background-tertiary-default px-2 py-1 font-mono text-caption-1-regular text-text-secondary">
          {path}
        </div>
      )}
      {grant.status === "pending" && !readOnly && (
        <PendingGrant grant={grant} path={path} onAnswer={answer} />
      )}
      {grant.status === "granted" && (
        <GrantedGrant
          grant={grant}
          path={path}
          streaming={streaming || readOnly || !!onAnswer}
          onResend={() => !readOnly && !onAnswer && key && void resendLastUser(key)}
        />
      )}
      {grant.status === "declined" && (
        <div className="text-caption-1-regular text-text-tertiary">
          {t("chat.grantDeclined")}
        </div>
      )}
    </div>
  );
}

/** Pending card body: scope note + allow/decline pair, or the explanatory
 *  fallback when no path could be recovered. */
function PendingGrant({
  grant,
  path,
  onAnswer,
}: {
  grant: GrantState;
  path: string;
  onAnswer: (accept: boolean) => void;
}) {
  const { t } = useTranslation();
  if (!path) {
    // No path was recoverable (e.g. a denied shell command): a directory
    // grant cannot apply. Explain instead of rendering a dead disabled
    // button; dismissing settles the card as declined.
    return (
      <>
        <div className="text-caption-1-regular text-text-tertiary">
          {t("chat.grantUnavailable")}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onAnswer(false)}
            className={`${ACTION_BUTTON} bg-background-tertiary-default text-text-secondary hover:bg-background-tertiary-hover`}
          >
            {t("chat.grantDismiss")}
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      {grant.dir && (
        <div className="text-caption-1-regular text-text-tertiary">
          {t("chat.grantScopeNote", { dir: grant.dir })}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onAnswer(true)}
          className={`${ACTION_BUTTON} bg-button-primary text-text-white`}
        >
          <Check className="size-3.5" aria-hidden />
          {t("chat.grantAllow")}
        </button>
        <button
          type="button"
          onClick={() => onAnswer(false)}
          className={`${ACTION_BUTTON} bg-background-tertiary-default text-text-secondary hover:bg-background-tertiary-hover`}
        >
          <X className="size-3.5" aria-hidden />
          {t("chat.grantDecline")}
        </button>
      </div>
    </>
  );
}

/** Granted card body: confirmation text + resend-last-message action. */
function GrantedGrant({
  grant,
  path,
  streaming,
  onResend,
}: {
  grant: GrantState;
  path: string;
  streaming: boolean;
  onResend: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 text-caption-1-regular text-text-secondary">
      <span className="break-all">
        {t("chat.grantGranted", { dir: grant.dir ?? path })}
      </span>
      <button
        type="button"
        disabled={streaming}
        onClick={onResend}
        className={`${ACTION_BUTTON} bg-background-tertiary-default text-text-secondary hover:bg-background-tertiary-hover disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <RotateCcw className="size-3.5" aria-hidden />
        {t("chat.grantResend")}
      </button>
    </div>
  );
}
