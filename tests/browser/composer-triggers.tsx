// Open /tests/browser/composer-triggers.html with the Vite dev server
// running. Mounts the REAL chat Composer with seeded agent/prompt catalogs
// (no backend) so the `#` agent picker and `!` prompt picker can be
// exercised end to end: click the field, type `#` or `!` at line start,
// and the picker must appear above the composer. Probe: window.__probe()
// returns { text, agentOpen, promptOpen }.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "../../src/index.css";
import "../../src/lib/i18n";
import { Composer } from "../../src/components/application/ai-chat/ai-chat-composer";
import { useAgentStore } from "../../src/features/agents/agent-store";
import { usePromptStore } from "../../src/features/prompts/prompt-store";

const ROOT = "/fixture-ws";

useAgentStore.setState({
  agents: [
    { id: "a1", name: "代码审查员", prompt: "你是严格的代码审查员…", icon: "🔍" },
    { id: "a2", name: "文档写手", prompt: "把代码改动能讲清楚。", icon: "📝" },
  ],
  builtInAgents: [
    { id: "agency-agents:test-1", divisionId: "testing", name: "Test Engineer", description: "Writes exhaustive test plans.", icon: "🧪", enabled: true },
  ],
  builtInDivisions: [
    { id: "testing", order: 0, icon: "FlaskConical", color: "#F59E0B", label: "测试与质量", count: 9, enabledCount: 1 },
  ],
  loaded: true,
  refresh: async () => {},
});

usePromptStore.setState({
  byRoot: {
    [ROOT]: {
      entries: [
        { name: "review", path: "/fixture-ws/.ccgui/prompts/review.md", description: "逐行审查当前改动", content: "请审查…", scope: "workspace" },
      ],
      status: "ready",
      fetchedAt: Date.now(),
    },
  },
  ensure: () => {},
  refresh: async () => {},
});

function Fixture() {
  const [value, setValue] = useState("");
  return (
    <div className="min-h-dvh bg-background-primary-default px-4 py-8">
      <div className="mx-auto max-w-[750px]">
        <Composer
          value={value}
          onValueChange={setValue}
          workspacePath={ROOT}
          onSubmit={() => {}}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("fixture")!).render(<HashRouter><Fixture /></HashRouter>);
