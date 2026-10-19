// Open /tests/browser/agent-prompt-menus.html with the Vite dev server
// running. Renders the real `#` agent menu (grouped: 我的智能体 + division
// sections) and the real `!` prompt menu against seeded stores — no backend,
// no session. Also renders a filtered `#` query to check flat mode.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { useAgentStore } from "../../src/features/agents/agent-store";
import { usePromptStore } from "../../src/features/prompts/prompt-store";
import { AgentMenu } from "../../src/components/application/ai-chat/agent-menu";
import { PromptMenu } from "../../src/components/application/ai-chat/prompt-menu";

const ROOT = "/fixture-ws";

useAgentStore.setState({
  agents: [
    { id: "a1", name: "代码审查员", prompt: "你是严格的代码审查员…", icon: "🔍" },
    { id: "a2", name: "文档写手", prompt: "把代码改动能讲清楚。", icon: "📝" },
  ],
  builtInAgents: [
    { id: "agency-agents:eng-1", divisionId: "engineering", name: "Backend Architect", description: "Designs reliable backend systems.", icon: "🏗️", enabled: true },
    { id: "agency-agents:test-1", divisionId: "testing", name: "Test Engineer", description: "Writes exhaustive test plans.", icon: "🧪", enabled: true },
  ],
  builtInDivisions: [
    { id: "engineering", order: 0, icon: "Code", color: "#3B82F6", label: "工程研发", count: 54, enabledCount: 1 },
    { id: "testing", order: 1, icon: "FlaskConical", color: "#F59E0B", label: "测试与质量", count: 9, enabledCount: 1 },
  ],
  loaded: true,
  // Keep the seeded catalog: the real refresh talks IPC, absent here.
  refresh: async () => {},
});

usePromptStore.setState({
  byRoot: {
    [ROOT]: {
      entries: [
        { name: "review", path: "/ws/.ccgui/prompts/review.md", description: "逐行审查当前改动", argumentHint: "<文件路径>", content: "请审查 $ARGUMENTS …", scope: "workspace" },
        { name: "standup", path: "/home/.ccgui-next/prompts/standup.md", description: "生成站会日报", content: "总结今天的进展…", scope: "global" },
      ],
      status: "ready",
      fetchedAt: Date.now(),
    },
  },
  ensure: () => {},
  refresh: async () => {},
});

function Fixture() {
  return (
    <div className="min-h-dvh bg-background-primary-default px-4 py-8">
      <div className="mx-auto flex max-w-[750px] flex-col gap-6">
        <section>
          <p className="mb-2 text-caption-1-medium text-text-tertiary"># 菜单（空查询，分组）</p>
          <div className="relative h-[320px] rounded-xl border border-separator-border bg-background-secondary-default p-2">
            <AgentMenu query="" left={8} onSelect={() => {}} onClose={() => {}} />
          </div>
        </section>
        <section>
          <p className="mb-2 text-caption-1-medium text-text-tertiary"># 菜单（查询 “test”，平铺过滤）</p>
          <div className="relative h-[160px] rounded-xl border border-separator-border bg-background-secondary-default p-2">
            <AgentMenu query="test" left={8} onSelect={() => {}} onClose={() => {}} />
          </div>
        </section>
        <section>
          <p className="mb-2 text-caption-1-medium text-text-tertiary">! 菜单</p>
          <div className="relative h-[200px] rounded-xl border border-separator-border bg-background-secondary-default p-2">
            <PromptMenu root={ROOT} query="" left={8} onSelect={() => {}} onClose={() => {}} />
          </div>
        </section>
      </div>
    </div>
  );
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
