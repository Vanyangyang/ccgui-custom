import { useState } from "react";
import { useTranslation } from "react-i18next";
import Bot from "lucide-react/dist/esm/icons/bot";
import FileText from "lucide-react/dist/esm/icons/file-text";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { AgentsPane } from "./AgentsPane";
import { PromptsPane } from "./PromptsPane";

/**
 * 智能体 + 提示词 settings page: a pill-tab switcher between the agent
 * library (AgentsPane) and the custom-prompt library (PromptsPane). Both
 * panes own their own store subscriptions and dialogs; this shell only
 * holds the active tab.
 */
export function AgentsPromptsSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"agents" | "prompts">("agents");

  return (
    <div className="flex w-full flex-col gap-4">
      <PillTabList>
        <PillTab
          variant="gray"
          icon={Bot}
          anchor="agents"
          isSelected={tab === "agents"}
          onSelect={() => setTab("agents")}
        >
          {t("settings.agentPromptTabAgents")}
        </PillTab>
        <PillTab
          variant="gray"
          icon={FileText}
          anchor="prompts"
          isSelected={tab === "prompts"}
          onSelect={() => setTab("prompts")}
        >
          {t("settings.agentPromptTabPrompts")}
        </PillTab>
      </PillTabList>
      {tab === "agents" ? <AgentsPane /> : <PromptsPane />}
    </div>
  );
}
