import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import Info from "lucide-react/dist/esm/icons/info";
import Network from "lucide-react/dist/esm/icons/network";
import Plus from "lucide-react/dist/esm/icons/plus";
import { Button } from "@/components/base/buttons/button";
import { ModalShell } from "@/components/dialogs";
import { useMissionStore, type MissionView } from "../store";
import { StudioView } from "./StudioView";
import { FlowsView } from "./FlowsView";
import { InboxView } from "./InboxView";
import { ensureMissionSeeded } from "../runtime";

const VIEWS: MissionView[] = ["studio", "flows", "inbox"];

/**
 * 任务工作台（原生中心页签）。
 *
 * 创作时以流程为中心，执行时以结果和待办为中心：三个一级入口
 * 流程编排 / 流程列表 / 收件箱，入口在顶栏切换。
 */
export function MissionWorkbench() {
  const { t } = useTranslation();
  const { activeView, setActiveView, createFlow, flowCount, unreadCount } = useMissionStore(
    useShallow((s) => ({
      activeView: s.activeView,
      setActiveView: s.setActiveView,
      createFlow: s.createFlow,
      flowCount: s.flows.length,
      unreadCount: s.inbox.reduce((sum, item) => sum + (item.read ? 0 : 1), 0),
    })),
  );
  const [aboutOpen, setAboutOpen] = useState(false);

  // 首次打开时装载内置示例流程（无 AI 也可运行；M1）。
  useEffect(() => {
    ensureMissionSeeded();
  }, []);

  const labels: Record<MissionView, string> = {
    studio: t("mission.navStudio"),
    flows: t("mission.navFlows"),
    inbox: t("mission.navInbox"),
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background-primary-default">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-separator-border px-4 py-2">
        <div className="flex min-w-0 items-stretch gap-4 self-stretch">
          <span className="flex items-center gap-2 text-body-medium text-text-primary">
            <Network className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="whitespace-nowrap">{t("mission.title")}</span>
            <span className="rounded-sm border border-border-button-default px-1.5 py-0.5 text-caption-1-medium text-text-tertiary">
              {t("mission.nativeTag")}
            </span>
          </span>
          <nav className="flex items-stretch gap-1" aria-label={t("mission.title")}>
            {VIEWS.map((view) => (
              <button
                key={view}
                type="button"
                aria-current={activeView === view ? "page" : undefined}
                onClick={() => setActiveView(view)}
                className={
                  "flex cursor-pointer items-center gap-1.5 border-b-2 px-2 text-body-2-medium transition-colors duration-150 " +
                  (activeView === view
                    ? "border-button-primary text-button-primary"
                    : "border-transparent text-text-tertiary hover:text-text-secondary")
                }
              >
                {labels[view]}
                {view === "flows" && flowCount > 0 && (
                  <span className="rounded-sm bg-background-secondary-default px-1.5 text-caption-1-medium text-text-secondary">
                    {flowCount}
                  </span>
                )}
                {view === "inbox" && unreadCount > 0 && (
                  <span className="rounded-sm bg-background-secondary-default px-1.5 text-caption-1-medium text-text-secondary">
                    {unreadCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="small" variant="secondary" leadingIcon={Plus} onClick={() => createFlow()}>
            {t("mission.newFlow")}
          </Button>
          <Button
            size="small"
            variant="ghost"
            iconOnly
            leadingIcon={Info}
            aria-label={t("mission.about")}
            onClick={() => setAboutOpen(true)}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {activeView === "studio" && <StudioView />}
        {activeView === "flows" && <FlowsView />}
        {activeView === "inbox" && <InboxView />}
      </div>

      {aboutOpen && (
        <ModalShell
          onClose={() => setAboutOpen(false)}
          label={t("mission.about")}
          className="w-[min(580px,calc(100vw-2rem))] p-6"
        >
          <h2 className="text-title-3-medium text-text-primary">{t("mission.aboutTitle")}</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-body-2-regular text-text-secondary">
            <li>{t("mission.aboutEntry")}</li>
            <li>{t("mission.aboutAuthoring")}</li>
            <li>{t("mission.aboutRun")}</li>
            <li>{t("mission.aboutSafety")}</li>
            <li>{t("mission.aboutPersistence")}</li>
          </ul>
          <div className="mt-5 flex justify-end">
            <Button size="small" onClick={() => setAboutOpen(false)}>
              {t("mission.close")}
            </Button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
