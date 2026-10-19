import { useTranslation } from "react-i18next";
import Bot from "lucide-react/dist/esm/icons/bot";
import { type AgentConfig } from "@/lib/ipc";

/**
 * Pinned-agent chip rendered above the composer input, styled after the
 * attachment chips (ConversationFooter); × clears the selection.
 */
export function SelectedAgentChip({
  agent,
  onClear,
}: {
  agent: AgentConfig;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5 px-1.5">
      <span className="inline-flex items-center gap-1 rounded-full bg-background-tertiary-default py-0.5 pl-2 text-caption-1-medium text-text-secondary">
        {agent.icon ? (
          <span aria-hidden>{agent.icon}</span>
        ) : (
          <Bot
            aria-hidden
            className="size-3.5 shrink-0 text-foreground-icon-secondary"
          />
        )}
        <span className="max-w-48 truncate">{agent.name}</span>
        <button
          type="button"
          aria-label={t("chat.selectedAgentRemove")}
          onClick={onClear}
          className="cursor-pointer rounded-full px-1 hover:text-text-primary"
        >
          ×
        </button>
      </span>
    </div>
  );
}
