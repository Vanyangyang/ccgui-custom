import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { findCapability } from "../catalog";
import { latestRunOf } from "../runtime";
import { useMissionStore } from "../store";
import type {
  MissionFlow,
  MissionFlowDefinition,
  MissionFlowNode,
  MissionRun,
  MissionTaskInstance,
} from "../types";
import { NODE_TYPE_I18N_KEY, STATUS_I18N_KEY } from "./canvas/status";

/**
 * 节点/任务详情面板（只读）。
 * 运行实例不可手工改图；业务决策在收件箱进行，流程结构通过对话修改。
 */
export function NodeInspector() {
  const { flows, runs, selectedFlowId, selectedRunId, selectedNodeKey, selectNode } =
    useMissionStore(
      useShallow((s) => ({
        flows: s.flows,
        runs: s.runs,
        selectedFlowId: s.selectedFlowId,
        selectedRunId: s.selectedRunId,
        selectedNodeKey: s.selectedNodeKey,
        selectNode: s.selectNode,
      })),
    );

  if (!selectedNodeKey) return null;
  const flow = flows.find((item) => item.id === selectedFlowId);
  if (!flow?.draft) return null;
  const run: MissionRun | null =
    (selectedRunId && runs[selectedRunId]) || latestRunOf(flow, runs);

  const close = () => selectNode(null);
  const task = resolveTask(run, selectedNodeKey);
  if (task) {
    return <TaskInspector task={task} draft={flow.draft} run={run} onClose={close} />;
  }

  const definition = resolveDefinition(flow.draft.nodes, selectedNodeKey);
  if (!definition) return null;
  return (
    <DefinitionInspector
      definition={definition}
      flow={flow}
      run={run}
      onClose={close}
    />
  );
}

/** 任务实例详情：状态、同一输入项下的兄弟任务、反馈与关联消息。 */
function TaskInspector({
  task,
  draft,
  run,
  onClose,
}: {
  task: MissionTaskInstance;
  draft: MissionFlowDefinition;
  run: MissionRun | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const inbox = useMissionStore((s) => s.inbox);
  const selectInbox = useMissionStore((s) => s.selectInbox);
  const setActiveView = useMissionStore((s) => s.setActiveView);

  const related = inbox.find((item) => item.taskId === task.id);
  const nodeTasks = run?.tasks ?? [];
  const bodyTasks = task.itemId
    ? nodeTasks.filter(
        (row) => row.itemId === task.itemId && row.parentTaskId === task.parentTaskId,
      )
    : [];

  const openInbox = (inboxId: string) => {
    selectInbox(inboxId);
    setActiveView("inbox");
  };

  return (
    <Panel
      onClose={onClose}
      eyebrow={t("mission.taskEyebrow")}
      title={`${task.itemLabel ?? task.title} · ${
        resolveDefinition(draft.nodes, `node:${task.nodeId}`)?.title ?? task.title
      }`}
    >
      <p className="text-caption-1-regular leading-relaxed text-text-secondary">
        {t("mission.taskMeta", {
          status: t(STATUS_I18N_KEY[task.status]),
          attempt: task.attempt,
          risk: task.approved ? t("mission.approvedBadge") : "",
        })}
      </p>
      {bodyTasks.length > 1 && (
        <div className="mt-2">
          {bodyTasks.map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between gap-2 border-b border-separator-border py-1 text-caption-1-regular"
            >
              <span className="truncate text-text-secondary">
                {resolveDefinition(draft.nodes, `node:${row.nodeId}`)?.title ?? row.nodeId}
              </span>
              <span className="shrink-0 text-text-tertiary">
                {["running", "waiting_human", "failed"].includes(row.status)
                  ? t(STATUS_I18N_KEY[row.status])
                  : row.status === "succeeded"
                    ? t("mission.checkpointReached")
                    : t("mission.statusPending")}
              </span>
            </div>
          ))}
        </div>
      )}
      {task.feedback.length > 0 && (
        <p className="mt-2 whitespace-pre-wrap text-caption-1-regular text-text-secondary">
          {t("mission.taskFeedbackList", { text: task.feedback.join("\n") })}
        </p>
      )}
      {task.error && (
        <p className="mt-2 whitespace-pre-wrap text-caption-1-regular text-status-rose-text">
          {task.error}
        </p>
      )}
      <p className="mt-2 text-caption-1-regular leading-relaxed text-text-tertiary">
        {t("mission.taskReadonlyNote")}
      </p>
      {related && (
        <Button size="xs" className="mt-2" onClick={() => openInbox(related.id)}>
          {t("mission.openRelatedMessage")}
        </Button>
      )}
    </Panel>
  );
}

/** 流程节点定义详情：能力、Agent 指令、人工确认、输出与并行配置。 */
function DefinitionInspector({
  definition,
  flow,
  run,
  onClose,
}: {
  definition: MissionFlowNode;
  flow: MissionFlow;
  run: MissionRun | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const selectFlow = useMissionStore((s) => s.selectFlow);
  const selectNode = useMissionStore((s) => s.selectNode);

  const capability = findCapability(
    definition.input?.capabilityId ?? definition.tool?.capabilityId,
  );

  return (
    <Panel
      onClose={onClose}
      eyebrow={t("mission.definitionEyebrow")}
      title={`${t(NODE_TYPE_I18N_KEY[definition.type] ?? definition.type)} · ${definition.title}`}
    >
      {definition.description && (
        <p className="text-caption-1-regular leading-relaxed text-text-secondary">
          {definition.description}
        </p>
      )}
      {capability && (
        <p className="mt-2 text-caption-1-regular leading-relaxed text-text-secondary">
          <span className="text-text-tertiary">
            {capability.provider === "unavailable"
              ? t("mission.capabilityMissing")
              : capability.provider === "simulated"
                ? t("mission.capabilitySimulated")
                : t("mission.capabilityAvailable")}
          </span>
          {" · "}
          {capability.title} ({capability.id})
        </p>
      )}
      {definition.agent && (
        <p className="mt-2 whitespace-pre-wrap text-caption-1-regular leading-relaxed text-text-secondary">
          {definition.agent.instruction}
          {definition.agent.readOnly && (
            <span className="mt-1 block text-text-tertiary">
              {t("mission.capabilityReadOnly")}
            </span>
          )}
        </p>
      )}
      {definition.human && (
        <p className="mt-2 text-caption-1-regular leading-relaxed text-text-secondary">
          {definition.human.ask}
        </p>
      )}
      {definition.output && (
        <p className="mt-2 text-caption-1-regular leading-relaxed text-text-secondary">
          {definition.output.artifact}
        </p>
      )}
      {definition.foreach && (
        <p className="mt-2 text-caption-1-regular leading-relaxed text-text-secondary">
          {t("mission.poolCaption", { concurrency: definition.foreach.concurrency })}
          {" · "}
          {t("mission.poolCaptionSub")}
        </p>
      )}
      <p className="mt-2 text-caption-1-regular leading-relaxed text-text-tertiary">
        {t("mission.definitionReadonlyNote")}
      </p>
      {run && run.endedAt === undefined && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              selectFlow(flow.id, "run", run.id);
              selectNode(null);
              useMissionStore.getState().setInboxFilter("attention");
              setActiveInboxView();
            }}
          >
            {t("mission.toInboxAttention")}
          </Button>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              selectFlow(flow.id, "run", run.id);
              selectNode(null);
              useMissionStore.getState().setInboxFilter("failed");
              setActiveInboxView();
            }}
          >
            {t("mission.toInboxFailed")}
          </Button>
        </div>
      )}
    </Panel>
  );
}

/** 切到收件箱视图（两个入口共用）。 */
function setActiveInboxView(): void {
  useMissionStore.getState().setActiveView("inbox");
}

function Panel({
  children,
  onClose,
  eyebrow,
  title,
}: {
  children: React.ReactNode;
  onClose: () => void;
  eyebrow: string;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={title}
      className="absolute bottom-3 right-3 z-20 max-h-[80%] w-72 cursor-default overflow-auto rounded-xl border border-border-button-default bg-background-primary-default p-4 shadow-xl"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption-1-medium uppercase tracking-wide text-text-tertiary">
          {eyebrow}
        </span>
        <Button size="xs" variant="ghost" iconOnly leadingIcon={X} aria-label={t("mission.inspectorClose")} onClick={onClose} />
      </div>
      <h3 className="mt-2 text-body-medium text-text-primary">{title}</h3>
      <div className="mt-2">{children}</div>
    </aside>
  );
}

function resolveDefinition(
  nodes: MissionFlowNode[],
  key: string,
): MissionFlowNode | null {
  if (key.startsWith("node:")) {
    const id = key.slice("node:".length);
    for (const node of nodes) {
      if (node.id === id) return node;
      const child = node.foreach?.body.nodes.find((row) => row.id === id);
      if (child) return child;
    }
    return null;
  }
  if (key.startsWith("body:")) {
    const [, parentId, childId] = key.split(":");
    const parent = nodes.find((node) => node.id === parentId);
    return parent?.foreach?.body.nodes.find((child) => child.id === childId) ?? null;
  }
  return null;
}

function resolveTask(run: MissionRun | null, key: string): MissionTaskInstance | null {
  if (!run || !key.startsWith("task:")) return null;
  const id = key.slice("task:".length);
  return run.tasks.find((task) => task.id === id) ?? null;
}
