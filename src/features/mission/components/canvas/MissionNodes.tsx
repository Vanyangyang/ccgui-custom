import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cx } from "@/utils/cx";
import type {
  MissionCanvasNode,
  MissionDefinitionNodeData,
  MissionGroupNodeData,
  MissionItemNodeData,
} from "./mission-graph";
import { NODE_TYPE_I18N_KEY, STATUS_I18N_KEY, statusClasses } from "./status";

/**
 * 画布自定义节点（固定 React 组件，6 种节点类型各一套外观）。
 * 节点数据只决定标题/参数/状态；AI 不生成 JSX。
 * 节点只读：不能拖动、不能连线，只允许选中查看详情。
 */

const HIDDEN_HANDLE = "!size-1.5 !border-0 !bg-transparent !opacity-0";

function DefinitionCard({
  data,
  nodeType,
}: {
  data: MissionDefinitionNodeData;
  nodeType: string;
}) {
  const { t } = useTranslation();
  const status = data.status;
  const colors = statusClasses(status);
  return (
    <div
      className={cx(
        "w-[204px] rounded-lg border px-3 py-2.5 text-left shadow-xs transition-shadow",
        colors.card,
        data.selected && "ring-2 ring-border-focus-ring ring-offset-1",
      )}
      data-node-id={data.node.id}
      aria-label={`${t(NODE_TYPE_I18N_KEY[nodeType] ?? nodeType)} ${data.node.title}`}
    >
      <Handle type="target" position={Position.Left} className={HIDDEN_HANDLE} isConnectable={false} />
      <div className="flex items-center justify-between gap-1">
        <span className="text-caption-1-medium uppercase tracking-wide text-text-tertiary">
          {t(NODE_TYPE_I18N_KEY[nodeType] ?? nodeType)}
        </span>
        <span className="flex items-center gap-1">
          {data.unavailableReason && (
            <span className="rounded-sm bg-status-rose-background px-1 py-0.5 text-caption-1-medium text-status-rose-text">
              {t("mission.unavailableBadge")}
            </span>
          )}
          {data.simulated && (
            <span className="rounded-sm border border-border-button-default px-1 py-0.5 text-caption-1-medium text-text-tertiary">
              {t("mission.simulatedBadge")}
            </span>
          )}
        </span>
      </div>
      <div className="mt-1.5 text-body-2-medium text-text-primary">{data.node.title}</div>
      {status && (
        <div className={cx("mt-1.5 text-caption-1-regular", colors.text)}>
          {t(STATUS_I18N_KEY[status] ?? "mission.statusQueued")}
          {data.hasFeedback && ` · ${t("mission.hasFeedback")}`}
        </div>
      )}
      {!status && data.node.description && (
        <div className="mt-1.5 line-clamp-2 text-caption-1-regular text-text-tertiary">
          {data.node.description}
        </div>
      )}
      <Handle type="source" position={Position.Right} className={HIDDEN_HANDLE} isConnectable={false} />
    </div>
  );
}

function GroupCard({ data }: { data: MissionGroupNodeData }) {
  const { t } = useTranslation();
  const isRun = data.itemCount > 0 && data.runningCount > 0;
  return (
    <div
      className={cx(
        "h-full w-full rounded-xl border-2 border-dashed p-0",
        isRun ? "border-status-blue-text/50 bg-status-blue-background/20" : "border-border-button-default bg-background-secondary-default/40",
      )}
      data-node-id={data.node.id}
    >
      <Handle type="target" position={Position.Left} className={HIDDEN_HANDLE} isConnectable={false} />
      <div className="flex items-start justify-between gap-3 px-4 pt-2.5">
        <div>
          <div className="text-body-2-medium text-text-secondary">
            {t("mission.poolCaption", { concurrency: data.concurrency })}
          </div>
          <div className="text-caption-1-regular text-text-tertiary">
            {data.itemCount > 0
              ? t("mission.poolSubtitle")
              : t("mission.poolCaptionSub")}
          </div>
        </div>
        {data.itemCount > 0 && (
          <span className="rounded-sm border border-border-button-default bg-background-primary-default px-1.5 py-0.5 text-caption-1-medium text-text-secondary">
            {t("mission.poolBadge", {
              running: data.runningCount,
              concurrency: data.concurrency,
            })}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className={HIDDEN_HANDLE} isConnectable={false} />
    </div>
  );
}

function ItemCard({ data }: { data: MissionItemNodeData }) {
  const { t } = useTranslation();
  const colors = statusClasses(data.item.status);
  const stageIndex = data.stageTitle
    ? data.stageTitles.indexOf(data.stageTitle)
    : -1;
  return (
    <div
      className={cx(
        "w-[136px] rounded-md border px-2.5 py-2 text-left shadow-xs transition-shadow",
        colors.card,
        data.selected && "ring-2 ring-border-focus-ring ring-offset-1",
      )}
      data-item-id={data.item.itemId}
      data-state={data.item.status}
      aria-label={data.item.label}
    >
      <Handle type="target" position={Position.Left} className={HIDDEN_HANDLE} isConnectable={false} />
      <div className="truncate font-mono text-caption-1-regular text-text-tertiary">
        {data.item.label}
      </div>
      <div className={cx("mt-1 text-caption-1-regular", colors.text)}>
        {t(STATUS_I18N_KEY[data.item.status] ?? "mission.statusQueued")}
      </div>
      {data.item.status === "running" && data.stageTitle && (
        <div className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">
          {data.stageTitle}
          {stageIndex >= 0 && ` · ${stageIndex + 1}/${data.stageTitles.length}`}
        </div>
      )}
      {data.item.approved && (
        <div className="mt-0.5 text-caption-1-regular text-status-green-text">
          {t("mission.approvedBadge")}
        </div>
      )}
      <Handle type="source" position={Position.Right} className={HIDDEN_HANDLE} isConnectable={false} />
    </div>
  );
}

function InputNode(props: NodeProps<MissionCanvasNode>) {
  return <DefinitionCard data={props.data as MissionDefinitionNodeData} nodeType="input" />;
}
function ToolNode(props: NodeProps<MissionCanvasNode>) {
  return <DefinitionCard data={props.data as MissionDefinitionNodeData} nodeType="tool" />;
}
function AgentNode(props: NodeProps<MissionCanvasNode>) {
  return <DefinitionCard data={props.data as MissionDefinitionNodeData} nodeType="agent" />;
}
function HumanNode(props: NodeProps<MissionCanvasNode>) {
  return <DefinitionCard data={props.data as MissionDefinitionNodeData} nodeType="human" />;
}
function OutputNode(props: NodeProps<MissionCanvasNode>) {
  return <DefinitionCard data={props.data as MissionDefinitionNodeData} nodeType="output" />;
}
function ForeachNode(props: NodeProps<MissionCanvasNode>) {
  return <GroupCard data={props.data as MissionGroupNodeData} />;
}
function ItemNode(props: NodeProps<MissionCanvasNode>) {
  return <ItemCard data={props.data as MissionItemNodeData} />;
}

export const MISSION_NODE_TYPES = {
  input: memo(InputNode),
  tool: memo(ToolNode),
  agent: memo(AgentNode),
  human: memo(HumanNode),
  output: memo(OutputNode),
  foreach: memo(ForeachNode),
  missionGroup: memo(ForeachNode),
  missionItem: memo(ItemNode),
};
