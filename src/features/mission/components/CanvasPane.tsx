import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Maximize from "lucide-react/dist/esm/icons/maximize";
import Minus from "lucide-react/dist/esm/icons/minus";
import Play from "lucide-react/dist/esm/icons/play";
import Plus from "lucide-react/dist/esm/icons/plus";
import Scan from "lucide-react/dist/esm/icons/scan";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";
import { localizeMissionIssues } from "../ai-orchestrator";
import {
  countRunUnits,
  runStatus,
  type MissionFlow,
  type MissionFlowDefinition,
  type MissionRun,
  type MissionUnitCounts,
} from "../types";
import { usesOnlySimulatedCapabilities, validateMissionFlow } from "../engine/validator";
import { injectDemoFailure, latestRunOf, startMissionRun } from "../runtime";
import { useMissionStore, type MissionCanvasMode } from "../store";
import { MISSION_NODE_TYPES } from "./canvas/MissionNodes";
import {
  buildMissionCanvas,
  type MissionCanvasNodeData,
  type MissionItemNodeData,
} from "./canvas/mission-graph";
import { ExecutionPicker, RunEnvironment } from "./ExecutionPicker";
import { NodeInspector } from "./NodeInspector";
import { keyedLines } from "./keyed-lines";

type CanvasGraph = ReturnType<typeof buildMissionCanvas>;

/**
 * 画布：流程定义 / 运行实例双视图 + 节点详情。
 *
 * React Flow 只是画布组件；节点位置来自自动布局，人不能拖动/连线。
 * 运行视图把 foreach 展开成每项一张任务卡，状态来自调度器快照。
 */
export function CanvasPane() {
  const { t } = useTranslation();
  const {
    flows,
    runs,
    selectedFlowId,
    selectedRunId,
    canvasMode,
    selectedNodeKey,
    setCanvasMode,
    selectNode,
    selectFlow,
  } = useMissionStore(
    useShallow((s) => ({
      flows: s.flows,
      runs: s.runs,
      selectedFlowId: s.selectedFlowId,
      selectedRunId: s.selectedRunId,
      canvasMode: s.canvasMode,
      selectedNodeKey: s.selectedNodeKey,
      setCanvasMode: s.setCanvasMode,
      selectNode: s.selectNode,
      selectFlow: s.selectFlow,
    })),
  );
  const [startIssues, setStartIssues] = useState<string[] | null>(null);

  const flow = flows.find((item) => item.id === selectedFlowId) ?? null;
  const run = useMemo(
    () => resolveCanvasRun(flow, runs, selectedRunId),
    [flow, runs, selectedRunId],
  );
  const issues = useMemo(
    () => (flow?.draft ? validateMissionFlow(flow.draft) : []),
    [flow?.draft],
  );
  const mode = canvasMode === "run" && run ? "run" : "definition";
  const canvas = useMemo(
    () =>
      buildCanvasGraph(flow?.draft ?? null, run, mode, selectedNodeKey, issues),
    [flow?.draft, run, mode, selectedNodeKey, issues],
  );
  const activeRun = useMemo(() => latestActiveRun(flow, runs), [flow, runs]);
  const runView = useMemo(
    () => (run && mode === "run" ? { run, unitCounts: countRunUnits(run) } : null),
    [run, mode],
  );

  const applyStartIssues = useCallback(
    (lines: string[] | null) => setStartIssues(lines),
    [],
  );
  const handleRun = useCallback(() => {
    runFlowFromCanvas({
      flow,
      activeRun,
      selectFlow,
      applyIssues: applyStartIssues,
      fallbackError: t("mission.startRunFailed"),
    });
  }, [flow, activeRun, selectFlow, applyStartIssues, t]);
  const handleNodeClick = useCallback(
    (node: Node) => selectCanvasNode(node, selectNode),
    [selectNode],
  );

  if (!flow) return <CanvasEmpty />;

  const draft = flow.draft;
  const stateLabel = run
    ? t(
        run.interrupted
          ? "mission.contextStateInterrupted"
          : `mission.contextState${runStatusKey(run)}`,
      )
    : t("mission.contextStateDraft");

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background-secondary-default/30">
      <CanvasHeader
        flow={flow}
        draft={draft}
        run={run}
        mode={mode}
        activeRun={activeRun}
        onRun={handleRun}
        onSetMode={setCanvasMode}
      />
      <CanvasContextBar draft={draft} run={run} mode={mode} stateLabel={stateLabel} />
      {startIssues && (
        <StartIssuesBanner issues={startIssues} onDismiss={() => applyStartIssues(null)} />
      )}
      {runView && <RunMetricsBar run={runView.run} unitCounts={runView.unitCounts} />}
      <CanvasStage draft={draft} canvas={canvas} onNodeClick={handleNodeClick} />
      <CanvasFooter mode={mode} run={run} canvas={canvas} />
    </div>
  );
}

function runStatusKey(run: NonNullable<ReturnType<typeof latestRunOf>>): string {
  const status = runStatus(run);
  return status[0].toUpperCase() + status.slice(1);
}

function resolveCanvasRun(
  flow: MissionFlow | null,
  runs: Record<string, MissionRun>,
  selectedRunId: string | null,
): MissionRun | null {
  if (!flow) return null;
  if (selectedRunId && runs[selectedRunId]) return runs[selectedRunId];
  return latestRunOf(flow, runs);
}

function latestActiveRun(
  flow: MissionFlow | null,
  runs: Record<string, MissionRun>,
): MissionRun | null {
  if (!flow) return null;
  return (
    flow.runIds
      .map((id) => runs[id])
      .find((item) => item && item.endedAt === undefined && !item.cancelled) ?? null
  );
}

function buildCanvasGraph(
  definition: MissionFlowDefinition | null,
  run: MissionRun | null,
  mode: MissionCanvasMode,
  selectedNodeKey: string | null,
  issues: ReturnType<typeof validateMissionFlow>,
): CanvasGraph {
  if (!definition) return { nodes: [], edges: [] };
  return buildMissionCanvas({ definition, run, mode, selectedNodeKey, issues });
}

type SelectFlow = (flowId: string, mode?: MissionCanvasMode, runId?: string | null) => void;

function runFlowFromCanvas(input: {
  flow: MissionFlow | null;
  activeRun: MissionRun | null;
  selectFlow: SelectFlow;
  applyIssues: (lines: string[] | null) => void;
  fallbackError: string;
}): void {
  const { flow, activeRun, selectFlow, applyIssues, fallbackError } = input;
  if (!flow) return;
  if (activeRun) {
    selectFlow(flow.id, "run", activeRun.id);
    return;
  }
  const result = startMissionRun(flow.id);
  if (result.ok) {
    applyIssues(null);
    return;
  }
  if (result.activeRunId) {
    selectFlow(flow.id, "run", result.activeRunId);
    return;
  }
  applyIssues(
    result.issues && result.issues.length > 0
      ? localizeMissionIssues(result.issues)
      : [result.error ?? fallbackError],
  );
}

function selectCanvasNode(node: Node, selectNode: (key: string | null) => void): void {
  const data = node.data as MissionCanvasNodeData;
  if (data.kind === "item") {
    const item = (data as MissionItemNodeData).item;
    const representative =
      item.tasks.find((task) =>
        ["running", "waiting_human", "failed"].includes(task.status),
      ) ?? item.tasks[0];
    if (representative) selectNode(`task:${representative.id}`);
    return;
  }
  if (data.kind === "group") {
    selectNode(`node:${data.node.id}`);
    return;
  }
  if (data.kind === "definition") {
    const bodyPrefix = node.id.startsWith("body:") ? node.id : null;
    selectNode(bodyPrefix ?? `node:${data.node.id}`);
  }
}

/** 画布标题栏：流程名 / 版本、执行环境选择、定义/运行切换与运行按钮。 */
function CanvasHeader({
  flow,
  draft,
  run,
  mode,
  activeRun,
  onRun,
  onSetMode,
}: {
  flow: MissionFlow;
  draft: MissionFlowDefinition | null;
  run: MissionRun | null;
  mode: MissionCanvasMode;
  activeRun: MissionRun | null;
  onRun: () => void;
  onSetMode: (mode: MissionCanvasMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-separator-border bg-background-primary-default px-4 py-2">
      <div className="min-w-0">
        <h1 className="truncate text-body-medium text-text-primary">
          {flow.name || t("mission.title")}
        </h1>
        <div className="text-caption-1-regular text-text-tertiary">
          {!draft
            ? t("mission.noDraft")
            : mode === "run" && run
              ? t("mission.snapshotVersion", {
                  runId: run.id,
                  version: run.snapshot.version,
                })
              : t("mission.draftVersion", { version: draft.version })}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ExecutionPicker flow={flow} run={mode === "run" ? run : null} />
        <div className="flex gap-0.5 rounded-md bg-background-secondary-default p-0.5">
          <button
            type="button"
            onClick={() => onSetMode("definition")}
            className={cx(
              "cursor-pointer rounded-sm px-2 py-1 text-caption-1-medium transition-colors",
              mode === "definition"
                ? "bg-background-primary-default text-text-primary shadow-xs"
                : "text-text-tertiary hover:text-text-secondary",
            )}
          >
            {t("mission.modeDefinition")}
          </button>
          <button
            type="button"
            disabled={!run}
            onClick={() => onSetMode("run")}
            className={cx(
              "cursor-pointer rounded-sm px-2 py-1 text-caption-1-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              mode === "run"
                ? "bg-background-primary-default text-text-primary shadow-xs"
                : "text-text-tertiary hover:text-text-secondary",
            )}
          >
            {t("mission.modeRun")}
          </button>
        </div>
        <Button size="small" leadingIcon={Play} disabled={!draft} onClick={onRun}>
          {activeRun
            ? t("mission.viewCurrentRun")
            : flow.runIds.length > 0
              ? t("mission.startNewRun")
              : t("mission.runFlow")}
        </Button>
      </div>
    </div>
  );
}

/** 画布上下文条：草稿/运行快照说明与运行状态。 */
function CanvasContextBar({
  draft,
  run,
  mode,
  stateLabel,
}: {
  draft: MissionFlowDefinition | null;
  run: MissionRun | null;
  mode: MissionCanvasMode;
  stateLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-b border-separator-border bg-background-primary-default/60 px-4 py-1.5 text-caption-1-regular text-text-tertiary">
      <span>
        {!draft
          ? t("mission.contextIdle")
          : mode === "definition"
            ? t("mission.contextDefinition", {
                runNote:
                  run && run.endedAt === undefined
                    ? ` ${t("mission.contextRunDraftNewer", {
                        draft: draft.version,
                        run: run.snapshot.version,
                      })}`
                    : "",
              })
            : t("mission.contextRunSameVersion")}
      </span>
      <span className="shrink-0 whitespace-nowrap">{stateLabel}</span>
    </div>
  );
}

/** 启动校验失败时的警示条（逐条列出问题）。 */
function StartIssuesBanner({
  issues,
  onDismiss,
}: {
  issues: string[];
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 border-b border-status-rose-text/40 bg-status-rose-background/30 px-4 py-2 text-caption-1-regular text-status-rose-text"
    >
      <ul className="list-disc space-y-0.5 pl-4">
        {keyedLines(issues).map(({ key, text }) => (
          <li key={key}>{text}</li>
        ))}
      </ul>
      <Button size="xs" variant="ghost" onClick={onDismiss}>
        {t("mission.close")}
      </Button>
    </div>
  );
}

/** 运行视图的终端计数条（含演示失败入口）。 */
function RunMetricsBar({
  run,
  unitCounts,
}: {
  run: MissionRun;
  unitCounts: MissionUnitCounts;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-separator-border bg-background-primary-default px-4 py-1.5 text-caption-1-regular text-text-tertiary">
      <strong className="text-body-2-medium text-text-secondary">
        {t("mission.runtimeTerminal", {
          done: unitCounts.done + unitCounts.excluded,
          total: unitCounts.total,
        })}
      </strong>
      {(
        [
          ["running", "metricRunning"],
          ["queued", "metricQueued"],
          ["waiting", "metricWaiting"],
          ["failed", "metricFailed"],
          ["excluded", "metricExcluded"],
        ] as const
      ).map(([key, label]) => (
        <span key={key} className="inline-flex items-center gap-1">
          <b className="font-medium text-text-secondary">{unitCounts[key]}</b>
          {t(`mission.${label}`)}
        </span>
      ))}
      <span>{t("mission.concurrencyNote", { concurrency: run.snapshot.settings.concurrency })}</span>
      {run.execution && <RunEnvironment execution={run.execution} />}
      {/* 演示流程可手动注入失败，现场体验恢复链路；真实引擎不提供该入口。 */}
      {unitCounts.running > 0 && usesOnlySimulatedCapabilities(run.snapshot) && (
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          onClick={() => injectDemoFailure(run.id)}
        >
          {t("mission.demoFailureButton")}
        </Button>
      )}
    </div>
  );
}

/** 画布主区：空态提示或 React Flow 图，右下角挂节点详情。 */
function CanvasStage({
  draft,
  canvas,
  onNodeClick,
}: {
  draft: MissionFlowDefinition | null;
  canvas: CanvasGraph;
  onNodeClick: (node: Node) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative min-h-0 flex-1">
      {!draft || canvas.nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
          <div className="mb-4 grid size-12 place-items-center rounded-xl bg-background-secondary-default text-title-2-medium text-text-tertiary">
            ⌘
          </div>
          <h2 className="text-title-3-medium text-text-secondary">
            {t("mission.canvasEmptyTitle")}
          </h2>
          <p className="mt-2 whitespace-pre-line text-body-2-regular text-text-tertiary">
            {t("mission.canvasEmptyDesc")}
          </p>
        </div>
      ) : (
        <ReactFlowProvider>
          <ReactFlow
            nodes={canvas.nodes}
            edges={canvas.edges}
            nodeTypes={MISSION_NODE_TYPES}
            onNodeClick={(_, node) => onNodeClick(node)}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.15}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
            className="[&_.react-flow__node]:cursor-pointer [&_.react-flow__node]:!bg-transparent"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1}
              color="var(--color-border-button-default)"
            />
            <CanvasToolbar />
          </ReactFlow>
        </ReactFlowProvider>
      )}
      <NodeInspector />
    </div>
  );
}

/** 画布底栏：节点计数与操作提示。 */
function CanvasFooter({
  mode,
  run,
  canvas,
}: {
  mode: MissionCanvasMode;
  run: MissionRun | null;
  canvas: CanvasGraph;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-t border-separator-border bg-background-primary-default px-4 py-1.5 text-caption-1-regular text-text-tertiary">
      <span>
        {mode === "run" && run
          ? t("mission.canvasFooterRun", {
              tasks: run.tasks.length,
              nodes: canvas.nodes.filter((node) => node.type !== "missionItem").length,
            })
          : t("mission.canvasFooterDefinition", { count: canvas.nodes.length })}
      </span>
      <span>{t("mission.canvasPanHelp")}</span>
    </div>
  );
}

/** 未选中任何流程时的空态。 */
function CanvasEmpty() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div>
        <h2 className="text-title-3-medium text-text-secondary">
          {t("mission.canvasEmptyTitle")}
        </h2>
        <p className="mt-2 whitespace-pre-line text-body-2-regular text-text-tertiary">
          {t("mission.canvasEmptyDesc")}
        </p>
      </div>
    </div>
  );
}

/** 画布工具条：缩放 / 全图 / 聚焦并行任务。 */
function CanvasToolbar() {
  const { t } = useTranslation();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const focusPool = useCallback(() => {
    const group = document.querySelector(".react-flow__node-missionGroup");
    if (!group) {
      void fitView({ padding: 0.2 });
      return;
    }
    const nodeId = (group as HTMLElement).getAttribute("data-id");
    if (!nodeId) {
      void fitView({ padding: 0.2 });
      return;
    }
    void fitView({ nodes: [{ id: nodeId }], padding: 0.25, maxZoom: 1.1, duration: 300 });
  }, [fitView]);
  return (
    <div className="absolute bottom-4 left-4 z-10 flex items-center gap-0.5 rounded-md border border-border-button-default bg-background-primary-default p-0.5 shadow-xs">
      <Button
        size="xs"
        variant="ghost"
        iconOnly
        leadingIcon={Minus}
        aria-label={t("mission.canvasZoomOut")}
        onClick={() => void zoomOut()}
      />
      <Button
        size="xs"
        variant="ghost"
        iconOnly
        leadingIcon={Plus}
        aria-label={t("mission.canvasZoomIn")}
        onClick={() => void zoomIn()}
      />
      <Button
        size="xs"
        variant="ghost"
        iconOnly
        leadingIcon={Scan}
        aria-label={t("mission.canvasFit")}
        onClick={() => void fitView({ padding: 0.2 })}
      />
      <Button
        size="xs"
        variant="ghost"
        iconOnly
        leadingIcon={Maximize}
        aria-label={t("mission.canvasFocusPool")}
        onClick={focusPool}
      />
    </div>
  );
}
