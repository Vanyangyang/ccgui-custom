import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { panelTabRegistry } from "@ccgui/plugin-sdk";
import "../../src/index.css";
import "../../src/lib/i18n";
import { ChatSidePanel } from "../../src/features/chat/ChatSidePanel";
import { useGitStore } from "../../src/features/git/store";
import { useFilesStore } from "../../src/features/files/store";

const workspacePath = "/performance-fixture";
let refreshes = 0;
let branchLoads = 0;
let lastAction = "none";

function report() {
  const metrics = document.getElementById("metrics");
  if (metrics) metrics.textContent = JSON.stringify({
    refreshes,
    branchLoads,
    mountedRows: document.querySelectorAll("#panel li").length,
    lastAction,
  });
}

useFilesStore.setState({ repositories: {}, selectedPath: null });
useGitStore.setState({
  statusByWorkspace: {
    [workspacePath]: {
      branch: "main",
      staged: [{ path: "staged.ts", status: "M", additions: 1, deletions: 0 }],
      unstaged: [],
      untracked: Array.from({ length: 10000 }, (_, index) => ({
        path: `src/generated/file-${String(index).padStart(5, "0")}.ts`,
        status: "?",
        additions: 0,
        deletions: 0,
      })),
    },
  },
  branchesByWorkspace: { [workspacePath]: [{ name: "main" }] },
  refresh: async () => { refreshes++; report(); },
  loadBranches: async () => { branchLoads++; report(); },
  stage: async (_workspace, paths) => { lastAction = `stage:${paths.join(",")}`; report(); },
  unstage: async (_workspace, paths) => { lastAction = `unstage:${paths.join(",")}`; report(); },
  openDiff: (_workspace, target) => { lastAction = `diff:${target.file}`; report(); },
});
panelTabRegistry.register({ id: "files", label: () => "Files", component: () => <div>Files placeholder</div> });

function Fixture() {
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelTab, setPanelTab] = useState("files");
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const observer = new MutationObserver(report);
    observer.observe(document.getElementById("panel")!, { childList: true, subtree: true });
    report();
    return () => observer.disconnect();
  }, []);
  return (
    <main className="p-4 text-text-primary">
      <h1>Git performance: 10,001 changed files</h1>
      <div className="my-3 flex gap-4">
        <button onClick={() => setPanelTab("files")}>Show files</button>
        <button onClick={() => setPanelTab("changes")}>Show changes</button>
        <button onClick={() => setCollapsed(value => !value)}>Toggle collapsed</button>
      </div>
      <output id="metrics" className="block font-mono" />
      <div id="panel" className="mt-3 flex h-[540px] w-[480px] border border-separator-border">
        <ChatSidePanel
          active={{ engine: "omp", sessionId: null, workspacePath }}
          panelRef={panelRef}
          panelWidth={478}
          panelCollapsed={collapsed}
          dragging={null}
          panelTab={panelTab}
          onResizeStart={() => {}}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
