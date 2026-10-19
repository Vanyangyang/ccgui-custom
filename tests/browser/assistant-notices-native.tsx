// Dedicated native test binary only. Real IPC/runtime; synthetic session data only.
import "../../src/lib/engine-compat";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, listen } from "../../src/lib/transport";
import { useChatStore } from "../../src/features/chat/store";
import { sessionKey } from "../../src/features/chat/store/persistence";
import { startAssistantNoticesRuntime } from "../../src/features/assistant-notices/runtime";
import { ReminderPopover } from "../../src/features/assistant-notices/ReminderPopover";
import { InlineAside } from "../../src/features/assistant-notices/InlineAside";
import { AssistantNoticesControl } from "../../src/features/assistant-notices/AssistantNoticesControl";
import { installTauriUnlistenGuard } from "../../src/lib/tauri-unlisten-guard";
import type { AssistantNotice, AssistantNoticeSource, AssistantNoticesStatus } from "../../src/features/assistant-notices/types";
import i18n from "../../src/lib/i18n";
import "../../src/index.css";

interface FixtureState {
  sources: AssistantNoticeSource[]; notices: AssistantNotice[]; status: AssistantNoticesStatus;
  root: string; observerDisabled: boolean; mainForeground?: boolean; windows: unknown[]; monitors: unknown[];
}
installTauriUnlistenGuard();
await i18n.changeLanguage("zh");
const initial = await invoke<FixtureState>("assistant_notices_fixture_state");
let failNextSelection = false;
const sources = initial.sources;
const tabs = sources.map(({ engine, sessionId, workspacePath }) => ({ engine, sessionId, workspacePath }));
// Do not call chat.init or any engine/history action. Runtime and draft insertion use the real store.
useChatStore.setState({
  openTabs: tabs, active: tabs[0], drafts: {},
  sessions: sources.map(source => ({ ...source, customTitle: source.label, title: source.label,
    preview: "Synthetic fixture", filePath: "", fileSize: 0, fileMtimeMs: 0, createdAt: null,
    updatedAt: null, messageCount: 0, pinned: false })),
  selectSession: async (engine, sessionId, workspacePath) => {
    if (failNextSelection) { failNextSelection = false; throw new Error("Requested synthetic selection failure"); }
    const tab = tabs.find(tab => tab.engine === engine && tab.sessionId === sessionId && tab.workspacePath === workspacePath);
    if (!tab) throw new Error("Only synthetic fixture sessions can be selected");
    useChatStore.setState({ active: { ...tab } });
  },
});
const runtimeTrace: Record<string, unknown> = {};
const observedInvoke: typeof invoke = async (command, args) => {
  const tracked = command === "assistant_notices_sync" || command === "assistant_notices_focus_ack";
  const data = args as Record<string, unknown> | undefined;
  if (tracked) runtimeTrace[command] = { attentive: data?.attentive, success: data?.success, pending: true };
  try {
    const result = await invoke(command, args);
    if (tracked) runtimeTrace[command] = { attentive: data?.attentive, success: data?.success, result: "ok" };
    return result;
  } catch (error) {
    if (tracked) runtimeTrace[command] = { attentive: data?.attentive, success: data?.success, error: String(error) };
    throw error;
  }
};
const stopRuntime = startAssistantNoticesRuntime({ visible: () => true, subscribePresence: () => () => {}, dismiss: () => {}, invoke: observedInvoke });
if (import.meta.hot) import.meta.hot.dispose(stopRuntime);

function Fixture() {
  const active = useChatStore(state => state.active);
  const drafts = useChatStore(state => state.drafts);
  const [state, setState] = useState(initial);
  const [error, setError] = useState("");
  const [clicks, setClicks] = useState(0);
  const [lastAction, setLastAction] = useState("就绪");
  useEffect(() => {
    let disposed = false;
    const read = () => { void invoke<FixtureState>("assistant_notices_fixture_state").then(next => { if (!disposed) setState(next); }).catch(e => { if (!disposed) setError(String(e)); }); };
    const timer = setInterval(read, 1000);
    let unlisten: (() => void) | undefined;
    void listen("assistant-notices://changed", read).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; clearInterval(timer); unlisten?.(); };
  }, []);
  async function action(command: string, args: Record<string, unknown>) {
    setError("");
    try { const result = await invoke(command, args); setLastAction(JSON.stringify({ command, args, result })); }
    catch (e) { setError(String(e)); }
  }
  const activeSource = sources.find(source => source.sessionId === active?.sessionId) ?? null;
  const key = active ? sessionKey(active.engine, active.sessionId, active.workspacePath) : "";
  return <main className="min-h-dvh bg-background-primary-default p-4 text-text-primary">
    <header className="mb-3 flex items-center justify-between gap-3"><h1 className="text-heading-3">原生提醒独立验收 · 合成来源</h1><ReminderPopover /></header>
    <p className="mb-3">仅本测试进程：隔离存储 / 无模型 / 无真实历史。15 分钟自动退出，不关闭正在运行的 CCGUI。</p>
    <div className="mb-3 flex flex-wrap gap-2">
      {sources.map((source, index) => <button className="rounded border p-2" key={source.sessionId} onClick={() => { useChatStore.setState({ active: { ...tabs[index] } }); }}>切换来源 {index === 0 ? "A" : "B"}</button>)}
      <button className="rounded border p-2" onClick={() => { failNextSelection = true; setLastAction("下次来源选择将失败；测试入口保留与重试"); }}>下次打开模拟失败</button>
    </div>
    <p className="mb-3 font-semibold" data-testid="active-source">当前来源：{activeSource?.label}</p>
    <p className="mb-3 text-xs" data-testid="native-focus-trace">焦点诊断：{JSON.stringify({ domFocus: document.hasFocus(), visibility: document.visibilityState, hash: location.hash, mainForeground: state.mainForeground, native: state.windows, runtime: runtimeTrace })}</p>
    <div className="mb-3 flex flex-wrap gap-2">
      {(["a", "b"] as const).flatMap(source => (["completion", "aside"] as const).map(kind => <button className="rounded border p-2" key={source + kind} onClick={() => void action("assistant_notices_fixture_seed", { source, kind })}>种入 {source.toUpperCase()} {kind === "completion" ? "完成" : "旁白"}</button>))}
      <button className="rounded border p-2" onClick={() => void action("assistant_notices_fixture_control", { action: "clear" })}>测试记录全部已读</button>
      <button className="rounded border p-2" onClick={() => void action("assistant_notices_fixture_control", { action: "recreateOverlay" })}>重建提醒浮层</button>
      <button className="rounded border p-2" onClick={() => void action("assistant_notices_fixture_control", { action: "close" })}>结束本测试窗口</button>
    </div>
    <button type="button" data-testid="click-through" onClick={() => setClicks(count => count + 1)} style={{ width: "100%", minHeight: 180, border: "3px dashed #3b82f6", background: "#3b82f61a", borderRadius: 12, fontSize: 22, marginBottom: 12 }}>
      点击穿透测试区 · 已收到 {clicks} 次点击<br /><span style={{ fontSize: 14 }}>把来源 B 的浮层拖到此区域；点击透明边缘应增加计数，点击实体卡片不应增加。</span>
    </button>
    <InlineAside source={activeSource} />
    <label className="mb-3 block">当前来源草稿（真实 insertSideAnswer，永不发送）<textarea data-testid="draft" className="mt-2 w-full rounded border p-2" rows={4} value={drafts[key] ?? ""} onChange={event => useChatStore.getState().setDraft(key, event.target.value)} /></label>
    {error && <p role="alert" className="mb-3 text-red-600">{error}</p>}
    <p className="mb-3 break-all text-xs">最近测试动作：{lastAction}</p>
    <AssistantNoticesControl />
    <details className="mt-4"><summary>隔离证据 / 原生窗口与屏幕 / 通知读状态</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(state, null, 2)}</pre></details>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
