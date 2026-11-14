import { act, createRef, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerInputHandle, ComposerProps } from "@/components/application/ai-chat/ai-chat-composer";
import { extractText } from "@/components/application/ai-chat/file-tags";
import { ChatConversation } from "./ChatConversation";
import { useChatStore, sessionKey, type ActiveSession } from "../store";
import { EMPTY_SESSION } from "../store/stream";
import type { Message, Workspace } from "@/lib/ipc";
import { COMPOSER_DRAFT_TOPIC, pluginBus } from "@/features/plugins/runtime/events";
import { composerSlotRegistry } from "@ccgui/plugin-sdk";

const probe = vi.hoisted(() => ({ container: 0, composer: 0, status: 0, timeline: 0, questionReads: 0, planReads: 0 }));
vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(async () => undefined), listen: vi.fn(async () => () => {}), webToken: null }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => () => {} }));
vi.mock("@/components/application/ai-chat/cli-menu", () => ({ CliMenu: () => null }));
vi.mock("@/components/application/ai-chat/add-menu", () => ({ AddMenu: () => null }));
vi.mock("@/components/application/ai-chat/permission-menu", () => ({ PermissionMenu: () => null }));
vi.mock("./use-branch-switcher", () => ({ useBranchSwitcher: () => ({}) }));
vi.mock("./use-engine-models", () => ({ useEngineModels: () => { probe.container++; return { catalogs: {}, modelsByEngine: {}, channelsByEngine: {}, pendingEngines: {}, refresh: () => {} }; } }));
vi.mock("./MessageTimeline", () => ({ MessageTimeline: () => { probe.timeline++; return null; } }));
vi.mock("./RunStatusStrip", () => ({ RunStatusStrip: () => null }));
vi.mock("./CrossSessionQueue", () => ({ CrossSessionQueue: () => null }));
vi.mock("./CrossSessionCostApproval", () => ({ SessionSendCostApproval: () => null }));
vi.mock("./HandoffOverlayCard", () => ({ HandoffOverlayCard: () => null }));
vi.mock("@/features/sidechat/BtwOverlayCard", () => ({ BtwOverlayCard: () => null }));
vi.mock("@/features/sidechat/SidechatPanel", () => ({ SidechatPanel: () => null }));
vi.mock("@/features/sidechat/SidechatToggle", () => ({ SidechatToggle: () => null }));
vi.mock("@/features/assistant-notices/InlineAside", () => ({ InlineAside: () => null }));
vi.mock("./use-claude-quota", () => ({ useClaudeQuota: () => ({ enabled: false }) }));
vi.mock("./use-codex-quota", () => ({ useCodexQuota: () => ({ enabled: false }) }));
vi.mock("./use-agy-quota", () => ({ useAgyQuota: () => ({ enabled: false }) }));
vi.mock("./use-cursor-quota", () => ({ useCursorQuota: () => ({ enabled: false }) }));
vi.mock("./use-claude-context-window", () => ({ useClaudeContextWindow: () => ({ window: null, refresh: () => {}, save: () => {} }) }));
vi.mock("./use-codex-context-window", () => ({ useCodexContextWindow: () => ({ window: null, refresh: () => {}, save: () => {} }) }));
vi.mock("@/components/application/ai-chat/ai-chat-composer", async original => {
  const actual = await original<typeof import("@/components/application/ai-chat/ai-chat-composer")>();
  return { ...actual, Composer: (props: ComposerProps) => { probe.composer++; return <actual.Composer {...props} />; }, StatusBar: () => { probe.status++; return null; } };
});

const workspace: Workspace = { id: "input-perf", path: "G:/composer-input-perf", name: "Input fixture", lastOpenedAt: null, sortOrder: null, groupId: null };
const tab: ActiveSession = { engine: "codex", sessionId: "history-session", workspacePath: workspace.path };
const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
const original = useChatStore.getState();
let host: HTMLDivElement, root: Root;
const inputRef = createRef<ComposerInputHandle>();
const resetProbe = () => { for (const field of Object.keys(probe) as (keyof typeof probe)[]) probe[field] = 0; };
const editable = () => host.querySelector<HTMLElement>(".composer-editable")!;
function history(count: number): Message[] {
  return Array.from({ length: count }, (_, seq) => ({ seq, text: "大历史中文🙂 " + seq, ts: null,
    get role() { probe.questionReads++; return "assistant"; },
    get planReview() { probe.planReads++; return undefined; },
  }));
}
function render(active = useChatStore.getState().active) {
  return <ChatConversation active={active} engines={useChatStore.getState().engines} workspaces={[workspace]} startNewChat={useChatStore.getState().startNewChat} composerInputRef={inputRef} />;
}
async function input(text: string) {
  await act(async () => { editable().textContent = text; editable().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); });
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  useChatStore.setState({ ...original, initialized: true, active: tab, openTabs: [tab], activeEngine: "codex", workspaces: [workspace], sessions: [], drafts: { [key]: "" },
    bySession: { [key]: { ...EMPTY_SESSION, streaming: true, messages: history(20000) } }, streamingByKey: { [key]: true },
    engines: [{ id: "codex", enabled: true, available: true, supportsImages: true, permissions: ["manual"] }] });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(render())); resetProbe();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useChatStore.setState(original, true); vi.restoreAllMocks(); });

describe("composer input work stays local with 20,000 history rows", () => {
  it("keeps per-key draft updates synchronous without container/status rerenders or repeated pending-row scans", async () => {
    const changes: string[] = [];
    const off = pluginBus.on(COMPOSER_DRAFT_TOPIC, data => changes.push((data as { text: string }).text));
    try {
      let value = "";
      for (const character of "逐键输入中文🙂abcdef0123456789") {
        value += character; await input(value);
        expect(useChatStore.getState().drafts[key]).toBe(value); expect(extractText(editable())).toBe(value);
      }
      expect(changes.at(-1)).toBe(value);
      expect(probe.container).toBe(0);
      expect(probe.status).toBe(0);
      expect(probe.timeline).toBe(0);
      expect(probe.questionReads).toBe(0);
      expect(probe.planReads).toBe(0);
      expect(probe.composer).toBe(23);
    } finally { off(); }
  });

  it("preserves IME text and submits the latest DOM text immediately without clearing subsequent input", async () => {
    const send = vi.fn(async () => {});
    await act(async () => useChatStore.setState({ sendWhileBusy: send }));
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    await act(async () => editable().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await input("中文候选👩🏽‍💻");
    await act(async () => editable().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })));
    expect(send).not.toHaveBeenCalled();
    await act(async () => editable().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文候选👩🏽‍💻" })));
    await act(async () => editable().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(send).not.toHaveBeenCalled(); // The candidate-commit Enter is not a send.
    expect(useChatStore.getState().drafts[key]).toBe("中文候选👩🏽‍💻");
    now.mockReturnValue(1101);
    await act(async () => {
      // No timer or debounce interval between the final input and submission.
      editable().textContent = "中文已确认👩🏽‍💻\n立即发送";
      editable().dispatchEvent(new InputEvent("input", { bubbles: true }));
      editable().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      editable().textContent = "下一条不丢🙂";
      editable().dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    expect(send).toHaveBeenCalledExactlyOnceWith("中文已确认👩🏽‍💻\n立即发送", [], undefined, tab);
    expect(useChatStore.getState().drafts[key]).toBe("下一条不丢🙂");
    expect(extractText(editable())).toBe("下一条不丢🙂");
  });

  it("restores each session's draft and plugin edits without leaking input across tabs", async () => {
    const other = { ...tab, sessionId: "other-session" };
    const otherKey = sessionKey(other.engine, other.sessionId, other.workspacePath);
    const events: string[] = [];
    const off = pluginBus.on(COMPOSER_DRAFT_TOPIC, data => events.push((data as { text: string }).text));
    try {
      await input("原会话中文🌏");
      await act(async () => {
        useChatStore.setState({ active: other, openTabs: [tab, other],
          drafts: { ...useChatStore.getState().drafts, [otherKey]: "另一个草稿" },
          bySession: { ...useChatStore.getState().bySession, [otherKey]: { ...EMPTY_SESSION, messages: history(20000) } } });
        root.render(render(other));
      });
      expect(extractText(editable())).toBe("另一个草稿");
      await input("另一个草稿👩🏽‍💻");
      expect(useChatStore.getState().drafts[key]).toBe("原会话中文🌏");
      await act(async () => { useChatStore.setState({ active: tab }); root.render(render(tab)); });
      expect(extractText(editable())).toBe("原会话中文🌏");
      await act(async () => useChatStore.getState().setDraft(key, "插件预填\n保留🙂"));
      expect(extractText(editable())).toBe("插件预填\n保留🙂");
      expect(useChatStore.getState().drafts[otherKey]).toBe("另一个草稿👩🏽‍💻");
      expect(events).toEqual(["原会话中文🌏", "另一个草稿", "另一个草稿👩🏽‍💻", "原会话中文🌏", "插件预填\n保留🙂"]);
    } finally { off(); }
  });

  it("updates pending-question ownership and emits plugin draft changes while the editor is replaced", async () => {
    const question: Message = { seq: 20001, role: "question", text: "等待确认", ts: null,
      question: { requestId: "question", runId: "run", questions: [], status: "pending" } };
    const events: string[] = [];
    const off = pluginBus.on(COMPOSER_DRAFT_TOPIC, data => events.push((data as { text: string }).text));
    const updateQuestion = async (message: Message) => act(async () => useChatStore.setState(s => ({ bySession: {
      ...s.bySession, [key]: { ...s.bySession[key], messages: [...s.bySession[key].messages.filter(row => row.seq !== 20001), message] },
    } })));
    try {
      await updateQuestion(question);
      expect(editable()).toBeNull();
      await act(async () => useChatStore.getState().setDraft(key, "等待期间插件保留草稿🙂"));
      expect(events.at(-1)).toBe("等待期间插件保留草稿🙂");
      await updateQuestion({ ...question, question: { ...question.question!, status: "answered" } });
      expect(extractText(editable())).toBe("等待期间插件保留草稿🙂");
    } finally { off(); }
  });

  it("publishes the initial draft after plugin composer-slot listeners mount", async () => {
    await act(async () => root.render(null));
    const events: string[] = [];
    function PluginSlot() {
      useEffect(() => pluginBus.on(COMPOSER_DRAFT_TOPIC, data => events.push((data as { text: string }).text)), []);
      return null;
    }
    const off = composerSlotRegistry.register({ id: "plugin:input-fixture:listen", slot: "addMenu", component: PluginSlot });
    try {
      useChatStore.getState().setDraft(key, "挂载前保存的中文🙂");
      await act(async () => root.render(render()));
      expect(events).toEqual(["挂载前保存的中文🙂"]);
      await input("挂载后继续输入👩🏽‍💻");
      expect(events.at(-1)).toBe("挂载后继续输入👩🏽‍💻");
    } finally { await act(async () => off()); }
  });
});
