import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BtwOverlayCard } from "@/features/sidechat/BtwOverlayCard";
import { SidechatPanel } from "@/features/sidechat/SidechatPanel";
import { useSidechatStore } from "@/features/sidechat/store";
import { useChatStore } from "@/features/chat/store";
import { parseUsage } from "@/features/chat/usage";
import type { Message } from "@/lib/ipc";
import type { SideRunProgress } from "@/features/sidechat/progress";
import i18n from "@/lib/i18n";
import "@/index.css";

const params = new URLSearchParams(location.search);
const language = params.get("lang") === "en" ? "en" : "zh";
const state = params.get("state") ?? "complete";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
await i18n.changeLanguage(language);
const key = "sidechat-browser-fixture";
const draft = "已有主会话草稿 / Existing draft 🙂";
const answer = "**旁聊答案 / Side answer** 🙂\n\n中文与 English 保持完整。\n\n- 保留已有草稿 / Keep existing draft\n- 不自动发送 / Never auto-send\n\n```ts\nconst greeting = '你好 🌏';\n```";
const streaming = ["streaming", "waiting", "quiet", "tool", "retrying"].includes(state);
const now = Date.now();
const startedAt = now - (state === "quiet" ? 95_000 : 4200);
const progress: SideRunProgress = {
  phase: state === "tool" ? "tool" : state === "retrying" ? "retrying" : state === "streaming" ? "responding" : "waiting",
  lastEventAt: state === "waiting" ? null : now - (state === "quiet" ? 65_000 : 1500),
  ...(state === "tool" ? { toolName: "Read / 示例文件夹 / 长文件名-中文-emoji-🙂.md" } : {}),
  ...(state === "retrying" ? { detail: "HTTP 503 · Provider temporarily unavailable" } : {}),
};
const hasAnswer = state === "streaming" || state === "complete";
const hasProcess = state === "streaming" || state === "tool" || state === "complete";
const error = state === "error" ? "测试错误 / Fixture error: connection unavailable，稍后重试 🙂" : null;
const message = (seq: number, role: Message["role"], text: string, live = false): Message => ({seq,role,text,live,ts:null});
const usage = parseUsage({input_tokens:1200,output_tokens:300,cache_read_input_tokens:6400});
useChatStore.setState({drafts:{[key]:draft}});
useSidechatStore.setState({
  btwBySession:{[key]:{runId:"btw-fixture",sideSessionId:"side-fixture",engine:"claude",workspacePath:"C:/fixture",parentSessionId:"parent",
    question:"顺便解释这个结果 / Explain this result 🙂",answer:hasAnswer ? streaming ? "正在整理答案 / Preparing the answer 🙂" : answer : "",
    thinking:hasProcess ? "正在核对结果 / Checking the result 🧠" : "",tools:hasProcess ? [{id:"read",name:"Read",status:state === "tool"?"running":"done"}] : [],streaming,error,usage,startedAt,progress,durationMs:streaming?null:4200}},
  sidechatBySession:{[key]:{open:true,engine:"claude",workspacePath:"C:/fixture",parentSessionId:"parent",sideSessionId:"side-fixture",runId:streaming?"sidechat-fixture":null,
    streaming,draft:"",messages:[message(1,"user","请核对旁聊 / Review the side answer 🙂"),
      ...(hasProcess ? [message(2,"thinking","核对中 / Reviewing 🧠",state === "tool"),message(3,"tool","Read",state === "tool")] : []),
      ...(hasAnswer ? [message(4,"assistant",streaming?"增量回复 / Streaming reply 🙂":answer,streaming)] : [])],error,usage,startedAt,progress}},
});
Object.assign(window,{__sidechatFixture:{key,draft,answer,getDraft:()=>useChatStore.getState().drafts[key]}});

function simulateActivity(complete: boolean) {
  useSidechatStore.setState((s) => ({
    btwBySession: { ...s.btwBySession, [key]: { ...s.btwBySession[key], streaming: !complete,
      progress: { phase: "thinking", lastEventAt: Date.now() }, thinking: "新的思考活动 / New thinking activity 🙂",
      ...(complete ? { answer, durationMs: Date.now() - startedAt } : {}),
    } },
    sidechatBySession: { ...s.sidechatBySession, [key]: { ...s.sidechatBySession[key], streaming: !complete,
      runId: complete ? null : "sidechat-fixture", progress: { phase: "thinking", lastEventAt: Date.now() },
      messages: [message(1,"user","请核对旁聊 / Review the side answer 🙂"), message(2, complete ? "assistant" : "thinking", complete ? answer : "新的思考活动 / New thinking activity 🙂", !complete)],
    } },
  }));
}

function Fixture() {
  const currentDraft = useChatStore(s=>s.drafts[key]);
  const open = useSidechatStore(s=>s.sidechatBySession[key]?.open);
  const [layoutWidth, setLayoutWidth] = useState("full");
  const [panelGeneration, setPanelGeneration] = useState(0);
  const [geometry, setGeometry] = useState("");
  const layoutRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const main = layout.querySelector<HTMLElement>('[data-testid="main"]')!;
    const panel = layout.querySelector<HTMLElement>("aside");
    const measure = () => setGeometry(JSON.stringify({
      container: Math.round(layout.getBoundingClientRect().width),
      main: Math.round(main.getBoundingClientRect().width),
      sidechat: Math.round(panel?.getBoundingClientRect().width ?? 0),
      overflow: layout.scrollWidth > layout.clientWidth,
    }));
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    observer.observe(main);
    if (panel) observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, [open, panelGeneration]);
  return <main className="flex min-h-dvh min-w-0 flex-col gap-3 bg-background-primary-default p-3 text-text-primary">
    <h1 className="text-body-medium">Sidechat fixture · {language} · {state}</h1>
    <div className="flex flex-wrap items-center gap-2 text-body-regular">
      <label>会话区宽度 / Conversation width <select aria-label="Conversation width" value={layoutWidth} onChange={event=>setLayoutWidth(event.target.value)}>
        <option value="full">Full</option><option value="900">900 px</option><option value="560">560 px split</option><option value="400">400 px split</option>
      </select></label>
      <button type="button" className="rounded border px-2 py-1" onClick={()=>void useSidechatStore.getState().openSidechat({sessionKey:key,engine:"claude",workspacePath:"C:/fixture",parentSessionId:"parent"})}>重新打开旁聊 / Reopen</button>
      <button type="button" className="rounded border px-2 py-1" onClick={()=>setPanelGeneration(value=>value+1)}>重挂载 / Remount</button>
      <button type="button" className="rounded border px-2 py-1" onClick={()=>simulateActivity(false)}>模拟新活动 / New activity</button>
      <button type="button" className="rounded border px-2 py-1" onClick={()=>simulateActivity(true)}>模拟完成 / Complete</button>
    </div>
    <output data-testid="geometry" className="break-all text-caption-1-regular">{geometry}</output>
    <div ref={layoutRef} data-testid="layout" style={{width:layoutWidth === "full" ? "100%" : `${layoutWidth}px`,maxWidth:"100%"}} className="flex h-[760px] min-w-0 overflow-hidden rounded-xl border border-border-button-default max-md:flex-col">
      <div data-testid="main" className="flex min-h-0 min-w-0 flex-1 flex-col justify-end gap-3 overflow-y-auto p-2">
        <BtwOverlayCard sessionKey={key}/>
        <label className="text-caption-1-medium">主输入框 / Main draft
          <textarea data-testid="main-draft" readOnly value={currentDraft} className="mt-1 h-20 w-full resize-none rounded-lg border border-border-button-default bg-background-primary-default p-2 text-body-regular"/>
        </label>
      </div>
      <SidechatPanel key={panelGeneration} active={null} sessionKey={key}/>
    </div>
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture/>);
