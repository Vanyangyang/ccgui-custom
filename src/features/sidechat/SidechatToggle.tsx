import { memo } from "react";
import { useTranslation } from "react-i18next";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import { cx } from "@/utils/cx";
import { sessionKey as toSessionKey, type ActiveSession } from "@/features/chat/store";
import { isSidechatSupportedEngine, useSidechatStore } from "./store";

/** Composer-toolbar toggle for the `/sidechat` panel; hidden for engines that
 *  cannot fork (only claude / codex / agy / cursor are supported). */
export const SidechatToggle = memo(function SidechatToggle({
  active,
}: {
  active: ActiveSession | null;
}) {
  const { t } = useTranslation();
  const key = active ? toSessionKey(active.engine, active.sessionId, active.workspacePath) : "";
  const open = useSidechatStore((s) => (key ? s.sidechatBySession[key]?.open === true : false));
  const toggleSidechat = useSidechatStore((s) => s.toggleSidechat);
  if (!active || !isSidechatSupportedEngine(active.engine)) return null;
  const label = open ? t("sidechat.closeHint") : t("sidechat.toggle");
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={() =>
        toggleSidechat({
          sessionKey: key,
          engine: active.engine,
          workspacePath: active.workspacePath,
          parentSessionId: active.sessionId,
        })
      }
      className={cx(
        "flex shrink-0 cursor-pointer items-center rounded-md px-1.5 py-1 outline-none transition-colors duration-150 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        open ? "text-text-primary" : "text-text-tertiary",
      )}
    >
      <GitBranch aria-hidden className="size-4" />
    </button>
  );
});
