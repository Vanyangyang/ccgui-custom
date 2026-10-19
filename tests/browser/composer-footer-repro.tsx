// Repro fixture: the REAL ConversationFooter (same composer the session
// page uses) with an active session seeded into the real chat store, plus
// seeded agent/prompt catalogs. Type `#` / `!` in the field to exercise the
// pickers exactly as the app does. Probe: after typing, document body text
// must contain 我的智能体 / 新建智能体 (agent menu) or 新建提示词.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "../../src/index.css";
import "../../src/lib/i18n";
import { ConversationFooter } from "../../src/features/chat/components/ConversationFooter";
import { useChatStore } from "../../src/features/chat/store";
import { useAgentStore } from "../../src/features/agents/agent-store";
import { usePromptStore } from "../../src/features/prompts/prompt-store";

const ROOT = "/fixture-ws";

useAgentStore.setState({
  agents: [
    { id: "a1", name: "代码审查员", prompt: "你是严格的代码审查员…", icon: "🔍" },
  ],
  builtInAgents: [],
  builtInDivisions: [],
  loaded: true,
  refresh: async () => {},
});
usePromptStore.setState({
  byRoot: {
    [ROOT]: {
      entries: [
        { name: "review", path: "/fixture-ws/.ccgui/prompts/review.md", description: "逐行审查", content: "请审查…", scope: "workspace" },
      ],
      status: "ready",
      fetchedAt: Date.now(),
    },
  },
  ensure: () => {},
  refresh: async () => {},
});

const ACTIVE = { engine: "claude", sessionId: "s-1", workspacePath: ROOT };

function Fixture() {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex min-h-dvh flex-col justify-end bg-background-primary-default">
      <ConversationFooter
        active={ACTIVE}
        workspaces={[]}
        queue={[]}
        onRemoveQueued={() => {}}
        onMoveQueued={() => {}}
        onSendQueuedNow={() => {}}
        imageError={null}
        branchError={null}
        onDismissImageError={() => {}}
        onDismissBranchError={() => {}}
        images={[]}
        previews={{}}
        onRemoveImage={() => {}}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={() => {}}
        sendShortcut="enter"
        onStop={() => {}}
        streaming={false}
        noEnabledEngines={false}
        composerInputRef={{ current: null }}
        addMenu={null}
        cliMenu={null}
        permissionMenu={null}
        supportsImages={false}
        onPasteImages={() => {}}
        sessionUsage={null}
        contextMax={0}
        branch={undefined}
        branches={undefined}
        onBranchSelect={() => {}}
        startNewChat={() => {}}
      />
    </div>
  );
}

createRoot(document.getElementById("fixture")!).render(
  <HashRouter>
    <Fixture />
  </HashRouter>,
);
