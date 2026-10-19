// Open /tests/browser/creator-jump.html with the Vite dev server running.
// Regression: 插件中心点「创建插件」后，中心面从插件 hub 切回聊天，输入框必须
// **真的拿到光标**（之前直接 focus()，那一帧输入框还在 visibility:hidden 的
// Surface 里，浏览器静默忽略 → 用户还得手点一下）。这里挂的是真实
// PluginHub + 真实 ChatCenterPane + 真实 Composer，按真实顺序点击并断言。
// Probe: window.__probe() returns the PASS/FAIL map rendered on screen.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "../../src/index.css";
import "../../src/lib/i18n";
import type { ComposerInputHandle } from "../../src/components/application/ai-chat/ai-chat-composer";
import { ChatCenterPane } from "../../src/features/chat/ChatCenterPane";
import { sessionKey, useChatStore } from "../../src/features/chat/store";
import { usePluginHubStore } from "../../src/features/plugins/hub/store";
import { extractText, getCaretOffset } from "../../src/components/application/ai-chat/file-tags";

const ROOT = "/fixture-ws";
const COMMAND = "ccgui-plugin-creator";

const WORKSPACE = {
  id: "ws-1",
  path: ROOT,
  name: "fixture-ws",
  lastOpenedAt: null,
  sortOrder: null,
  groupId: null,
};

// 聊天状态：一个活动的新会话（sessionId null = 待发草稿），插件 hub 在前台。
useChatStore.setState({
  activeEngine: "claude",
  workspaces: [WORKSPACE],
  openTabs: [{ engine: "claude", sessionId: null, workspacePath: ROOT }],
  active: { engine: "claude", sessionId: null, workspacePath: ROOT },
  drafts: {},
  bySession: {},
  archivedSessionKeys: {},
  activeWorkspaceId: WORKSPACE.id,
});
usePluginHubStore.setState({ open: true, active: true, view: "market" });

function Fixture() {
  const composerInputRef = useRef<ComposerInputHandle | null>(null);
  const [probe, setProbe] = useState<Record<string, boolean> | null>(null);
  const [samples, setSamples] = useState<string>("");

  useEffect(() => {
    const log: string[] = [];
    const steps = [150, 250, 400, 700, 1300];
    for (const ms of steps) {
      window.setTimeout(() => {
        if (ms === 150) {
          const button = [...document.querySelectorAll("button")].find(
            (candidate) => candidate.textContent?.trim() === "创建插件",
          );
          log.push(`click=${button ? "found" : "MISSING"}`);
          try {
            button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            log.push("dispatched");
          } catch (error) {
            log.push(`throw=${String(error)}`);
          }
        }
        const el = document.querySelector<HTMLElement>(".composer-editable");
        log.push(
          `${ms}ms ref=${composerInputRef.current ? "y" : "n"} active=${
            document.activeElement === el ? "editable" : (document.activeElement?.tagName ?? "?")
          } vis=${el && !el.closest(".invisible") ? "y" : "n"}`,
        );
        setSamples(log.join(" | "));
        if (ms === steps[steps.length - 1]) setProbe(runProbe());
      }, ms);
    }
  }, []);

  return (
    <div className="min-h-dvh bg-background-primary-default">
      <ChatCenterPane
        active={useChatStore.getState().active}
        engines={[]}
        workspaces={[WORKSPACE]}
        startNewChat={(path) => useChatStore.getState().startNewChat(path)}
        composerInputRef={composerInputRef}
        openFiles={[]}
        activeFilePath={null}
        browserTabs={[]}
        activeBrowserId={null}
        pluginTabs={[]}
        activePluginTabId={null}
        pluginHubOpen
        pluginHubActive={usePluginHubStore((s) => s.active)}
        missionOpen={false}
        missionActive={false}
        diffView={null}
        diffStatus={undefined}
        closeDiff={() => {}}
      />
      {samples && (
        <pre
          id="trace"
          className="fixed right-2 bottom-2 z-50 max-w-[70vw] rounded bg-background-secondary-default p-2 text-caption-1-regular text-text-secondary"
        >
          {samples}
        </pre>
      )}
      {probe && (
        <pre
          id="probe-result"
          className="fixed bottom-2 left-2 z-50 rounded bg-background-secondary-default p-2 text-caption-1-regular text-text-secondary"
        >
          {Object.entries(probe)
            .map(([key, ok]) => `${ok ? "PASS" : "FAIL"} ${key}`)
            .join("\n")}
        </pre>
      )}
    </div>
  );
}

function runProbe(): Record<string, boolean> {
  const editable = document.querySelector<HTMLElement>(".composer-editable");
  const active = document.activeElement;
  const draft = useChatStore.getState().drafts[sessionKey("claude", null, ROOT)];
  return {
    hubLeftTheFront: usePluginHubStore.getState().active === false,
    composerIsVisible: editable !== null && editable.closest(".invisible") === null,
    composerHasFocus: active instanceof HTMLElement && editable !== null && active === editable,
    draftIsTheCommand: draft === `/${COMMAND} `,
    // 预填的指令按原文落进输入框（斜杠命令不再有 chip 之类的展示层）。
    composerTextIsTheDraft: editable !== null && extractText(editable) === `/${COMMAND} `,
    // 光标落在预填文本之后（用户接着敲需求）：之前 innerHTML 重建后没人管
    // 光标，focus() 把插入点放回内容开头。
    caretAfterThePrefill:
      editable !== null && getCaretOffset(editable) === `/${COMMAND} `.length,
  };
}

createRoot(document.getElementById("fixture")!).render(
  <HashRouter>
    <Fixture />
  </HashRouter>,
);

const act = globalThis as { __probe?: () => unknown };
act.__probe = runProbe;
