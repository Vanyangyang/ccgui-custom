import React from 'react';
import { createRoot } from 'react-dom/client';
import activate from '../../../ccgui-plugin/ccgui-plugin-plan-execute-relay/main.js';
import '../../src/index.css';
import '../../../ccgui-plugin/ccgui-plugin-plan-execute-relay/styles.css';

let Conversation;
let callback;
let count = 0;
let sequence = 0;
const storage = new Map();
const pending = new Map();
const ctx = {
  pluginId: 'plan-execute-relay',
  react: React,
  i18n: { addBundle() {} },
  ui: { registerConversationMode(definition) { Conversation = definition.component; } },
  storage: { get: async key => storage.get(key) ?? null, set: async (key, value) => storage.set(key, structuredClone(value)) },
  events: { on: (_topic, listener) => { callback = listener; return () => { callback = null; }; } },
  agent: {
    catalog: async () => ['codex', 'pi'].map(engine => ({ engine, label:engine, available:true, readOnly:true, providers:[{ id:'fixture', label:'UI 回放渠道 · 非真实连接' }], models:[{ id:engine === 'codex' ? 'planning-fixture' : 'execution-fixture', label:'测试模型' }] })),
    start: async request => {
      const runId = `pa-plan-execute-relay-${request.requestId}`;
      count += 1;
      document.getElementById('requests').textContent = `${count} fake requests · ${request.readOnly ? 'read-only planner' : 'executor'}`;
      const plan = { goal:'设置页搜索', steps:['阅读现有设置入口', '实现名称与描述匹配并保留分组', `整合第 ${count} 轮用户补充并补齐回归`], constraints:['不新增依赖','保留用户已有改动'], acceptance:['中文与英文匹配正确','清空后恢复全部设置'], questions:[] };
      const text = request.readOnly ? `已完善计划。继续讨论或确认此版。\n<ccgui-plan>${JSON.stringify(plan)}</ccgui-plan>` : '执行传输回放已结束。没有修改文件，没有运行真实 CLI。';
      const timer = setTimeout(async () => {
        pending.delete(runId);
        await callback?.({ runId, sessionId:`fixture-session-${count}`, seq:++sequence, kind:'delta', data:text });
        await callback?.({ runId, sessionId:`fixture-session-${count}`, seq:++sequence, kind:'done', data:{} });
      }, 400);
      pending.set(runId, timer);
      return { runId, sessionId:`fixture-session-${count}` };
    },
    interrupt: async runId => {
      if (!pending.has(runId)) return false;
      clearTimeout(pending.get(runId)); pending.delete(runId);
      queueMicrotask(() => callback?.({ runId, sessionId:null, seq:++sequence, kind:'done', data:{} }));
      return true;
    },
  },
};
const cleanup = activate(ctx);
function Fixture() {
  const [visible, setVisible] = React.useState(true);
  return <main style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
    <header style={{padding:'8px 16px',background:'#fff4d9',color:'#77551a',fontSize:12}}>真实插件 React UI / 模拟传输，无模型费用、无文件操作 <span id="requests">0 fake requests</span></header>
    {visible ? <Conversation conversationId="fixture" workspacePath="/fixture" language="zh" onExit={() => setVisible(false)} /> : <button onClick={() => setVisible(true)}>回到接力</button>}
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
window.addEventListener('pagehide', cleanup);
