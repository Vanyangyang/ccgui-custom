import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/lib/i18n";
import { ConversationSurface } from "@/features/plugins/runtime/ConversationSurface";

const longText = "中文👩🏽‍💻完整原文 **粗体**\n\n".repeat(160) + "| 项目 | 内容 |\n| --- | --- |\n| 最后 | 完整✅ |\n\n```js\nconst text = '末尾😀';\n```";
const rows = Array.from({ length: 1200 }, (_, seq) => ({ seq, role: seq % 3 === 0 ? "tool" : "user", text: seq % 3 === 0 ? `Read-${seq}` : `历史-${seq}-中文😀`,
  ...(seq % 3 === 0 ? { args: { path: `source-${seq}.ts` }, result: `完整工具结果-${seq}👩🏽‍💻\n第二行` } : {}) }));
rows[600] = { seq: 600, role: "assistant", text: longText };
const pending = { seq: 100, role: "question", text: "", question: { status: "pending", runId: "native-run", requestId: "native-question", questions: [
  { header: "Choice", question: "选择项目？", options: [{ label: "Project A", description: "A" }, { label: "Project B", description: "B" }], multiSelect: false },
] } };
const fixture = { update: (_text: string, _live = true) => {}, switchSource: (_id: string) => {}, append: () => {}, threshold: (_count: number) => {}, prefix: (_visible: boolean) => {}, identity: (_field: string, _value: string) => {}, actions: [] as unknown[], longText, copied: "" };
Object.assign(window, { conversationFixture: fixture });
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { fixture.copied = text; } } });

function Harness() {
  const [text, setText] = useState("流式开头😀");
  const [live, setLive] = useState(true);
  const [id, setId] = useState("source-a");
  const [extra, setExtra] = useState(0);
  const [count, setCount] = useState<number | null>(null);
  const [prefix, setPrefix] = useState(true);
  const [standalone, setStandalone] = useState<{ threadId: string; sessionRef: { engine: string; sessionId: string; workspacePath: string } } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(false);
  fixture.update = (next, active = true) => { setText(next); setLive(active); };
  fixture.switchSource = setId;
  fixture.append = () => setExtra(value => value + 1);
  fixture.threshold = setCount;
  fixture.prefix = setPrefix;
  fixture.identity = (field, value) => setStandalone(previous => {
    const base = previous ?? { threadId: "thread-a", sessionRef: { engine: "codex", sessionId: "native-a", workspacePath: "G:/project" } };
    return field === "threadId" ? { ...base, threadId: value } : { ...base, sessionRef: { ...base.sessionRef, [field]: value } };
  });
  // Match the installed workbench's parent-owned follow behavior.
  useLayoutEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [text, live, extra]);
  const messages = [...rows.slice(0, 100), pending, ...rows.slice(101), { seq: 1200, role: "assistant", text, live },
    ...Array.from({ length: extra }, (_, index) => ({ seq: 1201 + index, role: "user", text: `新增-${index}✅` }))];
  const projectedMessages = count === null ? messages : [pending, ...rows.slice(0, count - 1)];
  const projection = standalone ? { ...standalone, requestId: "standalone-owner", revision: 4, messages: projectedMessages }
    : { sources: [{ id, conversation: { requestId: id, revision: 4, messages: projectedMessages } }] };
  return <main style={{ width: "min(760px, 100%)", margin: "20px auto" }}>
    <div id="viewport" ref={scroll} tabIndex={0} style={{ height: 440, overflowY: "auto", border: "1px solid gray", padding: 12 }}
      onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.clientHeight - node.scrollTop < 48; }}>
      {prefix && <details id="prefix"><summary>前置交接摘要</summary><div style={{ height: 180 }}>摘要内容</div></details>}
      <ConversationSurface conversation={projection} onAction={action => fixture.actions.push(action)} />
      <p id="suffix">外层末尾状态</p>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
