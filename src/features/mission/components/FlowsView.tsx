import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import Network from "lucide-react/dist/esm/icons/network";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";
import { latestRunOf } from "../runtime";
import { useMissionStore, type MissionFlowFilter } from "../store";
import { countRunUnits, runStatus } from "../types";

/**
 * 流程列表：草稿与运行状态一目了然；编辑的是草稿，查看运行展示启动时的
 * 版本（运行中的版本不变）。
 */
export function FlowsView() {
  const { t } = useTranslation();
  const { flows, runs, flowFilter, flowSearch, setFlowFilter, setFlowSearch, selectFlow } =
    useMissionStore(
      useShallow((s) => ({
        flows: s.flows,
        runs: s.runs,
        flowFilter: s.flowFilter,
        flowSearch: s.flowSearch,
        setFlowFilter: s.setFlowFilter,
        setFlowSearch: s.setFlowSearch,
        selectFlow: s.selectFlow,
      })),
    );

  const filters: Array<{ id: MissionFlowFilter | "attention"; label: string }> = [
    { id: "all", label: t("mission.filterAll") },
    { id: "running", label: t("mission.filterRunning") },
    { id: "attention", label: t("mission.filterAttention") },
    { id: "done", label: t("mission.filterDone") },
    { id: "draft", label: t("mission.filterDraft") },
  ];

  const visible = useMemo(() => {
    const search = flowSearch.trim().toLowerCase();
    return flows.filter((flow) => {
      if (search && !flow.name.toLowerCase().includes(search)) return false;
      if (flowFilter === "all") return true;
      const run = latestRunOf(flow, runs);
      if (!run) return flowFilter === "draft";
      const counts = countRunUnits(run);
      if (flowFilter === "attention") return counts.waiting + counts.failed > 0;
      return runStatus(run) === flowFilter;
    });
  }, [flows, runs, flowFilter, flowSearch]);

  return (
    <div className="h-full overflow-auto bg-background-secondary-default/20 px-6 py-8">
      <div className="mx-auto max-w-4xl">
        <div className="text-caption-1-medium uppercase tracking-widest text-text-tertiary">
          {t("mission.flowsEyebrow")}
        </div>
        <h1 className="mt-2 text-title-2-medium text-text-primary">{t("mission.flowsTitle")}</h1>
        <p className="mt-1.5 text-body-2-regular text-text-tertiary">{t("mission.flowsSubtitle")}</p>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setFlowFilter(filter.id === "attention" ? "attention" : filter.id)}
              className={cx(
                "cursor-pointer rounded-md border px-2.5 py-1 text-caption-1-medium transition-colors",
                flowFilter === filter.id
                  ? "border-status-blue-text/40 bg-status-blue-background/30 text-status-blue-text"
                  : "border-transparent text-text-tertiary hover:text-text-secondary",
              )}
            >
              {filter.label}
            </button>
          ))}
          <input
            value={flowSearch}
            onChange={(event) => setFlowSearch(event.target.value)}
            placeholder={t("mission.flowSearchPlaceholder")}
            aria-label={t("mission.flowSearchPlaceholder")}
            className="ml-auto min-w-[180px] rounded-md border border-border-button-default bg-background-primary-default px-3 py-1.5 text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder focus:border-status-blue-text/60"
          />
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default">
          {visible.length === 0 && (
            <div className="p-10 text-center text-body-2-regular text-text-tertiary">
              {flows.length === 0 ? t("mission.flowsEmpty") : t("mission.flowsSearchEmpty")}
            </div>
          )}
          {visible.map((flow) => {
            const run = latestRunOf(flow, runs);
            const counts = run ? countRunUnits(run) : null;
            const status = run ? runStatus(run) : null;
            return (
              <div
                key={flow.id}
                data-flow={flow.id}
                className="flex flex-wrap items-center gap-3 border-b border-separator-border px-4 py-4 last:border-b-0"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background-secondary-default text-text-tertiary">
                  <Network className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body-2-medium text-text-primary">
                    {flow.name || t("mission.title")}
                  </div>
                  <div className="mt-1 text-caption-1-regular text-text-tertiary">
                    {run && counts
                      ? t("mission.flowRunSummary", {
                          runId: run.id,
                          terminal: counts.done + counts.excluded,
                          total: counts.total,
                          running: counts.running,
                          queued: counts.queued,
                        })
                      : flow.draft
                        ? t("mission.draftVersion", { version: flow.draft.version })
                        : t("mission.flowWaitingRange")}
                  </div>
                  {counts && counts.waiting + counts.failed > 0 && (
                    <div className="mt-0.5 text-caption-1-regular text-text-secondary">
                      {t("mission.flowAttentionSummary", {
                        waiting: counts.waiting,
                        failed: counts.failed,
                      })}
                    </div>
                  )}
                </div>
                <span
                  className={cx(
                    "shrink-0 whitespace-nowrap text-caption-1-medium",
                    status === "running" && "text-status-blue-text",
                    status === "attention" && "text-status-yellow-text",
                    status === "done" && "text-status-green-text",
                    (!status || status === "waiting" || status === "cancelled") &&
                      "text-text-tertiary",
                  )}
                >
                  {status
                    ? t(
                        run?.interrupted
                          ? "mission.contextStateInterrupted"
                          : `mission.contextState${status[0].toUpperCase()}${status.slice(1)}`,
                      )
                    : t("mission.filterDraft")}
                </span>
                <span className="shrink-0 whitespace-nowrap font-mono text-caption-1-regular text-text-tertiary">
                  {flow.draft
                    ? t("mission.flowDraftVersion", { version: flow.draft.version })
                    : t("mission.flowNoDraft")}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!flow.draft && flow.messages.length === 0}
                    onClick={() => selectFlow(flow.id, "definition")}
                  >
                    {t("mission.editWithAi")}
                  </Button>
                  {run && (
                    <Button size="xs" variant="secondary" onClick={() => selectFlow(flow.id, "run", run.id)}>
                      {t("mission.viewRun")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-caption-1-regular leading-relaxed text-text-tertiary">
          {t("mission.flowsNote")}
        </p>
      </div>
    </div>
  );
}
