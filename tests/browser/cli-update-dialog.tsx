// Open /tests/browser/cli-update-dialog.html with the Vite dev server running.
// Visual smoke for the one-click CLI install dialog (CLI 一键安装):
// plan → confirm → streaming live log → done, driven by a fixture flow —
// no real install ever runs.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import type { CliUpdateFlow, CliUpdateFlowState } from "../../src/features/settings/useCliUpdateFlow";

localStorage.setItem("ccgui-next.language", "zh");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const IDLE: CliUpdateFlowState = { status: "idle", plan: null, error: null, runId: null, logs: [] };

async function main() {
  await import("../../src/lib/i18n");
  const { CliUpdateDialog } = await import("../../src/features/settings/CliUpdateDialog");

  function Fixture() {
    const [state, setState] = useState<CliUpdateFlowState>(IDLE);
    const flow: CliUpdateFlow = {
      state,
      begin: async () => {
        setState({ ...IDLE, status: "planning" });
        await sleep(400);
        setState({
          ...IDLE,
          status: "ready",
          plan: {
            engine: "claude",
            action: "update",
            kind: "native",
            command: ["bash", "-lc", "curl -fsSL https://claude.ai/install.sh | bash"],
            manualCommand: "bash -lc curl -fsSL https://claude.ai/install.sh | bash",
            canRun: true,
            blockers: [],
            platform: "macos",
          },
        });
      },
      confirm: async () => {
        setState((cur) => ({ ...cur, status: "running", runId: "fixture-run", logs: [], error: null }));
        const lines: Array<{ stream: "stdout" | "stderr"; text: string }> = [
          { stream: "stdout", text: "  Downloading Claude Code..." },
          { stream: "stdout", text: "  Installing to ~/.local/bin/claude" },
          { stream: "stderr", text: "  warn: cache entry expired, refetching" },
          { stream: "stdout", text: "✓ Claude Code successfully installed!" },
          { stream: "stdout", text: "  Version: 2.1.267" },
        ];
        for (const line of lines) {
          await sleep(350);
          setState((cur) => ({ ...cur, logs: [...cur.logs, line] }));
        }
        setState((cur) => ({ ...cur, status: "done" }));
      },
      close: () => setState(IDLE),
    };
    return (
      <div style={{ padding: 24 }}>
        <button id="open" onClick={() => void flow.begin()}>
          打开安装弹窗
        </button>
        <CliUpdateDialog engine="claude" flow={flow} />
      </div>
    );
  }

  createRoot(document.getElementById("fixture")!).render(<Fixture />);
  document.getElementById("result")!.textContent = JSON.stringify({ status: "PASS" });
}

main().catch((error) => {
  document.getElementById("result")!.textContent = JSON.stringify({
    status: "FAIL",
    error: String(error),
  });
});
