import type { MissionTaskStatus } from "../../types";

/** 任务/节点状态 → i18n key 的统一映射。 */
export const STATUS_I18N_KEY: Record<MissionTaskStatus, string> = {
  queued: "mission.statusQueued",
  running: "mission.statusRunning",
  waiting_human: "mission.statusWaiting",
  succeeded: "mission.statusDone",
  failed: "mission.statusFailed",
  cancelled: "mission.statusCancelled",
  excluded: "mission.statusExcluded",
};

/** 节点类型 → i18n key。 */
export const NODE_TYPE_I18N_KEY: Record<string, string> = {
  input: "mission.nodeTypeInput",
  tool: "mission.nodeTypeTool",
  agent: "mission.nodeTypeAgent",
  foreach: "mission.nodeTypeForeach",
  human: "mission.nodeTypeHuman",
  output: "mission.nodeTypeOutput",
};

/** 卡片描边/文字的颜色类（跟随宿主主题 token）。 */
export function statusClasses(status: MissionTaskStatus | null): {
  card: string;
  text: string;
} {
  switch (status) {
    case "running":
      return { card: "border-status-blue-text bg-status-blue-background/25", text: "text-status-blue-text" };
    case "waiting_human":
      return { card: "border-status-yellow-text bg-status-yellow-background/30", text: "text-status-yellow-text" };
    case "failed":
      return { card: "border-status-rose-text bg-status-rose-background/25", text: "text-status-rose-text" };
    case "succeeded":
      return { card: "border-status-green-text/70 bg-background-primary-default", text: "text-status-green-text" };
    case "excluded":
      return { card: "border-border-button-default bg-background-secondary-default", text: "text-text-tertiary" };
    case "cancelled":
      return { card: "border-border-button-default border-dashed bg-background-secondary-default", text: "text-text-tertiary" };
    default:
      return { card: "border-border-button-default bg-background-primary-default", text: "text-text-tertiary" };
  }
}
