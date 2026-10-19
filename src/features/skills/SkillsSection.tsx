/**
 * 设置 → 能力扩展 → Skills.
 *
 * Three panes, each loading its own data only while visible:
 *   我的 Skills — installed/local management (the default entry)
 *   发现        — repo discovery + skills.sh search (online, explicit)
 *   使用情况    — Claude Code invocation stats + the action log
 *
 * The page itself owns nothing but the active tab: state lives in the pane
 * hooks so switching tabs never re-fetches another pane's data.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { InstalledPane } from "./InstalledPane";
import { DiscoverPane } from "./DiscoverPane";
import { SkillUsagePane } from "./SkillUsagePane";

type SkillTab = "installed" | "discover" | "usage";

export function SkillsSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SkillTab>("installed");

  return (
    <div className="flex w-full flex-col gap-4">
      <PillTabList>
        {(["installed", "discover", "usage"] as const).map((id) => (
          <PillTab
            key={id}
            variant="gray"
            anchor={id}
            isSelected={tab === id}
            onSelect={() => setTab(id)}
          >
            {t(`skills.tabs.${id}`)}
          </PillTab>
        ))}
      </PillTabList>
      {tab === "installed" && <InstalledPane onBrowse={() => setTab("discover")} />}
      {tab === "discover" && <DiscoverPane />}
      {tab === "usage" && <SkillUsagePane />}
    </div>
  );
}
