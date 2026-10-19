// Production UI, document-local fake IPC. No native storage, focus or model work.
import { createRoot } from "react-dom/client";
import { ReminderPopover } from "../../src/features/assistant-notices/ReminderPopover";
import { InlineAside } from "../../src/features/assistant-notices/InlineAside";
import { AssistantNoticesOverlay } from "../../src/features/assistant-notices/AssistantNoticesOverlay";
import { AssistantNoticesControl } from "../../src/features/assistant-notices/AssistantNoticesControl";
import type { AssistantNoticeSource } from "../../src/features/assistant-notices/types";
import i18n from "../../src/lib/i18n";
import "../../src/index.css";

declare global { interface Window { __assistantNoticesFixture: { source: AssistantNoticeSource; state: { calls: unknown[]; failOpen: boolean; failRead: boolean }; emit: (event: string) => void; concurrentSettings: () => void; changeProvider: () => void } } }
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
const scene = params.get("scene") ?? "main";
function Fixture() {
  if (scene === "overlay") return <AssistantNoticesOverlay />;
  return <main className="min-h-dvh bg-background-primary-default p-3 text-text-primary" style={{width:"100%",boxSizing:"border-box"}}>
    <header className="mb-4 flex items-center justify-between gap-2"><h1 className="text-body-medium">本地通知 · 浏览器模拟</h1><ReminderPopover /></header>
    <div className="mb-4 flex flex-wrap gap-2 text-caption-1-regular">
      <button data-testid="fail-open" onClick={() => { window.__assistantNoticesFixture.state.failOpen = true; }}>下次打开失败</button>
      <button data-testid="fail-feed" onClick={() => { window.__assistantNoticesFixture.state.failRead = true; window.__assistantNoticesFixture.emit("assistant-notices://changed"); }}>读取失败</button>
      <button data-testid="recover-feed" onClick={() => { window.__assistantNoticesFixture.state.failRead = false; }}>恢复读取</button>
      <button data-testid="concurrent-settings" onClick={() => window.__assistantNoticesFixture.concurrentSettings()}>模拟其他窗口更改语音、屏幕和模型（先编辑本页再点）</button>
      <button data-testid="change-provider" onClick={() => window.__assistantNoticesFixture.changeProvider()}>模拟 Codex 供应商目录更新</button>
    </div>
    {scene !== "settings" && <><div className="rounded-lg border border-border-button-default p-3">模拟会话正文：无真实模型调用。</div><InlineAside source={window.__assistantNoticesFixture.source} /><textarea aria-label="模拟草稿区域" className="mb-5 w-full rounded-lg border border-border-button-default p-3" placeholder="草稿仅通过 exact id IPC 验证" /></>}
    <AssistantNoticesControl />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
