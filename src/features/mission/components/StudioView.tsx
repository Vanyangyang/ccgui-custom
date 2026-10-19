import { ConversationPane } from "./ConversationPane";
import { CanvasPane } from "./CanvasPane";

/** 流程编排：左侧对话 + 右侧画布（定义视图 / 运行视图切换）。 */
export function StudioView() {
  return (
    <div className="flex h-full min-h-0">
      <ConversationPane />
      <CanvasPane />
    </div>
  );
}
